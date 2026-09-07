/**
 * Grok Folders (native NSMenu extra) — launchd + state.json.
 * Bundle id / label: dev.freecoffee.GrokFolders
 */
import { spawnSync } from "node:child_process";
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

function isBootstrapped() {
  const r = spawnSync("launchctl", ["print", launchdTarget()], {
    encoding: "utf8",
    timeout: 8000,
  });
  return r.status === 0;
}

function isRunning() {
  const r = spawnSync("pgrep", ["-f", "Grok Folders.app/Contents/MacOS/GrokFolders"], {
    encoding: "utf8",
    timeout: 5000,
  });
  return r.status === 0 && String(r.stdout || "").trim().length > 0;
}

function appPath() {
  if (fs.existsSync(INSTALLED_APP)) return INSTALLED_APP;
  if (fs.existsSync(BUILD_APP)) return BUILD_APP;
  return INSTALLED_APP;
}

export function status() {
  const state = loadState();
  return {
    enabled: isBootstrapped(),
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

export function setEnabled(on) {
  if (on) {
    ensureBuilt();
    runScript("install.sh");
  } else {
    runScript("uninstall.sh");
  }
  return status();
}

export { LABEL, STATE_PATH, FOLDERS_ROOT, INSTALLED_APP };
