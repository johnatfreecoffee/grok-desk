#!/usr/bin/env node
/**
 * Feed projector unit tests — `npm run test:feed`.
 *
 * Runs with NO live daemon and touches nothing outside a temp dir:
 * scripts/fixtures/feed is copied to os.tmpdir() and GROK_HOME is pointed at
 * the copy, so the real ~/.grok is never read or written.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, "fixtures", "feed");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "grok-desk-feed-"));
fs.cpSync(FIXTURES, HOME, { recursive: true });
process.env.GROK_HOME = HOME;

const feed = await import(
  new URL("../daemon/session-feed.js", import.meta.url).href
);
const {
  read,
  subscribe,
  unsubscribe,
  poll,
  forget,
  sessionOwner,
  cursorOf,
  resetOwnerCache,
  ownerCoverage,
} = feed;
const { cwdKeyCandidates, findSessionDir } = await import(
  new URL("../daemon/session-store.js", import.meta.url).href
);

const PROJECT = "%2Ffixtures%2Ffeed-project";
const A = "fixa-1111-2222-3333-444444444444";
const B = "fixb-1111-2222-3333-444444444444";
const dirA = path.join(HOME, "sessions", PROJECT, A);

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log("  ok", name);
}

const kinds = (r) => r.events.map((e) => e.kind);
const seqs = (r) => r.events.map((e) => e.seq);
/** Identity for comparing two projections event-for-event. */
const shape = (e) => JSON.stringify(e);

function writeActive(rows) {
  fs.writeFileSync(
    path.join(HOME, "active_sessions.json"),
    JSON.stringify(rows, null, 2),
  );
}

/* --------------------------------------------------- ownership fixtures */
/*
 * P4 verifies that a registry pid really is a `grok` CLI, so the tests need a
 * live process whose executable is named `grok` and one that is not. A SYMLINK
 * to /bin/sleep named `grok` gives `ps -o comm=` the right answer without
 * running the real CLI, spending a token, or touching ~/.grok. (A copy will not
 * do: macOS code-signing enforcement SIGKILLs an unsigned copy of a platform
 * binary a moment after it starts.)
 */
const binDir = path.join(HOME, "bin");
fs.mkdirSync(binDir, { recursive: true });
const fakeGrokBin = path.join(binDir, "grok");
fs.symlinkSync("/bin/sleep", fakeGrokBin);
const fakeGrok = spawn(fakeGrokBin, ["600"], { stdio: "ignore" });
fakeGrok.unref();
const killFakeGrok = () => {
  try {
    process.kill(fakeGrok.pid, "SIGKILL");
  } catch {
    /* already gone */
  }
};
process.on("exit", killFakeGrok);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(1));
// ps must actually see it before any probe runs.
for (let i = 0; i < 100; i += 1) {
  const out = execFileSync("ps", ["-p", String(fakeGrok.pid), "-o", "comm="], {
    encoding: "utf8",
  }).trim();
  if (out) break;
  await new Promise((r) => setTimeout(r, 20));
}

/**
 * A symlinked project cwd, so the `/tmp` ↔ `/private/tmp` skew is a real
 * condition in the test rather than a hypothetical. The session directory is
 * keyed by the REAL path; lookups arrive with the symlinked spelling.
 */
const symlinkSession = "sym0-1111-2222-3333-444444444444";
const realProj = path.join(HOME, "real-proj");
const symlinkCwd = path.join(HOME, "link-proj");
fs.mkdirSync(realProj, { recursive: true });
fs.symlinkSync(realProj, symlinkCwd);
const symlinkDir = path.join(
  HOME,
  "sessions",
  encodeURIComponent(fs.realpathSync(realProj)),
  symlinkSession,
);
fs.mkdirSync(symlinkDir, { recursive: true });
fs.writeFileSync(path.join(symlinkDir, "updates.jsonl"), "");

/** Snapshot every file under a dir so we can prove the projector never writes. */
function snapshotTree(dir) {
  const out = {};
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else {
        const s = fs.statSync(p);
        out[p] = `${s.size}:${s.mtimeMs}`;
      }
    }
  };
  walk(dir);
  return out;
}

/** A throwaway session dir we can append to / truncate. */
function scratchSession(id, updatesLines, eventsLines = []) {
  const dir = path.join(HOME, "sessions", PROJECT, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "updates.jsonl"),
    updatesLines.length ? updatesLines.join("\n") + "\n" : "",
  );
  fs.writeFileSync(
    path.join(dir, "events.jsonl"),
    eventsLines.length ? eventsLines.join("\n") + "\n" : "",
  );
  forget(id);
  return dir;
}

const T0 = 1787000000000;
const upLine = (id, offsetMs, evNum, update) =>
  JSON.stringify({
    timestamp: Math.floor((T0 + offsetMs) / 1000),
    method: "session/update",
    params: {
      sessionId: id,
      update,
      _meta: {
        agentTimestampMs: T0 + offsetMs,
        ...(evNum == null ? {} : { eventId: `${id}-${evNum}` }),
      },
    },
  });
const msg = (text) => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text },
});
const evLine = (offsetMs, row) =>
  JSON.stringify({ ts: new Date(T0 + offsetMs).toISOString(), ...row });

console.log("feed projector unit tests");
console.log("  GROK_HOME =", HOME);

/* ------------------------------------------------ 1. normalize + ordering */

const beforeTree = snapshotTree(dirA);
const full = read(A);

test("read() projects both logs into one ordered feed", () => {
  assert.equal(full.ok, true);
  assert.equal(full.sessionId, A);
  assert.equal(full.cwd, "/fixtures/feed-project");
  assert.equal(full.events.length, 22, `got ${full.events.length} events`);
  assert.deepEqual(kinds(full), [
    "turn_start",
    "user_message",
    "phase",
    "agent_thought",
    "phase",
    "agent_message",
    "other", // first_token telemetry — passed through, never dropped
    "tool_call",
    "tool_status",
    "permission_request",
    "permission_resolve",
    "tool_call_update",
    "tool_status",
    "plan",
    "subagent_start",
    "subagent_finish",
    "task_backgrounded",
    "agent_message",
    "other", // quantum_flux — unknown sessionUpdate
    "agent_message",
    "turn_completed",
    "turn_end",
  ]);
  // interleaved strictly by timestamp
  const ats = full.events.map((e) => e.at);
  for (let i = 1; i < ats.length; i += 1) {
    assert.ok(ats[i] >= ats[i - 1], `timestamps out of order at ${i}`);
  }
});

test("every event carries seq, at, sessionId, kind, src", () => {
  for (const e of full.events) {
    assert.equal(typeof e.seq, "number");
    assert.equal(typeof e.at, "number");
    assert.equal(e.sessionId, A);
    assert.equal(typeof e.kind, "string");
    assert.ok(e.src === "updates" || e.src === "events");
  }
});

test("seq is strictly monotonic with no duplicates", () => {
  const s = seqs(full);
  assert.equal(new Set(s).size, s.length, "duplicate seq");
  for (let i = 1; i < s.length; i += 1) {
    assert.ok(s[i] > s[i - 1], `seq went backwards at ${i}: ${s[i - 1]} -> ${s[i]}`);
  }
  assert.equal(full.seq, s[s.length - 1]);
});

test("seq comes from the _meta.eventId suffix", () => {
  const user = full.events.find((e) => e.kind === "user_message");
  assert.equal(user.seq, 1000, "eventId suffix 1000 should become seq 1000");
  assert.equal(user.text, "Fix the build");
});

test("a backwards eventId is clamped forward, never rewound", () => {
  // fixture line 12 has eventId suffix 1390 after 1400 was already issued
  const shipped = full.events.find((e) => e.text === " Shipped.");
  assert.equal(shipped.seq, 1401);
});

test("a missing eventId falls back to the running counter", () => {
  const done = full.events.find((e) => e.text === " Done.");
  assert.equal(done.seq, 1321);
});

test("unknown sessionUpdate kinds survive as kind:'other' with raw", () => {
  const other = full.events.find((e) => e.type === "quantum_flux");
  assert.ok(other, "quantum_flux was dropped");
  assert.equal(other.kind, "other");
  assert.equal(other.src, "updates");
  assert.deepEqual(other.raw.payload, { note: "unknown to Desk" });
});

test("tool call, status and output are normalized", () => {
  const call = full.events.find((e) => e.kind === "tool_call");
  assert.equal(call.toolCallId, "call-fix-0");
  assert.equal(call.status, "pending");
  assert.equal(call.toolKind, "read");
  const upd = full.events.find((e) => e.kind === "tool_call_update");
  assert.equal(upd.toolCallId, "call-fix-0");
  assert.equal(upd.status, "completed");
  assert.match(upd.output, /exit 1/);
  const started = full.events.find((e) => e.kind === "tool_status" && e.phase === "started");
  const done = full.events.find((e) => e.kind === "tool_status" && e.phase === "completed");
  assert.equal(started.tool, "read_file");
  assert.equal(done.durationMs, 90);
  assert.equal(done.outcome, "success");
});

test("plan, permission and turn frames are normalized", () => {
  const plan = full.events.find((e) => e.kind === "plan");
  assert.equal(plan.entries.length, 2);
  assert.equal(plan.entries[1].status, "in_progress");
  const req = full.events.find((e) => e.kind === "permission_request");
  assert.equal(req.tool, "read_file");
  const res = full.events.find((e) => e.kind === "permission_resolve");
  assert.equal(res.decision, "allow");
  const start = full.events.find((e) => e.kind === "turn_start");
  assert.equal(start.modelId, "grok-4.6");
  assert.equal(full.events.find((e) => e.kind === "turn_end").outcome, "success");
});

/* ------------------------------------------------------ 2. derived state */

test("live is false after turn_ended; phase is the last phase_changed", () => {
  assert.equal(full.live, false);
  assert.equal(full.phase, "streaming_reasoning");
  assert.equal(full.turn.number, 1);
  assert.equal(full.turn.outcome, "success");
});

test("live is true between turn_started and turn_ended", () => {
  const live = read(B);
  assert.equal(live.ok, true);
  assert.equal(live.live, true);
  assert.equal(live.phase, "streaming_reasoning");
  assert.equal(live.turn.yoloMode, true);
});

test("context comes from signals.json", () => {
  assert.equal(full.context.usagePct, 12);
  assert.equal(full.context.tokensUsed, 60000);
  assert.equal(full.context.windowTokens, 500000);
  assert.deepEqual(full.context.toolsUsed, ["read_file"]);
});

test("subagents merge the log frames with subagents/*/meta.json + output.json", () => {
  assert.equal(full.subagents.length, 1);
  const sa = full.subagents[0];
  assert.equal(sa.childSessionId, "fixchild-aaaa-bbbb-cccc-000000000001");
  assert.equal(sa.type, "explore");
  assert.equal(sa.description, "Find the failing test");
  assert.equal(sa.status, "completed");
  assert.equal(sa.durationMs, 12000);
  assert.equal(sa.toolCalls, 4);
  assert.equal(sa.output, "The failing test is tests/build.test.sh");
});

test("summary is surfaced with the subagent flag", () => {
  assert.equal(full.summary.title, "Fix the build");
  assert.equal(full.summary.isSubagent, false);
});

/* ---------------------------------------------------------- 3. ownership */

test("owner is null when no active_sessions.json exists", () => {
  forget(A);
  assert.equal(read(A).owner, null);
});

test("owner is null for a pid that does not exist", () => {
  // pid 0x7FFFFFFE is not a real process on any sane machine
  writeActive([{ session_id: A, pid: 2147483646, cwd: "/fixtures/feed-project", opened_at: "2026-09-01T00:00:00Z" }]);
  forget(A);
  assert.equal(read(A).owner, null);
  assert.equal(sessionOwner(A), null);
});

test("a live pid that is NOT a grok CLI does not own anything", () => {
  // P4. `process.kill(pid, 0)` succeeds for ANY live pid, so a stale registry
  // row plus a recycled pid used to invent an owner out of thin air. This
  // process is alive and is node, not grok — it must not own A.
  writeActive([
    {
      session_id: A,
      pid: process.pid,
      cwd: "/fixtures/feed-project",
      opened_at: "2026-09-01T00:00:01Z",
    },
  ]);
  forget(A);
  resetOwnerCache();
  assert.equal(sessionOwner(A), null, "a live node pid must never register as an owner");
  assert.equal(read(A).owner, null);
});

test("owner is set for a live pid that really is a grok CLI", () => {
  writeActive([
    { session_id: B, pid: 2147483646, cwd: "/fixtures/feed-project", opened_at: "2026-09-01T00:00:00Z" },
    { session_id: A, pid: fakeGrok.pid, cwd: "/fixtures/feed-project", opened_at: "2026-09-01T00:00:01Z" },
  ]);
  forget(A);
  resetOwnerCache();
  const owned = read(A);
  assert.ok(owned.owner, "owner should be detected");
  assert.equal(owned.owner.pid, fakeGrok.pid);
  assert.equal(owned.owner.cwd, "/fixtures/feed-project");
  assert.equal(owned.owner.kind, "tui");
  assert.equal(owned.owner.source, "registry");
  assert.equal(read(B).owner, null, "dead pid must not own B");
});

test("owner is NEVER reported when the projection failed (ok:false)", () => {
  // The P2 trap: `owner` was filled in even for a session directory that does
  // not exist, so anything gating a read-only composer on `owner` alone locked
  // a chat that was not even there.
  const ghost = "ghost-1111-2222-3333-444444444444";
  writeActive([
    { session_id: ghost, pid: fakeGrok.pid, cwd: "/fixtures/feed-project", opened_at: "2026-09-01T00:00:01Z" },
  ]);
  forget(ghost);
  resetOwnerCache();
  const r = read(ghost);
  assert.equal(r.ok, false, "no session dir → ok:false");
  assert.equal(r.owner, null, "ok:false must never carry an owner");
  assert.equal(r.working, false);
  // The probe itself still knows — the load guard uses it directly.
  assert.ok(sessionOwner(ghost), "sessionOwner() still reports the live grok");
});

test("owner cwd is realpath'd, and findSessionDir tolerates the /private skew", () => {
  // macOS: the registry has recorded /private/tmp/... for a process whose argv
  // said /tmp/..., and the session dir key is encodeURIComponent(cwd).
  writeActive([
    { session_id: A, pid: fakeGrok.pid, cwd: symlinkCwd, opened_at: "2026-09-01T00:00:01Z" },
  ]);
  forget(A);
  resetOwnerCache();
  const o = sessionOwner(A);
  assert.ok(o, "owner detected through the symlinked cwd");
  assert.equal(o.cwd, fs.realpathSync(symlinkCwd), "cwd comes back realpath'd");
  assert.notEqual(
    o.cwd,
    symlinkCwd,
    "the fixture must actually be a symlink for this to mean anything",
  );
  // The keyed lookup — not the fallback scan — has to work from either spelling.
  const keys = cwdKeyCandidates(symlinkCwd);
  assert.ok(keys.includes(symlinkCwd), "the literal spelling is still tried first");
  assert.ok(keys.includes(fs.realpathSync(symlinkCwd)), "realpath is tried too");
  assert.ok(
    cwdKeyCandidates("/tmp/x").includes("/private/tmp/x"),
    "/tmp → /private/tmp is covered",
  );
  assert.ok(
    cwdKeyCandidates("/private/tmp/x").includes("/tmp/x"),
    "/private/tmp → /tmp is covered (the direction realpath cannot fix)",
  );
  assert.equal(
    findSessionDir(symlinkSession, symlinkCwd),
    symlinkDir,
    "the symlinked spelling finds the dir keyed by the real path",
  );
});

test("Desk's own ACP worker is never treated as a rival owner", () => {
  const { isAcpWorker } = feed.__internals;
  assert.equal(isAcpWorker("/Users/x/.grok/bin/grok agent --always-approve stdio"), true);
  assert.equal(isAcpWorker("grok agent stdio"), true);
  // A terminal grok, and a headless run, are never launched that way.
  assert.equal(isAcpWorker("grok --cwd /Users/x/project"), false);
  assert.equal(isAcpWorker("grok -p hi --resume abc --cwd /x"), false);
  assert.equal(isAcpWorker(null), false);
});

test("ownership coverage is declared honestly", () => {
  const cov = ownerCoverage();
  assert.equal(cov.registry, true);
  assert.equal(cov.resumedHeadless, true);
  // A headless `grok -p` that opened a brand-new session id is NOT attributable
  // to that id by the registry or by argv. Desk says so rather than implying it.
  assert.equal(cov.newHeadless, false);
});

test("working is live && owner, and rides in read() so HTTP and WS agree", () => {
  writeActive([
    { session_id: A, pid: fakeGrok.pid, cwd: "/fixtures/feed-project", opened_at: "2026-09-01T00:00:01Z" },
  ]);
  forget(A);
  resetOwnerCache();
  const r = read(A);
  assert.equal(typeof r.working, "boolean", "read() must carry `working`");
  assert.equal(r.working, r.live && Boolean(r.owner));
  writeActive([]);
  forget(A);
  resetOwnerCache();
  assert.equal(read(A).working, false, "no owner → never working");
});

test("poll({force}) pushes an ownership change with no new events", () => {
  writeActive([
    { session_id: A, pid: fakeGrok.pid, cwd: "/fixtures/feed-project", opened_at: "2026-09-01T00:00:01Z" },
  ]);
  forget(A);
  resetOwnerCache();
  const seen = [];
  const handle = subscribe(A, 0, (p) => seen.push(p));
  assert.equal(seen.length, 1);
  assert.ok(seen[0].owner, "subscriber sees the owner");
  assert.equal(poll(A), 0, "no new bytes → no push");
  writeActive([]); // the owner exits
  resetOwnerCache();
  assert.equal(poll(A, { force: true }), 1, "forced push delivers the takeover");
  assert.equal(seen[1].owner, null, "the takeover frame clears the owner");
  unsubscribe(handle);
});

/* ------------------------------------------------- 4. cursor / resume */

test("resuming from an arbitrary seq yields exactly the tail", () => {
  for (const cut of [0, 3, 7, 11, 15, 21]) {
    const fromSeq = cut === 0 ? 0 : full.events[cut - 1].seq;
    const tail = read(A, { from: fromSeq });
    assert.deepEqual(
      tail.events.map(shape),
      full.events.slice(cut).map(shape),
      `tail from seq ${fromSeq} (cut ${cut})`,
    );
  }
});

test("full read equals the concatenation of incremental reads", () => {
  // page forward in 4-event steps from the very first event
  const rebuilt = [full.events[0]];
  let cursor = full.events[0].seq;
  for (let guard = 0; guard < 50; guard += 1) {
    const page = read(A, { from: cursor, limit: 4 });
    assert.ok(page.events.length <= 4, "limit not honoured");
    if (!page.events.length) {
      assert.equal(page.hasMore, false);
      break;
    }
    rebuilt.push(...page.events);
    cursor = page.events[page.events.length - 1].seq;
  }
  assert.deepEqual(rebuilt.map(shape), full.events.map(shape));
  const s = rebuilt.map((e) => e.seq);
  assert.equal(new Set(s).size, s.length, "duplicate across resumed reads");
  assert.equal(s.length, full.events.length, "dropped events across resumed reads");
});

test("an appended tail is picked up without re-reading the head", () => {
  const id = "fixapp-0000-0000-0000-000000000001";
  const head = [upLine(id, 1000, 100, msg("one")), upLine(id, 2000, 200, msg("two"))];
  const tail = [upLine(id, 3000, 300, msg("three")), upLine(id, 4000, 400, msg("four"))];
  const dir = scratchSession(id, head, [evLine(500, { type: "turn_started", session_id: id, turn_number: 1 })]);

  const first = read(id);
  assert.deepEqual(first.events.map((e) => e.text).filter(Boolean), ["one", "two"]);
  const headBytes = first.bytesRead;
  assert.ok(headBytes > 0);

  // no change → zero bytes read
  assert.equal(read(id).bytesRead, 0, "an unchanged file must not be re-read");

  fs.appendFileSync(path.join(dir, "updates.jsonl"), tail.join("\n") + "\n");
  const delta = read(id, { from: first.seq });
  assert.deepEqual(delta.events.map((e) => e.text), ["three", "four"]);
  const tailBytes = Buffer.byteLength(tail.join("\n") + "\n");
  assert.equal(delta.bytesRead, tailBytes, "incremental read must read only the new bytes");

  // concatenation === a from-scratch projection of the finished file
  forget(id);
  const fresh = read(id);
  assert.deepEqual(
    [...first.events, ...delta.events].map(shape),
    fresh.events.map(shape),
    "incremental reads must equal a full re-parse",
  );
});

test("a torn final line is held back, then picked up once completed", () => {
  const id = "fixtorn-0000-0000-0000-000000000001";
  const whole = upLine(id, 2000, 200, msg("second"));
  const dir = scratchSession(id, [upLine(id, 1000, 100, msg("first"))]);
  const file = path.join(dir, "updates.jsonl");

  // CLI is mid-append: half a JSON line, no trailing newline
  const torn = whole.slice(0, Math.floor(whole.length / 2));
  fs.appendFileSync(file, torn);

  const partial = read(id);
  assert.deepEqual(partial.events.map((e) => e.text), ["first"], "torn line must not be emitted");
  const held = cursorOf(id).updatesBytes;
  assert.ok(
    held < fs.statSync(file).size,
    "byte cursor must stay behind the torn tail so it is re-read",
  );

  // reading again while still torn changes nothing and emits nothing new
  const again = read(id, { from: partial.seq });
  assert.equal(again.events.length, 0);
  assert.equal(cursorOf(id).updatesBytes, held);

  // CLI finishes the line
  fs.appendFileSync(file, whole.slice(torn.length) + "\n");
  const done = read(id, { from: partial.seq });
  assert.deepEqual(done.events.map((e) => e.text), ["second"]);
  assert.ok(done.events[0].seq > partial.seq, "seq must move forward");
  assert.equal(cursorOf(id).updatesBytes, fs.statSync(file).size);
});

test("a file that shrank resyncs instead of throwing", () => {
  const id = "fixtrunc-0000-0000-0000-000000000001";
  const dir = scratchSession(id, [
    upLine(id, 1000, 100, msg("alpha")),
    upLine(id, 2000, 200, msg("beta")),
    upLine(id, 3000, 300, msg("gamma")),
  ]);
  const file = path.join(dir, "updates.jsonl");
  const before = read(id);
  assert.equal(before.events.length, 3);
  const highWater = before.seq;

  // rotation: the CLI replaced the log with a shorter one
  fs.writeFileSync(file, upLine(id, 9000, 900, msg("rotated")) + "\n");
  const after = read(id);
  assert.deepEqual(after.events.map((e) => e.text), ["rotated"]);
  assert.ok(after.seq > highWater, "seq must never go backwards across a resync");
  assert.equal(after.cursor.updatesBytes, fs.statSync(file).size);
});

test("a missing session returns a shaped payload instead of throwing", () => {
  const miss = read("no-such-session-id");
  assert.equal(miss.ok, false);
  assert.deepEqual(miss.events, []);
  assert.equal(miss.live, false);
  assert.equal(miss.owner, null);
  assert.equal(miss.subagents.length, 0);
});

test("from=0 is a tail window; from>0 pages forward", () => {
  const win = read(A, { from: 0, limit: 5 });
  assert.equal(win.events.length, 5);
  assert.equal(win.truncated, true, "older history exists");
  assert.equal(win.hasMore, false);
  assert.deepEqual(win.events.map(shape), full.events.slice(-5).map(shape));

  const wide = read(A, { from: 0, limit: 1000 });
  assert.equal(wide.truncated, false);
  assert.deepEqual(wide.events.map(shape), full.events.map(shape));

  const page = read(A, { from: full.events[0].seq, limit: 5 });
  assert.equal(page.hasMore, true, "more events after this page");
  assert.equal(page.truncated, false);
  assert.deepEqual(page.events.map(shape), full.events.slice(1, 6).map(shape));
});

/* ------------------------------------------------------- 5. subscribe seam */

test("subscribe delivers a catch-up batch, then poll() delivers deltas", () => {
  const id = "fixsub-0000-0000-0000-000000000001";
  const dir = scratchSession(id, [upLine(id, 1000, 100, msg("hello"))]);
  const seen = [];
  const handle = subscribe(id, 0, (payload) => seen.push(payload));
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].events.map((e) => e.text), ["hello"]);

  assert.equal(poll(id), 0, "poll with no new bytes must not fire");

  fs.appendFileSync(
    path.join(dir, "updates.jsonl"),
    upLine(id, 2000, 200, msg("world")) + "\n",
  );
  assert.equal(poll(id), 1);
  assert.deepEqual(seen[1].events.map((e) => e.text), ["world"]);

  assert.equal(unsubscribe(handle), true);
  fs.appendFileSync(
    path.join(dir, "updates.jsonl"),
    upLine(id, 3000, 300, msg("ignored")) + "\n",
  );
  assert.equal(poll(id), 0);
  assert.equal(seen.length, 2);
});

/* --------------------------------------------------------- 6. read-only */

test("the projector never writes into the session store", () => {
  read(A);
  read(A, { from: 0, limit: 3 });
  read(B);
  assert.deepEqual(snapshotTree(dirA), beforeTree, "session dir was modified");
});

killFakeGrok();
fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\nFEED UNIT PASS — ${passed} tests`);
