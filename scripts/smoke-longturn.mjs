#!/usr/bin/env node
/**
 * P5 — `npm run smoke:longturn`. **No turn is ever killed by a Desk timer.**
 *
 * Desk used to end healthy turns three different ways:
 *
 *   1. an 18-minute WALL watchdog     → `abandonTurn({restart:true})`
 *   2. a 6-minute STALL watchdog      → `abandonTurn({restart:true})`
 *   3. a 10-minute ACP RPC timeout on `session/prompt`, which fired FIRST
 *
 * All three are gone. This proves it two ways:
 *
 *   A. statically — the shipping daemon carries no auto-abandon timer, and the
 *      prompt RPC is sent with no timeout at all;
 *   B. live — a real turn on a real daemon, longer than 18 minutes, with the
 *      OLD environment knobs (`DESK_TURN_WALL_MS`, `DESK_TURN_STALL_MS`) set to
 *      a few seconds. Under the old code those knobs would have abandoned the
 *      turn and restarted the agent within seconds. The turn must complete,
 *      un-abandoned, on the same agent process it started on.
 *
 * The "agent" is a stub ACP process (`GROK_BIN`), so the wall-clock proof costs
 * no tokens and is deterministic. It writes a real session directory, so the
 * feed projects the turn the same way it projects the CLI's.
 *
 * Everything is throwaway: own port, own GROK_HOME, own project cwd under
 * os.tmpdir(). It never touches ~/.grok/sessions and never talks to :8787.
 *
 * Usage:
 *   node scripts/smoke-longturn.mjs              # the real 18m+ proof (~19 min)
 *   LONGTURN_MS=20000 node scripts/smoke-longturn.mjs   # quick shape check
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client, ROOT, Scratch, loadFeedStore, reporter, sleep } from "./lib/feed-smoke-kit.mjs";

/** How long the stub agent takes to answer. Default: past the old 18m wall. */
const TURN_MS = Number(process.env.LONGTURN_MS || 19 * 60 * 1000);
/** The old wall watchdog, in ms — the bar the live lane has to clear. */
const OLD_WALL_MS = 18 * 60 * 1000;

const r = reporter();
const scratch = new Scratch("p5long");
let client;

/* ------------------------------------------------------- A. static proof */

function staticProof() {
  const index = fs.readFileSync(path.join(ROOT, "daemon/index.js"), "utf8");
  const bridge = fs.readFileSync(path.join(ROOT, "daemon/acp-bridge.js"), "utf8");

  for (const dead of [
    "TURN_WALL_MS",
    "TURN_STALL_MS",
    "armTurnWatchdogs",
    "clearTurnWatchdogs",
    "wall_timeout",
    "stall_timeout",
  ]) {
    // The word may only survive inside a comment explaining the removal.
    const live = index
      .split("\n")
      .filter((l) => l.includes(dead) && !/^\s*(\*|\/\/|\/\*)/.test(l));
    assert.equal(live.length, 0, `${dead} is still live code in daemon/index.js`);
  }
  r.ok("daemon/index.js has no wall / stall watchdog left");

  // Every abandonTurn call must be reachable from a user action, never a timer.
  const timerAbandon = /setTimeout\(([\s\S]{0,400}?)abandonTurn/.exec(index);
  assert.equal(timerAbandon, null, "a setTimeout still calls abandonTurn");
  r.ok("no setTimeout in the daemon calls abandonTurn");

  const promptRpc = /"session\/prompt",[\s\S]{0,600}?\n\s*(?:\/\/[^\n]*\n\s*)*0,\n\s*\);/.exec(
    bridge,
  );
  assert.ok(promptRpc, "session/prompt no longer passes 0 (no timeout) to request()");
  const liveTenMinutes = bridge
    .split("\n")
    .filter((l) => /600000|600_000/.test(l) && !/^\s*(\*|\/\/|\/\*)/.test(l));
  assert.equal(
    liveTenMinutes.length,
    0,
    "the 10-minute session/prompt RPC timeout is still live in acp-bridge.js",
  );
  r.ok("session/prompt is sent with NO rpc timeout (was 600_000 ms)");
}

/* --------------------------------------------------- the stub ACP agent */

/**
 * A `grok agent stdio` stand-in.
 *
 * Speaks the slice of ACP the bridge uses (`initialize`, `session/new`,
 * `session/prompt`), writes a real session directory, and takes TURN_MS to
 * answer — silently, so the stall watchdog would have had every excuse to fire.
 */
function writeStubAgent(binPath, turnMs) {
  const src = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const TURN_MS = ${turnMs};
const HOME = process.env.GROK_HOME;
let dir = null;
let sessionId = null;

const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const now = () => new Date().toISOString();

function appendUpdate(obj) {
  if (!dir) return;
  fs.appendFileSync(path.join(dir, "updates.jsonl"), JSON.stringify(obj) + "\\n");
}
function appendEvent(obj) {
  if (!dir) return;
  fs.appendFileSync(path.join(dir, "events.jsonl"), JSON.stringify(obj) + "\\n");
}

let seq = 0;
const meta = () => ({ eventId: \`ev_\${++seq}\`, timestamp: now() });

readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    return;
  }
  if (msg.method === "session/new") {
    sessionId = \`01a0\${Date.now().toString(16)}-0000-7000-8000-\${process.pid.toString().padStart(12, "0")}\`;
    const cwd = msg.params?.cwd || process.cwd();
    dir = path.join(HOME, "sessions", encodeURIComponent(cwd), sessionId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "summary.json"),
      JSON.stringify({ id: sessionId, cwd, title: "long turn", created_at: now() }),
    );
    fs.writeFileSync(path.join(dir, "updates.jsonl"), "");
    fs.writeFileSync(path.join(dir, "events.jsonl"), "");
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId } });
    return;
  }
  if (msg.method === "session/prompt") {
    const text = (msg.params?.prompt || []).map((b) => b.text || "").join("");
    appendUpdate({ _meta: meta(), sessionUpdate: "user_message_chunk", content: { type: "text", text } });
    appendEvent({ _meta: meta(), type: "turn_started", timestamp: now() });
    // Silence for the whole turn: exactly what the stall watchdog killed.
    await new Promise((res) => setTimeout(res, TURN_MS));
    const reply = "done after " + Math.round(TURN_MS / 1000) + "s";
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply } } },
    });
    appendUpdate({ _meta: meta(), sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply } });
    appendEvent({ _meta: meta(), type: "turn_ended", timestamp: now() });
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    return;
  }
  if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, result: {} });
});
`;
  fs.writeFileSync(binPath, src);
  fs.chmodSync(binPath, 0o755);
}

/* ------------------------------------------------------------------ run */

try {
  console.log("\nP5 long-turn smoke — no Desk timer may end a turn\n");
  if (process.env.LONGTURN_SKIP_STATIC === "1") {
    console.log("A. static — SKIPPED (negative-control run against the old code)");
  } else {
    console.log("A. static — the timers are gone from the code that ships");
    staticProof();
  }

  console.log(`\nB. live — one turn of ${Math.round(TURN_MS / 1000)}s on a scratch daemon`);
  const stub = path.join(scratch.root, "grok");
  writeStubAgent(stub, TURN_MS);
  // The OLD knobs, set absurdly low. If anything still reads them the turn dies.
  process.env.GROK_BIN = stub;
  process.env.DESK_TURN_WALL_MS = "5000";
  process.env.DESK_TURN_STALL_MS = "3000";
  const port = await scratch.startDaemon();
  console.log(`  daemon :${port}  ·  stub agent ${stub}`);
  console.log(`  DESK_TURN_WALL_MS=5000  DESK_TURN_STALL_MS=3000 (both dead)\n`);

  client = new Client("long", port, await loadFeedStore());
  await client.open();

  client.send({ type: "new_session", cwd: scratch.cwd });
  const sess = await client.wait((f) => f.type === "session" && f.sessionId, 60_000, "session");
  const sid = sess.sessionId;
  client.subscribe(sid, scratch.cwd);
  r.ok(`session ${sid.slice(0, 8)}`);

  const startedAt = Date.now();
  client.send({ type: "prompt", sessionId: sid, text: "take your time", clientMsgId: `lt_${startedAt}` });
  await client.wait((f) => f.type === "turn_start" && f.sessionId === sid, 60_000, "turn_start");
  r.ok("turn started");

  // Anything that ends this turn early is a failure — including a restart.
  const deadline = TURN_MS + 120_000;
  const end = await client.wait(
    (f) => f.type === "turn_end" && f.sessionId === sid,
    deadline,
    "turn_end",
  );
  const elapsed = Date.now() - startedAt;

  assert.equal(Boolean(end.abandoned), false, `turn was abandoned: ${end.reason || "?"}`);
  assert.ok(
    !["wall_timeout", "stall_timeout", "restart"].includes(String(end.reason || "")),
    `turn ended by a timer: ${end.reason}`,
  );
  assert.equal(Boolean(end.error), false, `turn ended in error: ${end.reason || "?"}`);
  r.ok(
    `turn ran ${Math.round(elapsed / 1000)}s and ended clean (abandoned=false, reason=${end.reason ?? "none"})`,
  );

  const restarted = client.frames.filter((f) => f.type === "agent_exit").length;
  assert.equal(restarted, 0, "the agent process was restarted mid-turn");
  r.ok("the agent process was never restarted mid-turn");

  if (TURN_MS >= OLD_WALL_MS) {
    assert.ok(
      elapsed > OLD_WALL_MS,
      `turn only ran ${elapsed} ms — needs to beat the old ${OLD_WALL_MS} ms wall`,
    );
    r.ok(`> 18 minutes (${(elapsed / 60000).toFixed(1)} min) and untouched — the headline`);
  } else {
    console.log(
      `  · short run (LONGTURN_MS=${TURN_MS}) — shape proven, wall-clock lane skipped`,
    );
  }
} catch (e) {
  r.fail();
  console.error("\nSMOKE ERROR:", e.message);
  console.error(scratch.daemonLog(40));
} finally {
  try {
    client?.close();
  } catch {
    /* */
  }
  await sleep(200);
  const left = scratch.survivorLines();
  await scratch.stop();
  const after = scratch.survivorLines();
  console.log(`\n  smoke process group before cleanup: ${left.length} process(es)`);
  for (const l of left) console.log(`    ${l.slice(0, 110)}`);
  console.log(
    `  after cleanup: ${after.length ? `STILL RUNNING\n    ${after.join("\n    ")}` : "none"}`,
  );
  if (after.length) r.fail();
}

console.log("");
if (r.failures) {
  console.log(`SMOKE LONGTURN FAIL — ${r.failures} failure(s)`);
  process.exit(1);
}
console.log("SMOKE LONGTURN PASS");
process.exit(0);
