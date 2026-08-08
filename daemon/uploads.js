/**
 * Save user attachments for a session so the agent can read_file them.
 * Files land under data/uploads/<sessionId>/ (absolute paths returned).
 */
import fs from "node:fs";
import path from "node:path";
import { ensureUserDataMigrated, userDataPath } from "./user-data.js";

function safeName(name) {
  const base = path.basename(String(name || "file")).replace(/[^\w.\- ()[\]]+/g, "_");
  return base.slice(0, 180) || "file";
}

export function sessionUploadDir(sessionId) {
  ensureUserDataMigrated();
  const id = String(sessionId || "unknown").replace(/[^\w\-]+/g, "_").slice(0, 64);
  const dir = userDataPath("uploads", id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * @param {{ sessionId: string, name: string, mime?: string, dataBase64: string, preferCwd?: string }} opts
 */
export function saveUpload(opts) {
  const { sessionId, name, mime, dataBase64, preferCwd } = opts;
  if (!dataBase64) throw new Error("missing file data");
  const buf = Buffer.from(dataBase64, "base64");
  if (buf.length > 40 * 1024 * 1024) throw new Error("File too large (max 40MB)");

  // Prefer writing inside the project cwd so tools see it as project files,
  // with a fallback under desk data/uploads.
  let dir;
  if (preferCwd && fs.existsSync(preferCwd)) {
    dir = path.join(preferCwd, ".grok-desk-uploads");
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      dir = sessionUploadDir(sessionId);
    }
  } else {
    dir = sessionUploadDir(sessionId);
  }

  const stamp = Date.now().toString(36);
  const fileName = `${stamp}-${safeName(name)}`;
  const abs = path.join(dir, fileName);
  fs.writeFileSync(abs, buf);
  return {
    path: abs,
    name: safeName(name),
    mime: mime || "application/octet-stream",
    bytes: buf.length,
  };
}

export function isImageMime(mime) {
  return String(mime || "").startsWith("image/");
}
