#!/usr/bin/env node
/**
 * Grok Desk session-survival smoke harness
 * Usage: node scripts/smoke-desk.mjs
 */
import WebSocket from "ws";
import fs from "node:fs";

const PORT = process.env.PORT || 8787;
// Neutral cwd — avoids heavy project-context injection during short smokes.
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

function waitTurnEnd(ws, ms = 120000) {
  return wait(ws, (m) => m.type === "turn_end", ms);
}

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
await new Promise((r, j) => {
  ws.on("open", r);
  ws.on("error", j);
});
await wait(ws, (m) => m.type === "hello");
console.log("✓ hello");

ws.send(JSON.stringify({ type: "new_session", cwd: CWD }));
const sess = await wait(ws, (m) => m.type === "session");
const sid = sess.sessionId;
console.log("✓ session", sid.slice(0, 8));

ws.send(
  JSON.stringify({
    type: "prompt",
    text: "Reply only: SMOKE1",
    sessionId: sid,
    clientMsgId: `smoke_${Date.now()}`,
  }),
);
await wait(ws, (m) => m.type === "turn_start");

const projects = await fetch(`http://127.0.0.1:${PORT}/api/projects`).then((r) => r.json());
const other = (projects.projects || [])
  .flatMap((p) => p.sessions || [])
  .find((s) => s.id !== sid);
if (other) {
  ws.send(
    JSON.stringify({
      type: "load_session",
      sessionId: other.id,
      cwd: other.cwd,
      viewOnly: true,
    }),
  );
  const loaded = await wait(ws, (m) => m.type === "session_loaded", 15000);
  if (!loaded.viewOnly) throw new Error("expected viewOnly");
  console.log("✓ viewOnly mid-turn");
} else {
  console.log("✓ viewOnly skip (no other session)");
}

const end1 = await waitTurnEnd(ws);
if (end1.abandoned) throw new Error("turn abandoned during viewOnly");
console.log("✓ turn1 complete");

ws.send(
  JSON.stringify({
    type: "prompt",
    text: "Reply only: SMOKE2",
    sessionId: sid,
    clientMsgId: `smoke2_${Date.now()}`,
  }),
);
await wait(ws, (m) => m.type === "turn_start");
await waitTurnEnd(ws);
console.log("✓ multi-turn");

// queue two follow-ups while first is in flight — attach listener first
const qaId = `qa_${Date.now()}`;
const qbId = `qb_${Date.now() + 1}`;
let ends = 0;
let starts = 0;
let queuedSeen = false;
const queueDone = new Promise((resolve, reject) => {
  const t = setTimeout(
    () => reject(new Error(`queue timeout (starts=${starts} ends=${ends} queued=${queuedSeen})`)),
    180000,
  );
  const fn = (raw) => {
    let m;
    try {
      m = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (m.type === "turn_start") {
      starts += 1;
      console.log(`  … turn_start ${starts}`);
    }
    if (m.type === "queued") {
      queuedSeen = true;
      console.log("  … queued", m.remaining, m.text?.slice?.(0, 20));
    }
    if (m.type === "turn_end") {
      ends += 1;
      console.log(`  … turn_end ${ends}/2`);
      if (ends >= 2) {
        clearTimeout(t);
        ws.off("message", fn);
        resolve();
      }
    }
  };
  ws.on("message", fn);
});

ws.send(
  JSON.stringify({
    type: "prompt",
    text: "Reply only: QA",
    sessionId: sid,
    clientMsgId: qaId,
  }),
);
// tiny delay so QA can claim busy; QB must enqueue
await new Promise((r) => setTimeout(r, 50));
ws.send(
  JSON.stringify({
    type: "prompt",
    text: "Reply only: QB",
    sessionId: sid,
    clientMsgId: qbId,
  }),
);

await queueDone;
if (!queuedSeen) console.log("  … note: QB may have run without queue (idle race)");
console.log("✓ queue 2 prompts");

ws.send(JSON.stringify({ type: "ping" }));
await wait(ws, (m) => m.type === "pong", 5000);
console.log("✓ ping/pong");

console.log("\nSMOKE PASS");
ws.close();
process.exit(0);
