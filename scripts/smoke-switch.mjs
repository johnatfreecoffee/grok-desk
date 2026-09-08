#!/usr/bin/env node
/**
 * P3 — `npm run smoke:switch`.
 *
 * Prompt A, leave A mid-turn, open B, prompt B, return to A mid-turn.
 * Asserts A's stream is complete and still running, and B is unaffected.
 *
 * Real ACP turns on a throwaway daemon (own port, own GROK_HOME, own cwd) and
 * the REAL client store — `web/src/lib/sessionFeed.ts`, the same code App.tsx
 * renders from. Nothing here touches ~/.grok/sessions or the daemon on :8787.
 *
 * Usage: node --experimental-strip-types scripts/smoke-switch.mjs
 */
import assert from "node:assert/strict";
import {
  Client,
  Scratch,
  diskAssistantText,
  loadFeedStore,
  reporter,
  sleep,
} from "./lib/feed-smoke-kit.mjs";

const LONG =
  "Write about 400 words on the history of the number zero. Prose only, " +
  "no tools, no lists. Take your time and be thorough.";
const SHORT = "In one short sentence, say what a semicolon is for. No tools.";

const r = reporter();
const scratch = new Scratch("p3switch");
let client;

try {
  console.log(`\nP3 switch smoke — scratch daemon, scratch GROK_HOME\n  home ${scratch.home}`);
  const feedmod = await loadFeedStore();
  const port = await scratch.startDaemon();
  console.log(`  daemon :${port}\n`);

  client = new Client("desk", port, feedmod);
  await client.open();

  /* -- 1. A: start a long turn ------------------------------------------ */
  console.log("1. prompt A");
  client.send({ type: "new_session", cwd: scratch.cwd });
  const sessA = await client.wait((f) => f.type === "session" && f.sessionId, 120_000, "session A");
  const A = sessA.sessionId;
  client.subscribe(A, scratch.cwd);
  await client.wait((f) => f.type === "feed" && f.sessionId === A && f.catchUp, 20_000, "A catch-up");
  client.send({ type: "prompt", sessionId: A, text: LONG, clientMsgId: `sw_a_${Date.now()}` });
  await client.wait((f) => f.type === "turn_start" && f.sessionId === A, 120_000, "turn_start A");
  r.ok(`A live — ${A.slice(0, 8)}`);
  // The feed must show A's turn opening from disk, not from the WS turn frame.
  await client.until(A, (st) => st.turn != null || st.live, 60_000, "A turn on disk");
  r.ok("A's turn is visible in the feed (disk truth, not a client guess)");

  /* -- 2. leave A mid-turn, open B, prompt B ---------------------------- */
  console.log("\n2. leave A mid-turn, open B, prompt B");
  const aSeqOnLeave = client.store.seqOf(A);
  const aEndOnLeave = client.state(A).turnEndSeq;
  assert.equal(aEndOnLeave, 0, "A must still be mid-turn when we leave");
  r.ok(`left A at cursor ${aSeqOnLeave}, no turn_end yet (still running)`);

  // App.tsx keeps a working session subscribed while you read another chat.
  client.send({ type: "dispatch", cwd: scratch.cwd, text: SHORT, clientMsgId: `sw_b_${Date.now()}` });
  const sessB = await client.wait(
    (f) => f.type === "session" && f.sessionId && f.sessionId !== A,
    120_000,
    "session B",
  );
  const B = sessB.sessionId;
  client.subscribe(B, scratch.cwd);
  await client.wait((f) => f.type === "feed" && f.sessionId === B, 30_000, "B feed");
  r.ok(`B open on a parallel worker — ${B.slice(0, 8)}`);
  assert.notEqual(A, B);

  /* -- 3. return to A mid-turn ------------------------------------------ */
  console.log("\n3. return to A mid-turn (unsubscribe → resubscribe at the cursor)");
  client.unsubscribe(A);
  await client.wait((f) => f.type === "unsubscribed" && f.sessionId === A, 15_000, "A unsubscribed");
  await sleep(700);
  const beforeReturn = client.since();
  client.subscribe(A, scratch.cwd);
  await client.wait(
    (f) => f.type === "feed" && f.sessionId === A && f.catchUp,
    20_000,
    "A catch-up on return",
    beforeReturn,
  );
  r.check(
    client.gaps === 0,
    "no gap on resume — the cursor lined up",
    `saw ${client.gaps} gap(s):\n      ${client.gapLog.join("\n      ")}`,
  );
  const stA = client.state(A);
  r.check(
    stA.turnEndSeq === 0,
    "A is STILL running after the round trip (no turn_end yet)",
    "A's turn had already ended — the essay finished before we came back; rerun",
  );

  /* -- 4. both turns land, nothing crossed ------------------------------ */
  console.log("\n4. both turns complete");
  await client.until(A, (st) => st.turnEndSeq > 0, 240_000, "A turn_end from the feed");
  await client.until(B, (st) => st.turnEndSeq > 0, 240_000, "B turn_end from the feed");

  const aText = client.assistantText(A);
  const bText = client.assistantText(B);
  const aDisk = diskAssistantText(scratch.sessionDir(A));
  const bDisk = diskAssistantText(scratch.sessionDir(B));

  r.check(
    aText.replace(/\s+/g, " ").trim() === aDisk.replace(/\s+/g, " ").trim() && aDisk.length > 200,
    `A's projected stream equals A's updates.jsonl (${aText.length} chars)`,
    `A projection ${aText.length} chars vs disk ${aDisk.length} chars — content lost`,
  );
  r.check(
    bText.replace(/\s+/g, " ").trim() === bDisk.replace(/\s+/g, " ").trim() && bDisk.length > 0,
    `B's projected stream equals B's updates.jsonl (${bText.length} chars)`,
    `B projection ${bText.length} chars vs disk ${bDisk.length} chars`,
  );
  const aKey = aText.slice(0, 80);
  const bKey = bText.slice(0, 40);
  r.check(
    aKey.length > 0 && bKey.length > 0 && !bText.includes(aKey) && !aText.includes(bKey),
    "B carries none of A's text and A carries none of B's",
    "content crossed between sessions",
  );

  const aUsers = client.state(A).messages.filter((m) => m.role === "user");
  const bUsers = client.state(B).messages.filter((m) => m.role === "user");
  r.check(
    aUsers.length === 1 && bUsers.length === 1,
    `one user row each (A ${aUsers.length}, B ${bUsers.length}) — no duplicates across the switch`,
    `A had ${aUsers.length} user rows, B had ${bUsers.length}`,
  );
  r.check(
    aUsers[0]?.content?.includes("number zero") && bUsers[0]?.content?.includes("semicolon"),
    "each chat kept its own prompt",
    `A user row: ${JSON.stringify(aUsers[0]?.content?.slice(0, 60))}`,
  );

  // Idempotency over the wire: replaying every frame changes nothing.
  const replay = new feedmod.SessionFeedStore();
  for (const f of client.frames) if (f.type === "feed" && f.sessionId) replay.applyFeed(f.sessionId, f);
  for (const f of client.frames) if (f.type === "feed" && f.sessionId) replay.applyFeed(f.sessionId, f);
  r.check(
    replay.get(A)?.messages.length === client.state(A).messages.length &&
      replay.get(B)?.messages.length === client.state(B).messages.length,
    "replaying every frame twice reproduces the same transcript (idempotent)",
    "replay diverged from the live projection",
  );
} catch (e) {
  r.fail();
  console.error("\nSMOKE ERROR:", e.message);
  console.error(scratch.daemonLog(25));
} finally {
  client?.close();
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
  console.log(`SMOKE SWITCH FAIL — ${r.failures} failure(s)`);
  process.exit(1);
}
console.log("SMOKE SWITCH PASS");
process.exit(0);
