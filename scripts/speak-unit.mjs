#!/usr/bin/env node
import {
  clipIdFrom,
  isClipId,
  loadSpeakSettings,
  speakReady,
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
console.log("speakReady", speakReady());
console.log("settings", st);
console.log("SPEAK UNIT PASS");
