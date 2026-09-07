#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  clipIdFrom,
  isClipId,
  loadSpeakSettings,
  speakBin,
  speakReady,
  tuiInstalled,
  SPEAK_VOICES,
} from "../daemon/speak.js";

const a = clipIdFrom("hello", "concise", "rex");
const b = clipIdFrom("hello", "concise", "rex");
const c = clipIdFrom("hello", "casual", "rex");
if (a !== b) throw new Error("hash unstable");
if (a === c) throw new Error("mode must change hash");
if (!isClipId(a)) throw new Error("clip id shape");
if (isClipId("../etc/passwd")) throw new Error("path traversal id");
if (!SPEAK_VOICES.some((v) => v.id === "rex")) throw new Error("rex missing");
const st = loadSpeakSettings();
if (!st.mode || !st.voice) throw new Error("settings empty");

const prevSpeak = process.env.GROK_SPEAK;
delete process.env.GROK_SPEAK;
try {
  const bin = speakBin();
  const vendored = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../tools/speak/bin/grok-speak",
  );
  if (bin !== vendored) throw new Error(`speakBin prefers vendored, got ${bin}`);
  if (!fs.existsSync(bin)) throw new Error("vendored grok-speak missing");
  console.log("speakBin", bin);
} finally {
  if (prevSpeak !== undefined) process.env.GROK_SPEAK = prevSpeak;
}

console.log("speakReady", speakReady());
console.log("tuiInstalled", tuiInstalled());
console.log("settings", st);
console.log("SPEAK UNIT PASS");
