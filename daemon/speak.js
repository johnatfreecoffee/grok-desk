/**
 * Subscription TTS via grok-speak (OAuth in ~/.grok/auth.json).
 * No console API key.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SPEAK_MODES = ["verbatim", "concise", "casual", "full"];

export const SPEAK_VOICES = [
  { id: "rex", name: "Rex", detail: "Confident and clear" },
  { id: "ara", name: "Ara", detail: "Warm and friendly" },
  { id: "eve", name: "Eve", detail: "Energetic and upbeat" },
  { id: "leo", name: "Leo", detail: "Authoritative and strong" },
  { id: "sal", name: "Sal", detail: "Smooth and balanced" },
  { id: "orion", name: "Orion", detail: "Rich, cinematic" },
  { id: "luna", name: "Luna", detail: "Gentle, patient" },
  { id: "iris", name: "Iris", detail: "Friendly, upbeat" },
  { id: "altair", name: "Altair", detail: "Elegant, refined" },
  { id: "atlas", name: "Atlas", detail: "Confident, commanding" },
  { id: "aurora", name: "Aurora", detail: "Serene, steady" },
  { id: "carina", name: "Carina", detail: "Soft, empathetic" },
  { id: "castor", name: "Castor", detail: "Down-to-earth" },
  { id: "celeste", name: "Celeste", detail: "Compassionate" },
  { id: "cosmo", name: "Cosmo", detail: "Bright, curious" },
  { id: "helios", name: "Helios", detail: "Upbeat, versatile" },
  { id: "helix", name: "Helix", detail: "Bold, dynamic" },
  { id: "kepler", name: "Kepler", detail: "Inventive" },
  { id: "liora", name: "Liora", detail: "Calm, grounded" },
  { id: "lumen", name: "Lumen", detail: "Warm, articulate" },
  { id: "lux", name: "Lux", detail: "Grounded, calm" },
  { id: "naksh", name: "Naksh", detail: "Warm, thoughtful" },
  { id: "perseus", name: "Perseus", detail: "Strong, trustworthy" },
  { id: "rigel", name: "Rigel", detail: "Precise, professional" },
  { id: "sirius", name: "Sirius", detail: "Quick-witted" },
  { id: "ursa", name: "Ursa", detail: "Friendly, steadfast" },
  { id: "zagan", name: "Zagan", detail: "Powerful, dramatic" },
  { id: "zenith", name: "Zenith", detail: "Sharp, focused" },
];

const HOME = os.homedir();
const GROK_HOME = process.env.GROK_HOME || path.join(HOME, ".grok");
const AUTH = path.join(GROK_HOME, "auth.json");
const SETTINGS = path.join(GROK_HOME, "speak.toml");
const HISTORY = path.join(GROK_HOME, "speak-history", "desk");
const DEFAULTS = { mode: "concise", voice: "rex" };

export function speakBin() {
  const env = (process.env.GROK_SPEAK || "").trim();
  if (env && fs.existsSync(env)) return env;
  const linked = path.join(GROK_HOME, "bin", "grok-speak");
  if (fs.existsSync(linked)) return linked;
  const repo = path.join(HOME, "Documents", "grok-speak", "bin", "grok-speak");
  if (fs.existsSync(repo)) return repo;
  return linked;
}

export function speakReady() {
  try {
    return fs.existsSync(speakBin()) && fs.existsSync(AUTH) && fs.statSync(AUTH).size > 8;
  } catch {
    return false;
  }
}

export function loadSpeakSettings() {
  const out = { ...DEFAULTS };
  try {
    if (fs.existsSync(SETTINGS)) {
      const raw = fs.readFileSync(SETTINGS, "utf8");
      const mode = raw.match(/^\s*mode\s*=\s*"?([^"\n]+)"?/m);
      const voice = raw.match(/^\s*voice\s*=\s*"?([^"\n]+)"?/m);
      if (mode?.[1]) out.mode = mode[1].trim().toLowerCase();
      if (voice?.[1]) out.voice = voice[1].trim();
    }
  } catch {
    /* */
  }
  if (!SPEAK_MODES.includes(out.mode)) out.mode = DEFAULTS.mode;
  if (!out.voice) out.voice = DEFAULTS.voice;
  return out;
}

export function saveSpeakSettings(patch = {}) {
  const cur = loadSpeakSettings();
  if (patch.mode && SPEAK_MODES.includes(String(patch.mode).toLowerCase())) {
    cur.mode = String(patch.mode).toLowerCase();
  }
  if (patch.voice && String(patch.voice).trim()) {
    cur.voice = String(patch.voice).trim();
  }
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  fs.writeFileSync(SETTINGS, `mode = "${cur.mode}"\nvoice = "${cur.voice}"\n`);
  return cur;
}

export function speakStatusPayload() {
  const settings = loadSpeakSettings();
  return {
    speakReady: speakReady(),
    speakMode: settings.mode,
    speakVoice: settings.voice,
    speakVoices: SPEAK_VOICES,
    speakBin: speakBin(),
  };
}

export function clipIdFrom(text, mode, voice) {
  return crypto
    .createHash("sha256")
    .update(`${mode}\0${voice}\0${text}`)
    .digest("hex")
    .slice(0, 20);
}

export function isClipId(id) {
  return typeof id === "string" && /^[a-f0-9]{12,64}$/i.test(id);
}

function clipDir(id) {
  return path.join(HISTORY, id);
}

export function readClip(id) {
  if (!isClipId(id)) return null;
  const dir = clipDir(id);
  const mp3 = path.join(dir, "audio.mp3");
  if (!fs.existsSync(mp3)) return null;
  let spoken = "";
  let words = [];
  let duration = null;
  try {
    spoken = fs.readFileSync(path.join(dir, "spoken.txt"), "utf8");
  } catch {
    /* */
  }
  try {
    const ts = JSON.parse(fs.readFileSync(path.join(dir, "timestamps.json"), "utf8"));
    spoken = ts.text || spoken;
    words = Array.isArray(ts.words) ? ts.words : [];
    duration = typeof ts.duration === "number" ? ts.duration : null;
  } catch {
    /* */
  }
  return {
    clipId: id,
    audioPath: mp3,
    spoken,
    words,
    duration,
    mode: readMeta(dir).mode,
    voice: readMeta(dir).voice,
  };
}

function readMeta(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
  } catch {
    return {};
  }
}

function clipPayload(clip, { cached = false } = {}) {
  return {
    ok: true,
    clipId: clip.clipId,
    audioUrl: `/api/speak/clip/${clip.clipId}.mp3`,
    spoken: clip.spoken || "",
    words: clip.words || [],
    duration: clip.duration,
    mode: clip.mode,
    voice: clip.voice,
    cached,
  };
}

function runGrokSpeak(args, { timeoutMs = 180000 } = {}) {
  const bin = speakBin();
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => {
      stdout += String(d);
    });
    proc.stderr.on("data", (d) => {
      stderr += String(d);
    });
    const t = setTimeout(() => {
      try {
        proc.kill("SIGTERM");
      } catch {
        /* */
      }
      reject(new Error("TTS timed out"));
    }, timeoutMs);
    proc.on("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
    proc.on("close", (code) => {
      clearTimeout(t);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error((stderr || stdout || `grok-speak exited ${code}`).trim().slice(0, 400)));
    });
  });
}

export async function synthesizeSpeak({ text, mode, voice } = {}) {
  const clean = String(text || "").trim();
  if (!clean) {
    const err = new Error("Nothing to speak");
    err.status = 400;
    throw err;
  }
  if (!speakReady()) {
    const err = new Error("Grok Speak not ready — grok login and install grok-speak.");
    err.status = 503;
    throw err;
  }
  const settings = loadSpeakSettings();
  const useMode = SPEAK_MODES.includes(String(mode || "").toLowerCase())
    ? String(mode).toLowerCase()
    : settings.mode;
  const useVoice = String(voice || settings.voice || "rex").trim() || "rex";
  const id = clipIdFrom(clean, useMode, useVoice);
  const existing = readClip(id);
  if (existing) return clipPayload(existing, { cached: true });

  const dir = clipDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const input = path.join(dir, "input.txt");
  const mp3 = path.join(dir, "audio.mp3");
  const spoken = path.join(dir, "spoken.txt");
  const timestamps = path.join(dir, "timestamps.json");
  fs.writeFileSync(input, clean);
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({ mode: useMode, voice: useVoice, at: new Date().toISOString() }),
  );

  await runGrokSpeak([
    useMode,
    "--synthesize",
    "--voice",
    useVoice,
    "--file",
    input,
    "--out",
    mp3,
    "--spoken-out",
    spoken,
    "--timestamps-out",
    timestamps,
  ]);

  const clip = readClip(id);
  if (!clip) {
    const err = new Error("TTS wrote no audio");
    err.status = 502;
    throw err;
  }
  return clipPayload(clip, { cached: false });
}
