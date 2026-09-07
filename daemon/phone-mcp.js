/**
 * grok.com Streamable HTTP MCP — launchd helper.
 * MCP stays on :3311; Desk :8787 only exposes status/enable/token copy.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT } from "./load-env.js";
import { userDataPath } from "./user-data.js";

const execFileAsync = promisify(execFile);

export const PHONE_MCP_PORT = 3311;
export const PHONE_MCP_LABEL = "dev.freecoffee.grok-phone-mcp";
export const DEFAULT_PUBLIC_URL = "https://grok-mcp.freecoffee.dev/mcp";

const HOME = os.homedir();
const UID = process.getuid?.() ?? os.userInfo().uid;
const STATE = path.join(HOME, ".grok", "phone-mcp");
const TOKEN_PATH = path.join(STATE, "token");
const INSTALL_SH = path.join(ROOT, "tools", "phone-mcp", "scripts", "install-launchd.sh");
const DEFAULT_ROOTS = [path.join(HOME, "Documents")];

function settingsPath() {
  return userDataPath("phone-mcp.json");
}

function loadPhoneSettings() {
  try {
    const p = settingsPath();
    if (!fs.existsSync(p)) return {};
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function publicUrlFromSettings() {
  const raw = loadPhoneSettings().publicUrl;
  const url = typeof raw === "string" ? raw.trim() : "";
  return url || DEFAULT_PUBLIC_URL;
}

export function savePublicUrl(url) {
  const publicUrl = String(url || "").trim() || DEFAULT_PUBLIC_URL;
  const next = { ...loadPhoneSettings(), publicUrl };
  fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  return publicUrl;
}

export function readToken() {
  try {
    if (!fs.existsSync(TOKEN_PATH)) return "";
    return fs.readFileSync(TOKEN_PATH, "utf8").replace(/\s+/g, "");
  } catch {
    return "";
  }
}

function maskToken(token) {
  if (!token) return null;
  if (token.length <= 8) return `${token.slice(0, 2)}…${token.slice(-2)}`;
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

function opensslHex24() {
  return execFileSync("openssl", ["rand", "-hex", "24"], { encoding: "utf8" }).trim();
}

function ensureToken() {
  fs.mkdirSync(path.join(STATE, "jobs"), { recursive: true });
  const cur = readToken();
  if (cur && cur.length >= 16) return cur;
  const hex = opensslHex24();
  fs.writeFileSync(TOKEN_PATH, `${hex}\n`, { mode: 0o600 });
  fs.chmodSync(TOKEN_PATH, 0o600);
  return hex;
}

function launchctlTarget() {
  return `gui/${UID}/${PHONE_MCP_LABEL}`;
}

async function agentState() {
  try {
    const { stdout } = await execFileAsync("launchctl", ["print", launchctlTarget()], {
      timeout: 8_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const running =
      /^\s*state\s*=\s*running\b/m.test(stdout) || /^\s*pid\s*=\s*[1-9]\d*/m.test(stdout);
    return { enabled: true, running };
  } catch {
    return { enabled: false, running: false };
  }
}

async function probeHealth() {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 1500);
    const r = await fetch(`http://127.0.0.1:${PHONE_MCP_PORT}/health`, { signal: ac.signal });
    clearTimeout(t);
    if (!r.ok) return "down";
    const body = await r.json().catch(() => ({}));
    return body && body.ok ? "ok" : "down";
  } catch {
    return "down";
  }
}

export async function status() {
  const token = readToken();
  const { enabled, running } = await agentState();
  const health = running ? await probeHealth() : "down";
  return {
    enabled,
    running,
    health,
    port: PHONE_MCP_PORT,
    publicUrl: publicUrlFromSettings(),
    tokenSet: Boolean(token),
    tokenMasked: maskToken(token),
    roots: DEFAULT_ROOTS,
  };
}

async function runInstall() {
  ensureToken();
  if (!fs.existsSync(INSTALL_SH)) {
    throw new Error(`missing ${INSTALL_SH}`);
  }
  await execFileAsync("bash", [INSTALL_SH], {
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
    cwd: path.dirname(INSTALL_SH),
    env: {
      ...process.env,
      HOME,
      PATH: `/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:${HOME}/.grok/bin:${process.env.PATH || ""}`,
    },
  });
}

async function bootout() {
  try {
    await execFileAsync("launchctl", ["bootout", launchctlTarget()], { timeout: 15_000 });
  } catch {
    /* already unloaded */
  }
}

async function kickstart() {
  await execFileAsync("launchctl", ["kickstart", "-k", launchctlTarget()], { timeout: 15_000 });
}

export async function setEnabled(on) {
  if (on) {
    await runInstall();
  } else {
    await bootout();
  }
  return status();
}

export async function rotateToken() {
  fs.mkdirSync(path.join(STATE, "jobs"), { recursive: true });
  const hex = opensslHex24();
  fs.writeFileSync(TOKEN_PATH, `${hex}\n`, { mode: 0o600 });
  fs.chmodSync(TOKEN_PATH, 0o600);
  const { enabled } = await agentState();
  if (enabled) {
    try {
      await kickstart();
    } catch (e) {
      throw new Error(`token written; restart failed: ${e.message || e}`);
    }
  }
  return status();
}
