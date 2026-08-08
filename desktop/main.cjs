/**
 * Grok Desk — desktop shell (Electron)
 * Open app → start daemon → show window
 * Close app → stop daemon + agent
 */
const { app, BrowserWindow, ipcMain, shell, dialog, Menu } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const http = require("http");
const fs = require("fs");

// Must run before ready — menu bar / About name (not "Electron")
// Note: macOS still shows "Electron" if you launch via `electron .` /
// node_modules Electron.app. Always open Grok Desk.app for the real name.
app.setName("Grok Desk");
try {
  process.title = "Grok Desk";
} catch {
  /* */
}
if (process.platform === "darwin") {
  app.setAboutPanelOptions({
    applicationName: "Grok Desk",
    applicationVersion: app.getVersion() || "0.1.0",
    copyright: "Local Grok desk",
  });
}

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.PORT || 8787);
const DESK_URL = `http://127.0.0.1:${PORT}`;

let mainWindow = null;
let daemonProc = null;
let quitting = false;

function log(...args) {
  console.log("[desk-app]", ...args);
}

function resolveNode() {
  if (process.env.NODE_BIN && fs.existsSync(process.env.NODE_BIN)) return process.env.NODE_BIN;
  // Electron's process.execPath is Electron itself — use system node
  const candidates = [
    "/usr/local/bin/node",
    "/opt/homebrew/bin/node",
    process.env.HOME && path.join(process.env.HOME, ".nvm/versions/node"),
  ].filter(Boolean);

  for (const c of candidates) {
    if (c.includes("nvm")) continue;
    if (fs.existsSync(c)) return c;
  }
  return "node";
}

function waitForHealth(timeoutMs = 45000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(`${DESK_URL}/api/status`, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          if (res.statusCode === 200) return resolve(JSON.parse(body || "{}"));
          retry();
        });
      });
      req.on("error", retry);
      req.setTimeout(1500, () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() - start > timeoutMs) {
        reject(new Error("Daemon did not become ready in time"));
        return;
      }
      setTimeout(tick, 250);
    };
    tick();
  });
}

function isPortUp() {
  return new Promise((resolve) => {
    const req = http.get(`${DESK_URL}/api/status`, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(800, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function freePort() {
  // App owns the engine lifecycle — clear anything already on the port
  try {
    const r = spawn("lsof", ["-t", `-iTCP:${PORT}`, "-sTCP:LISTEN"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    r.stdout.on("data", (c) => (out += c));
    return new Promise((resolve) => {
      r.on("close", () => {
        const pids = out
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean);
        for (const pid of pids) {
          try {
            process.kill(Number(pid), "SIGTERM");
            log("freed port; killed pid", pid);
          } catch {
            /* */
          }
        }
        setTimeout(resolve, pids.length ? 400 : 0);
      });
    });
  } catch {
    return Promise.resolve();
  }
}

/** True when this Electron process spawned the engine (vs launchd / shared). */
let ownsDaemon = false;

async function startDaemon() {
  // Prefer existing engine (launchd always-on / phone Serve) — don't kill it
  if (await isPortUp()) {
    log("reusing engine already on port", PORT);
    ownsDaemon = false;
    daemonProc = null;
    return { reused: true };
  }

  const node = resolveNode();
  const entry = path.join(ROOT, "daemon", "index.js");
  const logDir = path.join(ROOT, "data", "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const out = fs.openSync(path.join(logDir, "daemon.out.log"), "a");
  const err = fs.openSync(path.join(logDir, "daemon.err.log"), "a");

  log("starting daemon", node, entry);
  ownsDaemon = true;
  daemonProc = spawn(node, [entry], {
    cwd: ROOT,
    env: {
      ...process.env,
      PATH: [
        "/usr/local/bin",
        "/opt/homebrew/bin",
        path.join(process.env.HOME || "", ".grok", "bin"),
        process.env.PATH || "",
      ].join(":"),
      PORT: String(PORT),
    },
    stdio: ["ignore", out, err],
    detached: false,
  });

  daemonProc.on("exit", (code, signal) => {
    log("daemon exited", code, signal);
    daemonProc = null;
    ownsDaemon = false;
    if (!quitting && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("daemon-died");
    }
  });

  await waitForHealth();
  return { reused: false };
}

function stopDaemon() {
  // Never kill a shared launchd / phone engine we didn't start
  if (!ownsDaemon) {
    log("leaving shared engine running (phone / launchd)");
    daemonProc = null;
    return;
  }
  if (daemonProc) {
    try {
      daemonProc.kill("SIGTERM");
    } catch {
      /* */
    }
    setTimeout(() => {
      try {
        if (daemonProc && !daemonProc.killed) daemonProc.kill("SIGKILL");
      } catch {
        /* */
      }
    }, 1500);
    daemonProc = null;
  }
  ownsDaemon = false;
  void freePort();
}

function createWindow() {
  const iconPath = path.join(ROOT, "assets", "GrokDesk.icns");
  mainWindow = new BrowserWindow({
    width: 980,
    height: 780,
    minWidth: 420,
    minHeight: 560,
    title: "Grok Desk",
    backgroundColor: "#0b1220",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 14 },
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    show: false,
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.loadURL(DESK_URL);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

async function boot() {
  try {
    await startDaemon();
  } catch (e) {
    dialog.showErrorBox(
      "Grok Desk",
      `Couldn't start the local engine.\n\n${e.message}\n\nLogs: ${path.join(ROOT, "data", "logs")}`,
    );
    app.quit();
    return;
  }
  createWindow();
}

ipcMain.handle("desk:restart", async () => {
  // Prefer in-process agent restart via HTTP; if daemon dead, respawn it
  try {
    const up = await isPortUp();
    if (up) {
      await new Promise((resolve, reject) => {
        const req = http.request(
          `${DESK_URL}/api/restart`,
          { method: "POST", headers: { "Content-Type": "application/json" } },
          (res) => {
            res.resume();
            if (res.statusCode && res.statusCode < 300) resolve();
            else reject(new Error(`restart HTTP ${res.statusCode}`));
          },
        );
        req.on("error", reject);
        req.end("{}");
      });
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
      return { ok: true, mode: "agent" };
    }
  } catch (e) {
    log("agent restart failed, full daemon restart", e.message);
  }

  stopDaemon();
  await new Promise((r) => setTimeout(r, 400));
  await startDaemon();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(DESK_URL);
  return { ok: true, mode: "daemon" };
});

ipcMain.handle("desk:get-info", () => ({
  root: ROOT,
  port: PORT,
  url: DESK_URL,
}));

ipcMain.handle("desk:pick-folder", async () => {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  const result = await dialog.showOpenDialog(win || undefined, {
    title: "Open project folder",
    properties: ["openDirectory", "createDirectory"],
    message: "Choose a folder for this Grok Desk session",
  });
  if (result.canceled || !result.filePaths?.[0]) return null;
  return result.filePaths[0];
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    // Application menu uses app name ("Grok Desk") not "Electron"
    if (process.platform === "darwin") {
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
          { role: "editMenu" },
          { role: "viewMenu" },
          { role: "windowMenu" },
        ]),
      );
    }
    return boot();
  });

  app.on("before-quit", () => {
    quitting = true;
    stopDaemon();
  });

  app.on("window-all-closed", () => {
    quitting = true;
    stopDaemon();
    app.quit();
  });

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      try {
        await startDaemon();
        createWindow();
      } catch (e) {
        dialog.showErrorBox("Grok Desk", e.message);
      }
    }
  });
}
