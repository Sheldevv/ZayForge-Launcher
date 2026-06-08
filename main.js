const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const https = require("https");
const { exec, spawn, fork } = require("child_process");
const os = require("os");

let mainWindow;
let lovePath = null;
let gamePath = null;
let currentRelease = null;
let apiServer = null;

const ZK_API = "http://localhost:3131/api";

// Disable GPU features to prevent VAAPI errors on Linux
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-software-rasterizer");

// ────────────────────────────────────────────────────────
//  Session Storage (token + user profile)
// ────────────────────────────────────────────────────────

function getSessionPath() {
  return path.join(app.getPath("userData"), "session.json");
}

function loadSession() {
  try {
    const filePath = getSessionPath();
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf-8");
      const session = JSON.parse(raw);
      if (session && session.token) return session;
    }
  } catch (e) {
    console.error("Failed to load session:", e.message);
  }
  return null;
}

function saveSession(token, user) {
  try {
    const data = { token, user, savedAt: new Date().toISOString() };
    fs.writeFileSync(getSessionPath(), JSON.stringify(data, null, 2), "utf-8");
  } catch (e) {
    console.error("Failed to save session:", e.message);
  }
}

function clearSession() {
  try {
    const filePath = getSessionPath();
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {
    console.error("Failed to clear session:", e.message);
  }
}

// ────────────────────────────────────────────────────────
//  Generic API helper (uses native https module)
// ────────────────────────────────────────────────────────

function apiRequest(method, endpoint, token, body, contentType) {
  return new Promise((resolve, reject) => {
    const url = new URL(ZK_API + endpoint);
    const isHttps = url.protocol === "https:";
    const httpModule = isHttps ? https : require("http");

    const headers = {
      "User-Agent": "ZayForge-Launcher/1.0.0",
      Accept: "application/json",
    };

    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    let bodyBuffer = null;
    if (body !== undefined && body !== null) {
      if (Buffer.isBuffer(body)) {
        bodyBuffer = body;
        headers["Content-Type"] = contentType || "application/octet-stream";
        headers["Content-Length"] = bodyBuffer.length;
      } else {
        const json = JSON.stringify(body);
        bodyBuffer = Buffer.from(json, "utf-8");
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = bodyBuffer.length;
      }
    }

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: method,
      headers: headers,
    };

    const req = httpModule.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode, body: json });
        } catch (e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on("error", (err) => reject(err));
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });

    if (bodyBuffer) {
      req.write(bodyBuffer);
    }
    req.end();
  });
}

// ────────────────────────────────────────────────────────
//  IPC Handlers – Account & Auth
// ────────────────────────────────────────────────────────

ipcMain.handle("get-session", async () => {
  const session = loadSession();
  if (session) {
    // Verify token is still valid by hitting /auth/me
    try {
      const res = await apiRequest("GET", "/auth/me", session.token);
      if (res.status === 200 && res.body.ok) {
        // Update stored user with fresh data
        saveSession(session.token, res.body.user);
        return { loggedIn: true, user: res.body.user, token: session.token };
      }
    } catch (e) {
      // Network error – use cached session but flag as stale
      return {
        loggedIn: true,
        user: session.user,
        token: session.token,
        stale: true,
      };
    }
    // Token invalid – clear it
    clearSession();
  }
  return { loggedIn: false, user: null, token: null };
});

ipcMain.handle("auth-login", async (event, email, password) => {
  try {
    const res = await apiRequest("POST", "/auth/login", null, {
      email,
      password,
    });
    if (res.status === 200 && res.body.ok) {
      saveSession(res.body.token, res.body.user);
      return { success: true, user: res.body.user, token: res.body.token };
    }
    return {
      success: false,
      error: res.body.error || "Login failed",
      status: res.status,
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle("auth-register", async (event, username, email, password) => {
  try {
    const res = await apiRequest("POST", "/auth/register", null, {
      username,
      email,
      password,
    });
    if (res.status === 200 && res.body.ok) {
      saveSession(res.body.token, res.body.user);
      return { success: true, user: res.body.user, token: res.body.token };
    }
    return {
      success: false,
      error: res.body.error || "Registration failed",
      status: res.status,
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle("auth-logout", async () => {
  clearSession();
  return { success: true };
});

ipcMain.handle("auth-me", async (event, token) => {
  try {
    const res = await apiRequest("GET", "/auth/me", token);
    if (res.status === 200 && res.body.ok) {
      saveSession(token, res.body.user);
      return { success: true, user: res.body.user };
    }
    return {
      success: false,
      error: res.body.error || "Failed to fetch profile",
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle("auth-update-username", async (event, token, username) => {
  try {
    const res = await apiRequest("PATCH", "/auth/me", token, { username });
    if (res.status === 200 && res.body.ok) {
      saveSession(token, res.body.user);
      return { success: true, user: res.body.user };
    }
    return {
      success: false,
      error: res.body.error || "Failed to update username",
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle("auth-upload-avatar", async (event, token, filePath) => {
  try {
    const buffer = fs.readFileSync(filePath);
    const res = await apiRequest(
      "POST",
      "/auth/me/avatar",
      token,
      buffer,
      "image/png",
    );
    if (res.status === 200 && res.body.ok) {
      saveSession(token, res.body.user);
      return { success: true, user: res.body.user };
    }
    return {
      success: false,
      error: res.body.error || "Failed to upload avatar",
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle("auth-upload-avatar-buffer", async (event, token, buffer) => {
  try {
    const res = await apiRequest(
      "POST",
      "/auth/me/avatar",
      token,
      Buffer.from(buffer),
      "image/png",
    );
    if (res.status === 200 && res.body.ok) {
      saveSession(token, res.body.user);
      return { success: true, user: res.body.user };
    }
    return {
      success: false,
      error: res.body.error || "Failed to upload avatar",
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle("auth-delete-avatar", async (event, token) => {
  try {
    const res = await apiRequest("DELETE", "/auth/me/avatar", token);
    if (res.status === 200 && res.body.ok) {
      saveSession(token, res.body.user);
      return { success: true, user: res.body.user };
    }
    return {
      success: false,
      error: res.body.error || "Failed to remove avatar",
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle("auth-delete-account", async (event, token) => {
  try {
    const res = await apiRequest("DELETE", "/auth/me", token);
    if (res.status === 200 && res.body.ok) {
      clearSession();
      return { success: true };
    }
    return {
      success: false,
      error: res.body.error || "Failed to delete account",
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle("api-ping", async () => {
  try {
    const res = await apiRequest("GET", "/ping", null);
    return { success: true, data: res.body };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ────────────────────────────────────────────────────────
//  IPC Handlers – Game (existing + modified)
// ────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 720,
    backgroundColor: "#0a0a12",
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true,
    },
    frame: true,
    title: "ZayForge Launcher",
    icon: path.join(__dirname, "assets", "icon.png"),
    show: false,
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.setMenu(null);

  mainWindow.loadFile("index.html");

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });
}

async function getLatestRelease(includePreReleases = false) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.github.com",
      path: "/repos/Sheldevv/ZayForge/releases",
      method: "GET",
      headers: {
        "User-Agent": "ZayForge-Launcher/1.0.0",
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const releases = JSON.parse(data);
          if (!Array.isArray(releases)) {
            reject(new Error("Failed to fetch releases"));
            return;
          }

          if (releases.length === 0) {
            reject(new Error("No releases found"));
            return;
          }

          let targetRelease = null;
          if (includePreReleases) {
            targetRelease = releases[0];
          } else {
            targetRelease = releases.find((r) => !r.prerelease);
            if (!targetRelease && releases.length > 0) {
              targetRelease = releases[0];
            }
          }

          if (!targetRelease) {
            reject(new Error("No suitable release found"));
            return;
          }

          const loveAsset = targetRelease.assets.find(
            (a) => a.name === "ZayForge-all.love",
          );
          if (!loveAsset) {
            reject(new Error("ZayForge-all.love not found in release"));
            return;
          }

          resolve({
            version: targetRelease.tag_name,
            isPreRelease: targetRelease.prerelease,
            downloadUrl: loveAsset.browser_download_url,
            releaseDate: targetRelease.published_at,
            releaseNotes: targetRelease.body,
            assetSize: loveAsset.size,
          });
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on("error", reject);
    req.end();
  });
}

async function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    let receivedBytes = 0;

    const followRedirect = (currentUrl) => {
      const request = https.get(
        currentUrl,
        {
          headers: {
            "User-Agent": "ZayForge-Launcher/1.0.0",
          },
        },
        (response) => {
          if (
            response.statusCode === 301 ||
            response.statusCode === 302 ||
            response.statusCode === 303 ||
            response.statusCode === 307 ||
            response.statusCode === 308
          ) {
            const redirectUrl = response.headers.location;
            if (redirectUrl) {
              console.log(`Following redirect to: ${redirectUrl}`);
              followRedirect(redirectUrl);
              return;
            }
          }

          if (response.statusCode !== 200) {
            reject(new Error(`HTTP ${response.statusCode}`));
            return;
          }

          const totalBytes = parseInt(response.headers["content-length"], 10);

          response.on("data", (chunk) => {
            receivedBytes += chunk.length;
            if (onProgress && totalBytes) {
              onProgress((receivedBytes / totalBytes) * 100);
            }
          });

          response.pipe(file);

          file.on("finish", () => {
            file.close();
            resolve();
          });

          file.on("error", reject);
        },
      );

      request.on("error", reject);
      request.setTimeout(30000, () => {
        request.destroy();
        reject(new Error("Download timeout"));
      });
    };

    followRedirect(url);
  });
}

function getLove2DRuntime() {
  const platform = os.platform();
  const userData = app.getPath("userData");
  const portablePath = path.join(userData, "love");

  switch (platform) {
    case "linux":
      const linuxPaths = [
        "/usr/bin/love",
        "/usr/local/bin/love",
        path.join(portablePath, "love.AppImage"),
      ];
      for (const p of linuxPaths) {
        if (fs.existsSync(p)) {
          return p;
        }
      }
      break;

    case "win32":
      const windowsPaths = [
        "C:\\Program Files\\LOVE\\love.exe",
        "C:\\Program Files (x86)\\LOVE\\love.exe",
        path.join(portablePath, "love.exe"),
      ];
      for (const p of windowsPaths) {
        if (fs.existsSync(p)) {
          return p;
        }
      }
      break;

    case "darwin":
      const macPath = "/Applications/love.app/Contents/MacOS/love";
      if (fs.existsSync(macPath)) {
        return macPath;
      }
      break;
  }

  return null;
}

async function downloadLove2D(onProgress) {
  const platform = os.platform();
  const loveDir = path.join(app.getPath("userData"), "love");

  if (!fs.existsSync(loveDir)) {
    fs.mkdirSync(loveDir, { recursive: true });
  }

  let loveUrl, lovePath;

  switch (platform) {
    case "linux":
      loveUrl =
        "https://github.com/love2d/love/releases/download/11.5/love-11.5-x86_64.AppImage";
      lovePath = path.join(loveDir, "love.AppImage");
      await downloadFile(loveUrl, lovePath, onProgress);
      fs.chmodSync(lovePath, "755");
      break;

    case "win32":
      loveUrl =
        "https://github.com/love2d/love/releases/download/11.5/love-11.5-win64.zip";
      lovePath = path.join(loveDir, "love.zip");
      await downloadFile(loveUrl, lovePath, onProgress);

      const AdmZip = require("adm-zip");
      const zip = new AdmZip(lovePath);
      zip.extractAllTo(loveDir, true);

      const extractedLove = path.join(loveDir, "love-11.5-win64", "love.exe");
      if (fs.existsSync(extractedLove)) {
        lovePath = extractedLove;
      } else {
        throw new Error("Failed to extract Love2D");
      }
      break;

    case "darwin":
      loveUrl =
        "https://github.com/love2d/love/releases/download/11.5/love-11.5-macos.zip";
      lovePath = path.join(loveDir, "love.zip");
      await downloadFile(loveUrl, lovePath, onProgress);

      const AdmZipMac = require("adm-zip");
      const zipMac = new AdmZipMac(lovePath);
      zipMac.extractAllTo(loveDir, true);

      const extractedMac = path.join(loveDir, "love.app");
      if (fs.existsSync(extractedMac)) {
        lovePath = extractedMac;
      } else {
        throw new Error("Failed to extract Love2D");
      }
      break;
  }

  return lovePath;
}

// ────────────────────────────────────────────────────────
//  Run Game – now supports --online and --account-id args
// ────────────────────────────────────────────────────────

async function runGame(
  loveRuntime,
  gameFile,
  online = false,
  accountId = null,
  event = null,
) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(loveRuntime)) {
      reject(new Error("Love2D runtime not found"));
      return;
    }

    if (!fs.existsSync(gameFile)) {
      reject(new Error("Game file not found"));
      return;
    }

    const platform = os.platform();
    const dbUrl = process.env.DATABASE_URL || "";

    // Build args: love <gameFile> --online={true/false} --account-id={id} --db-url=...
    const gameArgs = [gameFile, `--online=${online}`];
    if (accountId) {
      gameArgs.push(`--account-id=${accountId}`);
      if (dbUrl) {
        gameArgs.push(`--db-url=${dbUrl}`);
      }
    }

    let command, args;

    if (platform === "win32") {
      command = loveRuntime;
      args = gameArgs;
    } else if (platform === "darwin" && loveRuntime.endsWith(".app")) {
      command = "open";
      args = ["-a", loveRuntime, "--args", ...gameArgs];
    } else {
      command = loveRuntime;
      args = gameArgs;
    }

    const cmdString = `${command} ${args.join(" ")}`;
    console.log(`Launching: ${cmdString}`);
    if (event) event.sender.send("game-log", `$ ${cmdString}`);

    const gameProcess = spawn(command, args, {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    gameProcess.stdout.on("data", (data) => {
      const text = data.toString().trim();
      if (text) {
        console.log(`[game] ${text}`);
        if (event) event.sender.send("game-log", text);
      }
    });

    gameProcess.stderr.on("data", (data) => {
      const text = data.toString().trim();
      if (text) {
        console.error(`[game:err] ${text}`);
        if (event) event.sender.send("game-log", `[err] ${text}`);
      }
    });

    gameProcess.on("close", (code) => {
      const msg = `Game exited with code ${code}`;
      console.log(msg);
      if (event) event.sender.send("game-log", msg);
    });

    gameProcess.on("error", (error) => {
      const msg = `Game error: ${error.message}`;
      console.error(msg);
      if (event) event.sender.send("game-log", `[FATAL] ${msg}`);
      reject(error);
    });

    gameProcess.unref();

    resolve(gameProcess);
  });
}

function getSavedGamePath(version) {
  const gameDir = path.join(app.getPath("userData"), "games");
  return path.join(gameDir, `${version}.love`);
}

function isGameInstalled(version) {
  const gamePath = getSavedGamePath(version);
  return fs.existsSync(gamePath);
}

// IPC Handlers
ipcMain.handle("get-releases", async (event, includePreReleases) => {
  try {
    const release = await getLatestRelease(includePreReleases);
    const isInstalled = isGameInstalled(release.version);
    return {
      success: true,
      release,
      isInstalled,
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle("download-game", async (event, downloadUrl, version) => {
  const gameDir = path.join(app.getPath("userData"), "games");
  const gameFilePath = path.join(gameDir, `${version}.love`);

  if (!fs.existsSync(gameDir)) {
    fs.mkdirSync(gameDir, { recursive: true });
  }

  try {
    await downloadFile(downloadUrl, gameFilePath, (progress) => {
      event.sender.send("download-progress", { type: "game", progress });
    });
    return { success: true, path: gameFilePath };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle("check-love2d", async () => {
  const loveRuntime = getLove2DRuntime();
  if (loveRuntime) {
    return { success: true, path: loveRuntime };
  }
  return { success: false };
});

ipcMain.handle("download-love2d", async (event) => {
  try {
    const loveRuntime = await downloadLove2D((progress) => {
      event.sender.send("download-progress", { type: "love2d", progress });
    });
    return { success: true, path: loveRuntime };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle(
  "run-game",
  async (event, loveRuntime, gameFile, online, accountId) => {
    try {
      await runGame(loveRuntime, gameFile, online, accountId, event);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  },
);

ipcMain.handle("get-installed-version", async () => {
  const gameDir = path.join(app.getPath("userData"), "games");
  if (!fs.existsSync(gameDir)) return null;

  const files = fs.readdirSync(gameDir);
  const loveFiles = files.filter((f) => f.endsWith(".love"));
  if (loveFiles.length === 0) return null;

  let latestFile = null;
  let latestTime = 0;
  for (const file of loveFiles) {
    const filePath = path.join(gameDir, file);
    const stats = fs.statSync(filePath);
    if (stats.mtimeMs > latestTime) {
      latestTime = stats.mtimeMs;
      latestFile = file;
    }
  }

  if (latestFile) {
    const version = latestFile.replace(".love", "");
    return { version, path: path.join(gameDir, latestFile) };
  }
  return null;
});

// ────────────────────────────────────────────────────────
//  Local API server
// ────────────────────────────────────────────────────────

function startApiServer() {
  return new Promise((resolve) => {
    const serverPath = path.join(__dirname, "server.js");
    if (!fs.existsSync(serverPath)) {
      console.log("[ZayForge] server.js not found, skipping local API");
      resolve(false);
      return;
    }

    apiServer = fork(serverPath, [], {
      stdio: "pipe",
      env: { ...process.env },
    });

    apiServer.stdout.on("data", (data) => {
      console.log(`[API] ${data.toString().trim()}`);
    });

    apiServer.stderr.on("data", (data) => {
      console.error(`[API:err] ${data.toString().trim()}`);
    });

    apiServer.on("error", (err) => {
      console.error("[API] Failed to start:", err.message);
      apiServer = null;
    });

    apiServer.on("exit", (code) => {
      console.log(`[API] Server exited with code ${code}`);
      apiServer = null;
    });

    // Give it a moment to start
    setTimeout(() => resolve(true), 500);
  });
}

function stopApiServer() {
  if (apiServer) {
    apiServer.kill();
    apiServer = null;
  }
}

// ────────────────────────────────────────────────────────
//  App lifecycle
// ────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  await startApiServer();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  stopApiServer();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  stopApiServer();
});
