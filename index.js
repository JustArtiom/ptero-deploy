const core = require("@actions/core");
const axios = require("axios");

const fs = require("fs");
const path = require("path");
const os = require("os");
const FormData = require("form-data");
const archiver = require("archiver");

function normaliseUrl(u) {
  return u.replace(/\/+$/, "");
}

const url = normaliseUrl(core.getInput("url", { required: true }));
const apiKey = core.getInput("api_key", { required: true });
const serverId = core.getInput("server_id", { required: true });
const runInput = core.getInput("run") || "";

core.setSecret(apiKey);

const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
const destinationDir = "/";

async function zipWorkspace(rootDir) {
  return new Promise((resolve, reject) => {
    const archiveName = `ci-upload-${Date.now()}.zip`;
    const outPath = path.join(os.tmpdir(), archiveName);
    const output = fs.createWriteStream(outPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", () => resolve({ outPath, archiveName }));
    archive.on("error", (err) => reject(err));

    archive.pipe(output);

    archive.glob("**/*", {
      cwd: rootDir,
      dot: true,
      ignore: [
        ".git/**",
        ".github/**",
        "node_modules/**",
        "**/.DS_Store",
        "**/*.log",
        "**/.gitignore",
        "**/.gitattributes",
      ],
    });

    archive.finalize();
  });
}

async function getSignedUploadUrl() {
  const endpoint = `${url}/api/client/servers/${serverId}/files/upload`;
  const { data } = await axios.get(endpoint, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
  });
  return data?.attributes?.url || data?.url;
}

async function uploadFileToSignedUrl(signedUrl, filePath, filename, directory = "/") {
  const form = new FormData();
  form.append("files", fs.createReadStream(filePath), filename);
  form.append("directory", directory);

  await axios.post(signedUrl, form, {
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    headers: form.getHeaders(),
  });
}

async function decompressOnServer(archiveName, root = "/") {
  const endpoint = `${url}/api/client/servers/${serverId}/files/decompress`;
  await axios.post(
    endpoint,
    { root, file: archiveName },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    }
  );
}

async function deleteServerFiles(files, root = "/") {
  const endpoint = `${url}/api/client/servers/${serverId}/files/delete`;
  await axios.post(
    endpoint,
    { root, files },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    }
  );
}

async function sendCommands(runBlock) {
  const endpoint = `${url}/api/client/servers/${serverId}/command`;
  // Split by newline, trim, drop empties, and strip wrapping quotes
  const lines = runBlock
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => {
      const m1 = l.match(/^"(.*)"$/);
      const m2 = l.match(/^'(.*)'$/);
      return m1 ? m1[1] : (m2 ? m2[1] : l);
    });

  for (const cmd of lines) {
    core.info(`Sending command: ${cmd}`);
    await axios.post(
      endpoint,
      { command: cmd },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
      }
    );
    // Small delay to avoid flooding the API/console
    await new Promise(res => setTimeout(res, 500));
  }
  core.info("All commands sent ✅");
}

(async () => {
  try {
    core.info(`Zipping workspace at: ${workspace}`);
    const { outPath, archiveName } = await zipWorkspace(workspace);

    core.info("Requesting signed upload URL from panel...");
    const signedUrl = await getSignedUploadUrl();

    core.info(`Uploading ${archiveName} to ${destinationDir} ...`);
    await uploadFileToSignedUrl(signedUrl, outPath, archiveName, destinationDir);

    core.info("Decompressing archive on the server...");
    await decompressOnServer(archiveName, destinationDir);

    core.info("Cleaning up uploaded archive on the server...");
    await deleteServerFiles([archiveName], destinationDir);

    if (runInput && runInput.trim()) {
      core.info("Executing post-deploy commands...");
      await sendCommands(runInput);
    }

    core.info("Upload + extract complete ✅");
  } catch (err) {
    core.setFailed(err?.message || String(err));
  }
})();