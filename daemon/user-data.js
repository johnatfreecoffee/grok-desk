/**
 * Durable user data — OUTSIDE the rebuild tree.
 *
 * Lives in ~/Library/Application Support/GrokDesk/
 * so `make-app` / rebuilds never wipe Settings, secrets, or desk-index.
 * One-time migrate from the old repo-local data/ folder if present.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT } from "./load-env.js";

const APP_SUPPORT = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "GrokDesk",
);

const LEGACY_DATA = path.join(ROOT, "data");

export function userDataDir() {
  fs.mkdirSync(APP_SUPPORT, { recursive: true });
  return APP_SUPPORT;
}

export function userDataPath(...parts) {
  return path.join(userDataDir(), ...parts);
}

/** Copy legacy file once if dest missing. */
function migrateFile(name) {
  const dest = userDataPath(name);
  if (fs.existsSync(dest)) return;
  const src = path.join(LEGACY_DATA, name);
  if (!fs.existsSync(src)) return;
  try {
    fs.copyFileSync(src, dest);
    console.log(`[user-data] migrated ${name} → ${dest}`);
  } catch (e) {
    console.warn(`[user-data] migrate ${name} failed:`, e.message);
  }
}

let migrated = false;
export function ensureUserDataMigrated() {
  if (migrated) return;
  migrated = true;
  userDataDir();
  for (const name of ["settings.json", "secrets.json", "desk-index.json"]) {
    migrateFile(name);
  }
  // uploads stay under app support too
  const legacyUploads = path.join(LEGACY_DATA, "uploads");
  const destUploads = userDataPath("uploads");
  if (fs.existsSync(legacyUploads) && !fs.existsSync(destUploads)) {
    try {
      fs.cpSync(legacyUploads, destUploads, { recursive: true });
      console.log("[user-data] migrated uploads/");
    } catch {
      /* */
    }
  }
}

/** Source folder for improving Grok Desk itself. */
export function deskSourceDir() {
  return ROOT; // ~/Documents/grok-desk
}
