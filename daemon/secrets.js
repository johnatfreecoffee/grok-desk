/**
 * Local secrets for Grok Desk (voice key, etc.).
 * Stored under Application Support — survives app rebuilds.
 */
import fs from "node:fs";
import path from "node:path";
import { loadEnv } from "./load-env.js";
import { ensureUserDataMigrated, userDataPath } from "./user-data.js";

function secretsPath() {
  ensureUserDataMigrated();
  return userDataPath("secrets.json");
}

export function loadSecrets() {
  try {
    const p = secretsPath();
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, "utf8")) || {};
    }
  } catch {
    /* */
  }
  return {};
}

export function saveSecrets(patch) {
  const next = { ...loadSecrets(), ...patch };
  for (const [k, v] of Object.entries(next)) {
    if (v === null || v === "") delete next[k];
  }
  const p = secretsPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(next, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(p, 0o600);
  } catch {
    /* */
  }
  return next;
}

/** Resolve xAI key: env > secrets file. */
export function resolveXaiApiKey() {
  loadEnv();
  const fromEnv = (process.env.XAI_API_KEY || "").trim();
  if (fromEnv) return fromEnv;
  const fromFile = (loadSecrets().xaiApiKey || "").trim();
  return fromFile || "";
}

export function hasXaiApiKey() {
  return Boolean(resolveXaiApiKey());
}

export function maskXaiKey() {
  const key = resolveXaiApiKey();
  if (!key) return null;
  if (key.length <= 8) return "••••••••";
  return `${"•".repeat(Math.min(12, key.length - 4))}${key.slice(-4)}`;
}
