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

async function getWebsocketDetails() {
  const endpoint = `${url}/api/client/servers/${serverId}/websocket`;
  const { data } = await axios.get(endpoint, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
  });
  // Support both {data:{token}, socket} and {attributes:{token, socket}}
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
  // v1 returns data.attributes.current_state or current_status
  return (
    data?.attributes?.current_state ||
    data?.attributes?.current_status ||
    data?.current_state ||
    data?.current_status ||
    null
  );
}

async function waitForStatus(desired, timeoutMs = 60000) {
  // First quick check via REST in case we're already there
  try {
    const now = await getCurrentStatus();
    if (now && now.toLowerCase() === desired.toLowerCase()) {
      core.info(`Server already in desired state: ${desired}`);
      return;
    }
  } catch (e) {
    // ignore and proceed to websocket
  }

  const { token, socketUrl } = await getWebsocketDetails();
  core.info(`Connecting to websocket to wait for state: ${desired}`);
  const ws = new WebSocket(socketUrl);

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
          // After auth, status events will arrive on change.
          // Kick off a quick REST check too in case status is already desired.
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

        // Token refresh handling (optional)
        if (ev === "token expiring") {
          // Re-auth with same token (panel usually sends a new token via "token expired" flow)
          ws.send(JSON.stringify({ event: "auth", args: [token] }));
        }
      } catch (e) {
        // ignore parse errors
      }
    });

    ws.on("error", (err) => {
      if (!done) {
        done = true;
        cleanup();
        reject(err);
      }
    });

    ws.on("close", () => {
      if (!done) {
        // Fallback to periodic REST polling if ws closes unexpectedly
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
    await sendPower("kill");
    await waitForStatus("offline", 30000);

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

    await sendPower("start");
    await waitForStatus("running", 60000);

    if (runInput && runInput.trim()) {
      core.info("Executing post-deploy commands...");
      await sendCommands(runInput);
    }

    core.info("Upload + extract complete ✅");
  } catch (err) {
    core.setFailed(err?.message || String(err));
  }
})();