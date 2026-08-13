#!/usr/bin/env node
/**
 * Phone-sequence thread isolation smoke.
 * Usage: node scripts/smoke-thread-isolation.mjs
 *
 * A starts a turn → new_session B must not abandon A → prompt B while A live
 * → load A has ALPHA not BRAVO → load B has BRAVO not ALPHA.
 */
import WebSocket from "ws";
import fs from "node:fs";

const PORT = process.env.PORT || 8787;
const CWD = process.env.SMOKE_CWD || `${process.env.HOME}/tmp-grok-desk-smoke`;
try {
  fs.mkdirSync(CWD, { recursive: true });
} catch {
  /* */
}

function wait(ws, pred, ms = 90000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    const fn = (raw) => {
      let m;
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (pred(m)) {
        clearTimeout(t);
        ws.off("message", fn);
        resolve(m);
      }
    };
    ws.on("message", fn);
  });
}

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
await new Promise((r, j) => {
  ws.on("open", r);
  ws.on("error", j);
});
await wait(ws, (m) => m.type === "hello");
console.log("✓ hello");

ws.send(JSON.stringify({ type: "new_session", cwd: CWD }));
const sessA = await wait(ws, (m) => m.type === "session");
const sidA = sessA.sessionId;
if (!sidA) throw new Error("session A missing id");
console.log("✓ session A", sidA.slice(0, 8));

const ends = [];
ws.on("message", (raw) => {
  try {
    const m = JSON.parse(String(raw));
    if (m.type === "turn_end") ends.push(m);
  } catch {
    /* */
  }
});

ws.send(
  JSON.stringify({
    type: "prompt",
    text: "Reply only with the single word ALPHA. No other text.",
    sessionId: sidA,
    clientMsgId: `iso_a_${Date.now()}`,
  }),
);
await wait(ws, (m) => m.type === "turn_start" && m.sessionId === sidA);
console.log("✓ A turn_start");

ws.send(JSON.stringify({ type: "new_session", cwd: CWD }));
const sessB = await wait(ws, (m) => m.type === "session" && m.sessionId !== sidA, 30000);
const sidB = sessB.sessionId;
if (!sidB || sidB === sidA) throw new Error("session B did not get its own id");
if (ends.some((e) => e.sessionId === sidA && e.abandoned)) {
  throw new Error("A was abandoned by new_session B");
}
console.log("✓ session B", sidB.slice(0, 8), sessB.parallel ? "(parallel)" : "");

ws.send(
  JSON.stringify({
    type: "prompt",
    text: "Reply only with the single word BRAVO. No other text.",
    sessionId: sidB,
    clientMsgId: `iso_b_${Date.now()}`,
  }),
);
await wait(ws, (m) => m.type === "turn_start" && m.sessionId === sidB, 60000);
console.log("✓ B turn_start while A live");

const endA = await wait(
  ws,
  (m) => m.type === "turn_end" && m.sessionId === sidA,
  180000,
);
if (endA.abandoned) throw new Error("A turn abandoned");
console.log("✓ A finished (not abandoned)");

const endB = await wait(
  ws,
  (m) => m.type === "turn_end" && m.sessionId === sidB,
  180000,
);
if (endB.abandoned) throw new Error("B turn abandoned");
console.log("✓ B finished");

function hasWord(messages, word) {
  return (messages || []).some((m) => String(m.content || "").includes(word));
}

ws.send(JSON.stringify({ type: "load_session", sessionId: sidA, cwd: CWD }));
const loadedA = await wait(ws, (m) => m.type === "session_loaded" && m.sessionId === sidA);
if (!hasWord(loadedA.messages, "ALPHA")) throw new Error("A missing ALPHA prompt/reply");
if (hasWord(loadedA.messages, "BRAVO")) throw new Error("A leaked BRAVO");
console.log("✓ load A isolated");

ws.send(JSON.stringify({ type: "load_session", sessionId: sidB, cwd: CWD }));
const loadedB = await wait(ws, (m) => m.type === "session_loaded" && m.sessionId === sidB);
if (!hasWord(loadedB.messages, "BRAVO")) throw new Error("B missing BRAVO prompt/reply");
if (hasWord(loadedB.messages, "ALPHA")) throw new Error("B leaked ALPHA");
console.log("✓ load B isolated");

ws.close();
console.log("\nSMOKE ISOLATION PASS");
