/**
 * Subscription speech-to-text via Grok login (same as TUI /voice).
 * POST https://api.x.ai/v1/stt — OAuth from ~/.grok/auth.json, no API key.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const GROK_HOME = process.env.GROK_HOME || path.join(os.homedir(), ".grok");
const AUTH = path.join(GROK_HOME, "auth.json");
const STT_URL = "https://api.x.ai/v1/stt";
const MAX_BYTES = 8 * 1024 * 1024;

export function loadGrokOAuthToken() {
  if (!fs.existsSync(AUTH)) return null;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(AUTH, "utf8"));
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  let best = null;
  for (const entry of Object.values(data)) {
    if (!entry || typeof entry !== "object" || !entry.key) continue;
    if (best == null || String(entry.expires_at || "") > String(best.expires_at || "")) {
      best = entry;
    }
  }
  return best?.key || null;
}

export async function transcribeAudio({ buffer, mime } = {}) {
  const token = loadGrokOAuthToken();
  if (!token) {
    const err = new Error("Grok login required for dictation. Run grok login.");
    err.status = 503;
    throw err;
  }
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (!buf.length) {
    const err = new Error("No audio");
    err.status = 400;
    throw err;
  }
  if (buf.length > MAX_BYTES) {
    const err = new Error("Audio too long");
    err.status = 413;
    throw err;
  }
  const type = String(mime || "audio/webm").split(";")[0] || "audio/webm";
  const ext = type.includes("mp4") || type.includes("m4a") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
  const form = new FormData();
  form.append("format", "true");
  form.append("language", "en");
  form.append("file", new Blob([buf], { type }), `dictation.${ext}`);
  const res = await fetch(STT_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = { text: "" };
  }
  if (!res.ok) {
    const err = new Error(
      (data && (data.error || data.message)) || `STT ${res.status}: ${raw.slice(0, 200)}`,
    );
    err.status = res.status === 401 ? 401 : 502;
    throw err;
  }
  const text = String(data.text || "").trim();
  return { ok: true, text, language: data.language || "en", duration: data.duration ?? null };
}
