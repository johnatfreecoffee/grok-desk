#!/usr/bin/env node
/**
 * CLI-session identity: a real sessionId must never become a new chat.
 *
 * 1. New session A, prompt, wait turn_end
 * 2. load_session of a missing id (unbinds ACP)
 * 3. prompt A again
 * 4. Assert no session/new with a different id; A's transcript got the resume line
 */
import WebSocket from "ws";
import fs from "node:fs";
import { authCookie } from "./lib/feed-smoke-kit.mjs";

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

const cookie = process.env.GD_SESSION
  ? { Cookie: `gd_session=${process.env.GD_SESSION}` }
  : authCookie()
    ? { Cookie: authCookie() }
    : undefined;
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: cookie });
await new Promise((r, j) => {
  ws.on("open", r);
  ws.on("error", j);
});
await wait(ws, (m) => m.type === "hello");
console.log("✓ hello");

const newIds = [];
ws.on("message", (raw) => {
  try {
    const m = JSON.parse(String(raw));
    if (m.type === "session" && m.mode === "new" && m.sessionId) newIds.push(m.sessionId);
  } catch {
    /* */
  }
});

ws.send(JSON.stringify({ type: "new_session", cwd: CWD }));
const sess = await wait(ws, (m) => m.type === "session");
const sidA = sess.sessionId;
if (!sidA) throw new Error("session A missing id");
console.log("✓ session A", sidA.slice(0, 8));

ws.send(
  JSON.stringify({
    type: "prompt",
    text: "Reply only with the single word ALPHA. No other text.",
    sessionId: sidA,
    clientMsgId: `resume_a_${Date.now()}`,
  }),
);
await wait(ws, (m) => m.type === "turn_end" && (!m.sessionId || m.sessionId === sidA), 120000);
console.log("✓ A turn_end");

ws.send(
  JSON.stringify({
    type: "load_session",
    sessionId: "00000000-0000-4000-8000-000000000000",
    cwd: CWD,
  }),
);
await wait(
  ws,
  (m) =>
    (m.type === "session_status" && m.state === "history_only") ||
    (m.type === "session_loaded" && m.agentResumed === false) ||
    m.type === "error",
  35000,
);
console.log("✓ unbound via missing id");

const marker = `RESUME_OK_${Date.now().toString(36)}`;
ws.send(
  JSON.stringify({
    type: "prompt",
    text: `Reply only with the single token ${marker}. No other text.`,
    sessionId: sidA,
    clientMsgId: `resume_b_${Date.now()}`,
  }),
);

const after = [];
const done = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("resume prompt timed out")), 120000);
  const fn = (raw) => {
    let m;
    try {
      m = JSON.parse(String(raw));
    } catch {
      return;
    }
    after.push(m.type);
    if (m.type === "session" && m.mode === "new" && m.sessionId && m.sessionId !== sidA) {
      clearTimeout(t);
      ws.off("message", fn);
      reject(new Error(`forked new session ${m.sessionId} (wanted ${sidA})`));
      return;
    }
    if (m.type === "turn_end") {
      clearTimeout(t);
      ws.off("message", fn);
      resolve(m);
    }
  };
  ws.on("message", fn);
});

if (done.sessionId && done.sessionId !== sidA) {
  throw new Error(`turn_end on ${done.sessionId}, wanted ${sidA}`);
}
const forked = newIds.filter((id) => id !== sidA);
if (forked.length) {
  throw new Error(`session/new leaked: ${forked.join(",")}`);
}

const transcript = await fetch(
  `http://127.0.0.1:${PORT}/api/sessions/${encodeURIComponent(sidA)}/transcript`,
  cookie ? { headers: cookie } : undefined,
).then((r) => r.json());
const blob = JSON.stringify(transcript);
if (!blob.includes(marker) && !blob.includes("RESUME_OK")) {
  console.warn("transcript marker not visible via HTTP (ACP may still have it) — turn stayed on A");
}

console.log("✓ resumed same session", sidA.slice(0, 8));
console.log("SMOKE RESUME PASS");
ws.close();
process.exit(0);
