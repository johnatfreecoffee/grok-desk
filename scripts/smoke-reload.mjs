#!/usr/bin/env node
/**
 * P3 — `npm run smoke:reload`.
 *
 * Drop the WS mid-turn, reconnect and resubscribe at the cursor. Asserts
 * content, thinking and tools all survive and the turn completes.
 *
 * The turn is driven by writing a real session directory under a scratch
 * GROK_HOME, so the exact moment of the drop is deterministic and the same
 * bytes can be replayed: what is under test is the CLIENT projection and the
 * cursor, not the model. It runs against a real daemon on its own port and
 * uses the REAL store — `web/src/lib/sessionFeed.ts`.
 *
 * Lane 2 does the full-reload case: a brand new store hydrated from the
 * persisted cursor, resuming where the old one stopped.
 *
 * Usage: node --experimental-strip-types scripts/smoke-reload.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client, Scratch, loadFeedStore, reporter, sleep } from "./lib/feed-smoke-kit.mjs";

const r = reporter();
const scratch = new Scratch("p3reload");
let c1;
let c2;

/* ------------------------------------------------------ session writer */

const SID = `p3reload-${process.pid.toString(16)}-0000-0000-000000000001`;
const DIR = scratch.sessionDir(SID);
let seq = 0;

function upd(update) {
  seq += 1;
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: SID,
      update,
      _meta: { eventId: `${SID}-${seq}`, agentTimestampMs: Date.now() },
    },
  });
}

const text = (kind, t) => upd({ sessionUpdate: kind, content: { type: "text", text: t } });
const toolCall = (id, title, status, rawInput) =>
  upd({ sessionUpdate: "tool_call", toolCallId: id, title, kind: "execute", status, rawInput });
const toolDone = (id, out) =>
  upd({
    sessionUpdate: "tool_call_update",
    toolCallId: id,
    status: "completed",
    content: [{ type: "content", content: { type: "text", text: out } }],
  });
const evt = (type, extra = {}) => JSON.stringify({ ts: new Date().toISOString(), type, ...extra });

function appendUpdates(lines) {
  fs.appendFileSync(path.join(DIR, "updates.jsonl"), `${lines.join("\n")}\n`);
}
function appendEvents(lines) {
  fs.appendFileSync(path.join(DIR, "events.jsonl"), `${lines.join("\n")}\n`);
}

function makeSession() {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, "updates.jsonl"), "");
  fs.writeFileSync(path.join(DIR, "events.jsonl"), "");
  fs.writeFileSync(
    path.join(DIR, "summary.json"),
    JSON.stringify({
      info: { id: SID, cwd: scratch.cwd },
      created_at: new Date().toISOString(),
    }),
  );
}

const THINK_A = "First I should look at the file. ";
const THINK_B = "The command printed what I expected, so I can answer.";
const SAY_A = "Running the check now. ";
const SAY_B = "The command printed `hello-from-tool`, so the wiring is good.";
const TOOL_OUT = "hello-from-tool\n";

/* -------------------------------------------------------------- lane 1 */

try {
  console.log(`\nP3 reload smoke — scratch daemon, scratch GROK_HOME\n  home ${scratch.home}`);
  const feedmod = await loadFeedStore();
  const port = await scratch.startDaemon();
  console.log(`  daemon :${port}\n`);
  makeSession();

  console.log("1. subscribe, start a turn with thinking + a tool");
  c1 = new Client("A", port, feedmod);
  await c1.open();
  c1.subscribe(SID, scratch.cwd);
  await c1.wait((f) => f.type === "feed" && f.sessionId === SID && f.catchUp, 20_000, "catch-up");

  appendEvents([evt("turn_started", { turn_number: 1, model_id: "grok-smoke" })]);
  await sleep(20); // the CLI writes turn_started before the first chunk
  appendUpdates([
    text("user_message_chunk", "check the tool wiring"),
    text("agent_thought_chunk", THINK_A),
    text("agent_message_chunk", SAY_A),
    toolCall("t1", "run_terminal_cmd", "in_progress", { command: "echo hello-from-tool" }),
  ]);
  await c1.until(
    SID,
    (st) => st.messages.some((m) => m.tools?.some((t) => t.id === "t1")),
    20_000,
    "tool visible",
  );
  const cursor = c1.store.seqOf(SID);
  const midTools = c1.state(SID).messages.at(-1).tools;
  r.ok(`mid-turn: content "${SAY_A.trim()}" · thinking · tool ${midTools[0].status} · cursor ${cursor}`);
  assert.equal(c1.state(SID).turnEndSeq, 0, "turn must still be open");

  /* -- 2. yank the socket mid-turn, keep writing --------------------- */
  console.log("\n2. drop the WS mid-turn — the CLI keeps writing");
  c1.ws.terminate(); // hard close, no unsubscribe
  await sleep(400);
  appendUpdates([
    toolDone("t1", TOOL_OUT),
    text("agent_thought_chunk", THINK_B),
    text("agent_message_chunk", SAY_B),
  ]);
  appendEvents([
    evt("tool_completed", { tool_name: "run_terminal_cmd", tool_call_id: "t1", outcome: "ok" }),
    evt("turn_ended", { outcome: "completed" }),
  ]);
  appendUpdates([upd({ sessionUpdate: "turn_completed", stop_reason: "end_turn" })]);
  r.ok("socket down while the turn finished on disk");

  /* -- 3. reconnect and resubscribe at the cursor -------------------- */
  console.log("\n3. reconnect and resubscribe at the cursor");
  const store = c1.store; // same in-memory store, the way a WS flap works
  c2 = new Client("A'", port, feedmod);
  c2.store = store;
  await c2.open();
  assert.equal(c2.store.cursor(SID), cursor, "resume cursor is where we stopped");
  c2.subscribe(SID, scratch.cwd);
  await c2.until(SID, (st) => st.turnEndSeq > 0, 30_000, "turn_end after resume");
  r.check(c2.gaps === 0, "no gap on resume", `saw ${c2.gaps} gap(s)`);

  const st = c2.state(SID);
  const assistant = st.messages.filter((m) => m.role === "assistant");
  const users = st.messages.filter((m) => m.role === "user");
  const body = assistant.map((m) => m.content).join("");
  const thought = assistant.map((m) => m.thought || "").join("");
  const tools = assistant.flatMap((m) => m.tools || []);

  r.check(body === SAY_A + SAY_B, `content survived whole (${body.length} chars)`, `content was ${JSON.stringify(body)}`);
  r.check(
    thought === THINK_A + THINK_B,
    "thinking survived across the drop (both halves)",
    `thought was ${JSON.stringify(thought)}`,
  );
  r.check(tools.length === 1, `one tool row, not two (${tools.length})`, `${tools.length} tool rows`);
  r.check(tools[0]?.status === "completed", "tool status updated in place to completed", `status ${tools[0]?.status}`);
  r.check(tools[0]?.output?.includes("hello-from-tool"), "tool output survived", "tool output lost");
  r.check(users.length === 1, "one user row", `${users.length} user rows`);
  r.check(assistant.length === 1, "one assistant bubble, not split by the drop", `${assistant.length} bubbles`);
  r.check(st.turnEndSeq > 0, "the feed's turn_end finalized the turn", "turn never finalized");
  r.check(!assistant[0].streaming, "row is no longer streaming after turn_end", "row still streaming");

  /* -- 4. full page reload: hydrate from the persisted cursor -------- */
  console.log("\n4. full reload — new store, persisted cursor, resume in place");
  feedmod.persistFeed(st);
  const saved = feedmod.loadPersistedFeed(SID);
  r.check(saved?.seq === st.seq, `cursor ${saved?.seq} persisted`, `persisted ${saved?.seq}, live ${st.seq}`);
  const fresh = new feedmod.SessionFeedStore();
  fresh.hydrate(SID, saved.seq, saved.messages);
  r.check(
    fresh.get(SID).messages.length === st.messages.length,
    "a cold store repaints the chat from the cursor instead of starting blank",
    `cold store had ${fresh.get(SID).messages.length} rows, live had ${st.messages.length}`,
  );

  // A second turn after the reload must append, not duplicate.
  const c3 = new Client("A''", port, feedmod);
  c3.store = fresh;
  await c3.open();
  c3.subscribe(SID, scratch.cwd);
  await c3.wait((f) => f.type === "feed" && f.sessionId === SID && f.catchUp, 20_000, "cold catch-up");
  appendEvents([evt("turn_started", { turn_number: 2 })]);
  appendUpdates([
    text("user_message_chunk", "ok"),
    text("agent_message_chunk", "done"),
  ]);
  appendEvents([evt("turn_ended", { outcome: "completed" })]);
  await c3.until(SID, (s2) => s2.messages.some((m) => m.content === "done"), 30_000, "second turn");
  const after = c3.state(SID);
  r.check(
    after.messages.length === st.messages.length + 2,
    `second turn appended cleanly (${st.messages.length} → ${after.messages.length} rows)`,
    `rows went ${st.messages.length} → ${after.messages.length}`,
  );
  r.check(
    after.messages.filter((m) => m.role === "user").length === 2,
    "no duplicated user row after the reload",
    "user rows duplicated across the reload",
  );
  c3.close();
} catch (e) {
  r.fail();
  console.error("\nSMOKE ERROR:", e.message);
  console.error(scratch.daemonLog(25));
} finally {
  c1?.close();
  c2?.close();
  const left = scratch.survivorLines();
  await scratch.stop();
  const after = scratch.survivorLines();
  console.log(`\n  smoke process group before cleanup: ${left.length} process(es)`);
  for (const l of left) console.log(`    ${l.slice(0, 110)}`);
  console.log(`  after cleanup: ${after.length ? `STILL RUNNING\n    ${after.join("\n    ")}` : "none"}`);
  if (after.length) r.fail();
}

console.log("");
if (r.failures) {
  console.log(`SMOKE RELOAD FAIL — ${r.failures} failure(s)`);
  process.exit(1);
}
console.log("SMOKE RELOAD PASS");
process.exit(0);
