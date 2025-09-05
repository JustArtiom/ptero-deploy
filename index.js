const core = require("@actions/core");
const axios = require("axios");
const WebSocket = require("ws");

const fs = require("fs");
const path = require("path");
const os = require("os");
const FormData = require("form-data");
const archiver = require("archiver");

function normaliseUrl(u) {
  return u.replace(/\/+$/, "");
}

function originFromUrl(u) {
  try {
    return new URL(u).origin;
  } catch {
    const m = String(u).match(/^(https?:\/\/[^/]+)/i);
    return m ? m[1] : u;
  }
}

function normalisePanelPath(p) {
  if (!p || typeof p !== "string") return "/";
  // convert backslashes to forward slashes and trim whitespace
  let v = p.replace(/\\+/g, "/").trim();
  // remove leading './'
  v = v.replace(/^\.\//, "");
  // ensure leading '/'
  if (v === "" || v === "/") return "/";
  if (!v.startsWith("/")) v = "/" + v;
  // drop trailing slashes (except root)
  v = v.replace(/\/+$/, "");
  return v || "/";
}

const url = normaliseUrl(core.getInput("url", { required: true }));
const apiKey = core.getInput("api_key", { required: true });
const serverId = core.getInput("server_id", { required: true });
const runInput = core.getInput("run") || "";
const cleanInput = (core.getInput("clean") || "false").toString().trim().toLowerCase();
const clean = cleanInput === "true" || cleanInput === "1" || cleanInput === "yes";

core.setSecret(apiKey);

const workspaceEnv = process.env.GITHUB_WORKSPACE || process.cwd();
const basePathInput = core.getInput("base_path") || ""; // relative to workspace
const destinationPathInput = core.getInput("destination_path") || "/";

const sourceRoot = path.resolve(workspaceEnv, basePathInput || ".");
if (!fs.existsSync(sourceRoot)) {
  throw new Error(`Base path does not exist: ${sourceRoot}`);
}
const destinationDir = normalisePanelPath(destinationPathInput);

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

async function getSignedUploadUrl(directory = "/") {
  const endpoint = `${url}/api/client/servers/${serverId}/files/upload`;
  const { data } = await axios.get(endpoint, {
    params: { directory },
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
  });
  return data?.attributes?.url || data?.url;
}

async function uploadFileToSignedUrl(signedUrl, filePath, filename) {
  const form = new FormData();
  form.append("files", fs.createReadStream(filePath), filename);

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

async function listDirectory(root = "/") {
  const endpoint = `${url}/api/client/servers/${serverId}/files/list`;
  const { data } = await axios.get(endpoint, {
    params: { directory: root },
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
  });
  const items = (data?.data || data || []).map((entry) => {
    const attr = entry?.attributes || entry;
    const isFile = attr?.is_file === true || attr?.isFile === true;
    const isDir = attr?.is_directory === true || attr?.is_dir === true || (attr?.isFile === false && attr?.is_file !== true);
    return {
      name: attr?.name,
      isFile,
      isDir,
    };
  });
  return items;
}

async function cleanServerRoot(root = "/") {
  core.info(`Cleaning server files at ${root} ...`);
  const items = await listDirectory(root);
  if (!items || items.length === 0) {
    core.info("Nothing to clean.");
    return;
  }

  const filesToDelete = items.filter(i => i.isFile && i.name).map(i => i.name);
  if (filesToDelete.length) {
    await deleteServerFiles(filesToDelete, root);
    core.info(`Deleted ${filesToDelete.length} file(s) in ${root}`);
  }

  const dirs = items.filter(i => i.isDir && i.name).map(i => i.name);
  for (const dirName of dirs) {
    const childRoot = path.posix.join(root === "/" ? "/" : root, dirName);
    await cleanServerRoot(childRoot);
    // delete the (now empty) directory; some panels require trailing slash to denote directories
    await deleteServerFiles([`${dirName}/`], root);
    core.info(`Deleted directory ${childRoot}`);
  }
}

async function getWebsocketDetails() {
  const endpoint = `${url}/api/client/servers/${serverId}/websocket`;
  const { data } = await axios.get(endpoint, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
  });
  const token =
    data?.data?.token ||
    data?.attributes?.token ||
    data?.token;
  const socketUrl =
    data?.data?.socket ||
    data?.attributes?.socket ||
    data?.socket;
  if (!token || !socketUrl) {
    throw new Error("Failed to get websocket details from panel");
  }
  return { token, socketUrl };
}

async function getCurrentStatus() {
  const endpoint = `${url}/api/client/servers/${serverId}/resources`;
  const { data } = await axios.get(endpoint, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
  });
  return (
    data?.attributes?.current_state ||
    data?.attributes?.current_status ||
    data?.current_state ||
    data?.current_status ||
    null
  );
}

async function waitForStatus(desired, timeoutMs = 60000) {
  try {
    const now = await getCurrentStatus();
    if (now && now.toLowerCase() === desired.toLowerCase()) {
      core.info(`Server already in desired state: ${desired}`);
      return;
    }
  } catch (e) {
  }

  const { token, socketUrl } = await getWebsocketDetails();
  core.info(`Connecting to websocket to wait for state: ${desired}`);
  const ws = new WebSocket(socketUrl, {
    perMessageDeflate: false,
    headers: {
      Origin: originFromUrl(url),
      "User-Agent": "ptero-deploy-action/1 (+github-actions)",
      Accept: "*/*",
    },
  });

  let done = false;
  let timeout;

  const cleanup = () => {
    if (timeout) clearTimeout(timeout);
    try { ws.close(); } catch {}
  };

  const result = await new Promise((resolve, reject) => {
    timeout = setTimeout(() => {
      if (!done) {
        done = true;
        cleanup();
        reject(new Error(`Timed out waiting for state "${desired}"`));
      }
    }, timeoutMs);

    ws.on("open", () => {
      // Authenticate
      ws.send(JSON.stringify({ event: "auth", args: [token] }));
    });

    ws.on("message", async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        const ev = msg?.event;
        const arg0 = Array.isArray(msg?.args) ? msg.args[0] : undefined;

        if (ev === "auth success") {
          try {
            const current = await getCurrentStatus();
            if (current && current.toLowerCase() === desired.toLowerCase()) {
              if (!done) {
                done = true;
                cleanup();
                return resolve();
              }
            }
          } catch {}
        }

        if (ev === "status" && typeof arg0 === "string") {
          const state = arg0.toLowerCase();
          core.info(`Status event: ${state}`);
          if (state === desired.toLowerCase() && !done) {
            done = true;
            cleanup();
            return resolve();
          }
        }

        if (ev === "token expiring") {
          ws.send(JSON.stringify({ event: "auth", args: [token] }));
        }
      } catch (e) {
      }
    });

    ws.on("error", (err) => {
      if (!done) {
        const statusCode = err && (err.statusCode || err.code);
        core.info(`Websocket error${statusCode ? " (" + statusCode + ")" : ""}: ${err.message || err}`);
        cleanup();
        (async () => {
          try {
            const started = Date.now();
            while (Date.now() - started < timeoutMs) {
              const st = await getCurrentStatus();
              if (st && st.toLowerCase() === desired.toLowerCase()) {
                return resolve();
              }
              await new Promise(r => setTimeout(r, 1000));
            }
            reject(new Error(`Timed out waiting for state "${desired}" (fallback polling after websocket error)`));
          } catch (e) {
            reject(e);
          }
        })();
      }
    });

    ws.on("close", () => {
      if (!done) {
        core.info("Websocket closed, falling back to REST polling...");
        (async () => {
          try {
            const started = Date.now();
            while (Date.now() - started < timeoutMs) {
              const st = await getCurrentStatus();
              if (st && st.toLowerCase() === desired.toLowerCase()) {
                if (!done) {
                  done = true;
                  cleanup();
                  return resolve();
                }
              }
              await new Promise(r => setTimeout(r, 1000));
            }
            if (!done) {
              done = true;
              cleanup();
              reject(new Error(`Timed out waiting for state "${desired}" after websocket closed`));
            }
          } catch (e) {
            if (!done) {
              done = true;
              cleanup();
              reject(e);
            }
          }
        })();
      }
    });
  });

  return result;
}

async function sendPower(state) {
  const endpoint = `${url}/api/client/servers/${serverId}/power`;
  core.info(`Sending power action: ${state}`);
  await axios.post(
    endpoint,
    { signal: state },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    }
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendCommands(runBlock) {
  const endpoint = `${url}/api/client/servers/${serverId}/command`;
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
    await new Promise(res => setTimeout(res, 500));
  }
  core.info("All commands sent ✅");
}

(async () => {
  try {
    await sendPower("kill");
    await waitForStatus("offline", 30000);

    if (clean) {
      await cleanServerRoot(destinationDir);
    }

    core.info(`Zipping source at: ${sourceRoot}`);
    core.info(`Destination path on server: ${destinationDir}`);
    const { outPath, archiveName } = await zipWorkspace(sourceRoot);

    core.info("Requesting signed upload URL from panel...");
    const signedUrl = await getSignedUploadUrl(destinationDir);

    core.info(`Uploading ${archiveName} to ${destinationDir} ...`);
    await uploadFileToSignedUrl(signedUrl, outPath, archiveName);

    core.info("Decompressing archive on the server...");
    await decompressOnServer(archiveName, destinationDir);

    core.info("Cleaning up uploaded archive on the server...");
    await deleteServerFiles([archiveName], destinationDir);

    await sendPower("start");
    await waitForStatus("running", 60000);
    await sleep(2000);

    if (runInput && runInput.trim()) {
      core.info("Executing post-deploy commands...");
      await sendCommands(runInput);
    }

    core.info("Deploy sequence complete ✅");
  } catch (err) {
    core.setFailed(err?.message || String(err));
  }
})();