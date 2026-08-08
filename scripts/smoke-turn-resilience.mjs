#!/usr/bin/env node
/**
 * Turn resilience smoke — WS flap + HTTP truth + final turn_end.
 * Usage: node scripts/smoke-turn-resilience.mjs
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
    const t = setTimeout(() => reject(new Error("timeout waiting for message")), ms);
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

async function fetchTurn() {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/turn`);
  if (!r.ok) throw new Error("GET /api/turn failed");
  return r.json();
}

// --- T0: idle snapshot ---
const idle = await fetchTurn();
if (typeof idle.turnActive !== "boolean") throw new Error("turnActive missing");
if (typeof idle.turnEpoch !== "number") throw new Error("turnEpoch missing");
console.log("✓ GET /api/turn", { turnActive: idle.turnActive, epoch: idle.turnEpoch });

// --- T1: connect + hello parity ---
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
await new Promise((r, j) => {
  ws.on("open", r);
  ws.on("error", j);
});
const hello = await wait(ws, (m) => m.type === "hello");
if (!("turnActive" in hello) || !("turnEpoch" in hello)) {
  throw new Error("hello missing turn snapshot fields");
}
console.log("✓ hello snapshot");

// --- T2: new session + prompt ---
ws.send(JSON.stringify({ type: "new_session", cwd: CWD }));
const sess = await wait(ws, (m) => m.type === "session");
const sid = sess.sessionId;
console.log("✓ session", sid.slice(0, 8));

ws.send(
  JSON.stringify({
    type: "prompt",
    text: "Reply with exactly: RESILIENCE_OK",
    sessionId: sid,
    clientMsgId: `resil_${Date.now()}`,
  }),
);
await wait(ws, (m) => m.type === "turn_start");
console.log("✓ turn_start");

// Mid-turn: status should show active
ws.send(JSON.stringify({ type: "status" }));
const st = await wait(ws, (m) => m.type === "status");
if (!st.turnActive) throw new Error("expected turnActive mid-turn");
if (!st.activeSessionId) throw new Error("expected activeSessionId mid-turn");
console.log("✓ status mid-turn", st.activeSessionId.slice(0, 8));

const mid = await fetchTurn();
if (!mid.turnActive) throw new Error("HTTP turn inactive mid-turn");
console.log("✓ HTTP /api/turn mid-turn");

// --- T3: drop WS, server continues; new client gets hello ---
ws.close();
await new Promise((r) => setTimeout(r, 400));

const ws2 = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
await new Promise((r, j) => {
  ws2.on("open", r);
  ws2.on("error", j);
});
const hello2 = await wait(ws2, (m) => m.type === "hello", 15000);
// May still be active or already finished
console.log("✓ reconnect hello turnActive=", hello2.turnActive);

// Wait for natural end (or already ended)
if (hello2.turnActive) {
  await wait(ws2, (m) => m.type === "turn_end", 180000);
  console.log("✓ turn_end after reconnect");
} else {
  console.log("✓ turn already finished before reconnect");
}

const done = await fetchTurn();
if (done.turnActive) throw new Error("still active after turn end");
console.log("✓ HTTP idle after end");

// --- T4: status idle ---
ws2.send(JSON.stringify({ type: "status" }));
const st2 = await wait(ws2, (m) => m.type === "status");
if (st2.turnActive) throw new Error("status still active");
console.log("✓ status idle");

ws2.close();
console.log("\nSMOKE TURN RESILIENCE PASS");
process.exit(0);
