/**
 * Grok Folders — native menu-bar helper owned by Grok Desk.
 * No standalone .app / launchd. Electron starts and stops the comet.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOME = os.homedir();
const LABEL = "dev.freecoffee.GrokFolders";
const STATE_DIR = path.join(HOME, "Library", "Application Support", "GrokFolders");
const STATE_PATH = path.join(STATE_DIR, "state.json");
const INSTALLED_APP = path.join(HOME, "Applications", "Grok Folders.app");
const DESK_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FOLDERS_ROOT = path.join(DESK_ROOT, "native", "folders");
const BUILD_APP = path.join(FOLDERS_ROOT, ".build", "Grok Folders.app");
const BUILD_BIN = path.join(BUILD_APP, "Contents", "MacOS", "GrokFolders");
const FLAG_DIR = path.join(HOME, "Library", "Application Support", "GrokDesk");
const FLAG_PATH = path.join(FLAG_DIR, "folders-helper.json");
const PLIST = path.join(HOME, "Library", "LaunchAgents", `${LABEL}.plist`);
const OPEN_MODES = new Set(["grok", "terminal"]);
const DEFAULT_ROOT = path.join(HOME, "Documents");

function uid() {
  return typeof process.getuid === "function" ? process.getuid() : os.userInfo().uid;
}

function launchdTarget() {
  return `gui/${uid()}/${LABEL}`;
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Resolve a path that must stay at or under $HOME. Never above $HOME. */
export function resolveUnderHome(input) {
  if (input == null) return null;
  let raw = String(input).trim();
  if (!raw) return null;
  const home = path.resolve(HOME);
  if (raw === "~") raw = home;
  else if (raw.startsWith("~/")) raw = path.join(home, raw.slice(2));
  const resolved = path.resolve(raw);
  if (resolved !== home && !resolved.startsWith(home + path.sep)) return null;
  if (!isDir(resolved)) return null;
  return resolved;
}

function documentsRoot() {
  return isDir(DEFAULT_ROOT) ? DEFAULT_ROOT : path.resolve(HOME);
}

function defaults() {
  return {
    lastPath: documentsRoot(),
    recents: [],
    defaultOpen: "grok",
    openOnHover: true,
  };
}

function normalizeState(raw = {}) {
  const state = defaults();
  const last = resolveUnderHome(raw.lastPath);
  state.lastPath = last || documentsRoot();
  const recents = Array.isArray(raw.recents) ? raw.recents : [];
  const seen = new Set();
  state.recents = recents
    .map((p) => resolveUnderHome(p))
    .filter((p) => {
      if (!p || seen.has(p)) return false;
      seen.add(p);
      return true;
    })
    .slice(0, 8);
  const mode = String(raw.defaultOpen || "grok").trim().toLowerCase();
  state.defaultOpen = OPEN_MODES.has(mode) ? mode : "grok";
  state.openOnHover = raw.openOnHover !== false;
  return state;
}

function readStateFile() {
  try {
    if (fs.existsSync(STATE_PATH)) {
      return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    }
  } catch {
    /* */
  }
  return null;
}

function writeState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state), { mode: 0o600 });
}

function loadState() {
  const existing = readStateFile();
  if (!existing) {
    const fresh = defaults();
    writeState(fresh);
    return fresh;
  }
  return normalizeState(existing);
}

function rememberRecent(state, p) {
  const next = [p, ...state.recents.filter((x) => x !== p)].slice(0, 8);
  state.recents = next;
}

export function saveState(patch = {}) {
  const state = loadState();
  if (patch.openOnHover != null) state.openOnHover = Boolean(patch.openOnHover);
  if (patch.defaultOpen != null) {
    const mode = String(patch.defaultOpen).trim().toLowerCase();
    if (OPEN_MODES.has(mode)) state.defaultOpen = mode;
  }
  if (patch.lastPath != null) {
    const next = resolveUnderHome(patch.lastPath);
    if (next) {
      state.lastPath = next;
      rememberRecent(state, next);
    }
  }
  writeState(state);
  return state;
}

function loadFlag() {
  try {
    if (fs.existsSync(FLAG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(FLAG_PATH, "utf8"));
      return raw.enabled !== false;
    }
  } catch {
    /* */
  }
  return true;
}

function saveFlag(on) {
  fs.mkdirSync(FLAG_DIR, { recursive: true });
  fs.writeFileSync(FLAG_PATH, JSON.stringify({ enabled: Boolean(on) }) + "\n", { mode: 0o600 });
}

function isRunning() {
  const r = spawnSync("pgrep", ["-x", "GrokFolders"], {
    encoding: "utf8",
    timeout: 5000,
  });
  return r.status === 0 && String(r.stdout || "").trim().length > 0;
}

function helperBin() {
  const envBin = process.env.GROK_FOLDERS_BIN;
  if (envBin && fs.existsSync(envBin)) return envBin;
  ensureBuilt();
  if (fs.existsSync(BUILD_BIN)) return BUILD_BIN;
  const nested = path.join(
    HOME,
    "Applications",
    "Grok Desk.app",
    "Contents",
    "Helpers",
    "Grok Folders.app",
    "Contents",
    "MacOS",
    "GrokFolders",
  );
  if (fs.existsSync(nested)) return nested;
  return path.join(DESK_ROOT, "Grok Desk.app", "Contents", "Helpers", "Grok Folders.app", "Contents", "MacOS", "GrokFolders");
}

function appPath() {
  const bin = helperBin();
  // .../Grok Folders.app/Contents/MacOS/GrokFolders
  return path.resolve(bin, "..", "..", "..");
}

export function status() {
  const state = loadState();
  return {
    enabled: loadFlag(),
    running: isRunning(),
    appPath: appPath(),
    lastPath: state.lastPath,
    recents: state.recents,
    defaultOpen: state.defaultOpen,
    openOnHover: state.openOnHover,
    root: documentsRoot(),
  };
}

function runScript(name) {
  const script = path.join(FOLDERS_ROOT, "scripts", name);
  if (!fs.existsSync(script)) throw new Error(`missing ${script}`);
  const r = spawnSync("bash", [script], {
    encoding: "utf8",
    timeout: 180000,
    env: process.env,
  });
  if (r.status !== 0) {
    const err = (r.stderr || r.stdout || "").trim() || `exit ${r.status}`;
    throw new Error(`${name} failed: ${err}`);
  }
  return (r.stdout || "").trim();
}

function ensureBuilt() {
  if (fs.existsSync(BUILD_BIN)) return;
  runScript("build.sh");
}

function killHelper() {
  spawnSync("pkill", ["-x", "GrokFolders"], { timeout: 5000 });
}

function migrateStandalone() {
  spawnSync("launchctl", ["bootout", launchdTarget()], { timeout: 8000 });
  try {
    if (fs.existsSync(PLIST)) fs.unlinkSync(PLIST);
  } catch {
    /* */
  }
  spawnSync("/bin/rm", ["-rf", INSTALLED_APP], { timeout: 8000 });
}

function spawnHelper() {
  const bin = helperBin();
  if (!fs.existsSync(bin)) throw new Error(`Folders helper missing: ${bin}`);
  const deskApp =
    process.env.GROK_DESK_APP ||
    (fs.existsSync(path.join(HOME, "Applications", "Grok Desk.app"))
      ? path.join(HOME, "Applications", "Grok Desk.app")
      : path.join(DESK_ROOT, "Grok Desk.app"));
  const child = spawn(bin, [], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      GROK_DESK_HELPER: "1",
      GROK_DESK_APP: deskApp,
    },
  });
  child.unref();
}

function sleep(ms) {
  spawnSync("sleep", [String(ms / 1000)], { timeout: ms + 1000 });
}

export function setEnabled(on) {
  saveFlag(on);
  migrateStandalone();
  if (on) {
    ensureBuilt();
    killHelper();
    sleep(300);
    spawnHelper();
  } else {
    killHelper();
  }
  return status();
}

export function ensureHelper() {
  migrateStandalone();
  if (!loadFlag()) {
    if (isRunning()) killHelper();
    return status();
  }
  ensureBuilt();
  if (!isRunning()) spawnHelper();
  return status();
}

export function stopHelper() {
  killHelper();
  return status();
}

const isCli = process.argv[1] && path.basename(process.argv[1]) === "folders.js";
if (isCli) {
  const cmd = process.argv[2] || "ensure";
  if (cmd === "stop") stopHelper();
  else if (cmd === "off") setEnabled(false);
  else if (cmd === "on") setEnabled(true);
  else ensureHelper();
}

export { LABEL, STATE_PATH, FOLDERS_ROOT, INSTALLED_APP };
