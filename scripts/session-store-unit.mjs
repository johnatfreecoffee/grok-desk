#!/usr/bin/env node
/**
 * Client projection unit tests — `npm run test:store`.
 *
 * These drive the code that actually ships: `web/src/lib/sessionFeed.ts`
 * (the store `App.tsx` renders from) and the identity helpers left in
 * `web/src/lib/sessionStore.ts`.
 *
 * The old version of this file tested a `SessionStore` class nothing called,
 * which is why 9 green tests proved nothing.
 *
 * Usage: node --experimental-strip-types scripts/session-store-unit.mjs
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/* localStorage stub — persistFeed / loadPersistedFeed are part of the contract. */
const bag = new Map();
globalThis.localStorage = {
  getItem: (k) => (bag.has(k) ? bag.get(k) : null),
  setItem: (k, v) => bag.set(k, String(v)),
  removeItem: (k) => bag.delete(k),
  clear: () => bag.clear(),
};

const here = path.dirname(fileURLToPath(import.meta.url));
const feedUrl = pathToFileURL(path.join(here, "../web/src/lib/sessionFeed.ts")).href;
const idUrl = pathToFileURL(path.join(here, "../web/src/lib/sessionStore.ts")).href;

const {
  SessionFeedStore,
  draftFromState,
  loadPersistedFeed,
  persistFeed,
  userFacingText,
} = await import(feedUrl);
const { createPendingId, isPendingId, isMailSession, shouldPaint } = await import(idUrl);

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log("✓", name);
}

/* ------------------------------------------------------------- fixtures */

let seq = 0;
const SID = "sess-a";

function ev(kind, extra = {}, sid = SID) {
  seq += 1;
  return { seq, at: 1_700_000_000_000 + seq, sessionId: sid, kind, src: "updates", ...extra };
}

function frame(events, opts = {}) {
  const sid = opts.sessionId || SID;
  const last = events.length ? events[events.length - 1].seq : opts.seq || 0;
  return {
    type: "feed",
    sessionId: sid,
    fromSeq: opts.fromSeq ?? 0,
    seq: opts.seq ?? last,
    events,
    live: opts.live ?? false,
    phase: opts.phase ?? null,
    owner: opts.owner ?? null,
    working: opts.working ?? false,
    context: opts.context ?? null,
    subagents: opts.subagents ?? [],
    turn: opts.turn ?? null,
    truncated: Boolean(opts.truncated),
    hasMore: Boolean(opts.hasMore),
    ...(opts.catchUp ? { catchUp: true } : {}),
    ...(opts.error ? { error: opts.error, ok: false } : {}),
  };
}

const texts = (st) => st.messages.map((m) => `${m.role}:${m.content}`);

/* --------------------------------------------------------- identity API */

test("shouldPaint requires both ids known and equal", () => {
  assert.equal(shouldPaint("a", "a"), true);
  assert.equal(shouldPaint("a", "b"), false);
  assert.equal(shouldPaint("a", null), false);
  assert.equal(shouldPaint(null, "a"), false);
  assert.equal(shouldPaint(null, null), false);
});

test("pending + mail ids are recognized", () => {
  const id = createPendingId();
  assert.equal(isPendingId(id), true);
  assert.equal(isPendingId("01a08114-a829-7250-80ab-c7a6de9c58fb"), false);
  assert.equal(isMailSession("mail:abc"), true);
  assert.equal(isMailSession("01a08114"), false);
});

test("userFacingText strips scaffolding, keeps the human line", () => {
  assert.equal(userFacingText("<user_query>ship it</user_query>"), "ship it");
  assert.equal(userFacingText("<system-reminder>noise</system-reminder>"), null);
  assert.equal(userFacingText("[GROK DESK — PROJECT CONTEXT]\nblah\n\nreal text"), "real text");
  assert.equal(userFacingText("line one\nline two"), "line one\nline two"); // newlines survive
});

/* ---------------------------------------------------------- the reducer */

test("chunks fold into one assistant row; thought and plan ride along", () => {
  seq = 0;
  const store = new SessionFeedStore();
  const st = store.applyFeed(
    SID,
    frame([
      ev("turn_start"),
      ev("user_message", { text: "hi" }),
      ev("agent_thought", { text: "let me think" }),
      ev("agent_message", { text: "Hello " }),
      ev("agent_message", { text: "world" }),
      ev("plan", { entries: [{ content: "step 1", status: "pending" }] }),
      ev("turn_end"),
    ]),
  ).state;
  assert.deepEqual(texts(st), ["user:hi", "assistant:Hello world"]);
  assert.equal(st.messages[1].thought, "let me think");
  assert.equal(st.messages[1].plan.length, 1);
  assert.equal(st.messages[1].streaming, false);
});

test("a late turn_start (timestamp tie) must not cut the reply in half", () => {
  seq = 0;
  const store = new SessionFeedStore();
  // updates.jsonl and events.jsonl share a millisecond; the merge breaks ties
  // toward updates, so turn_start can land after its own turn's first chunks.
  const st = store.applyFeed(
    SID,
    frame([
      ev("user_message", { text: "hi" }),
      ev("agent_message", { text: "one " }),
      { ...ev("turn_start"), src: "events" },
      ev("agent_message", { text: "two" }),
      { ...ev("turn_end"), src: "events" },
    ]),
  ).state;
  assert.deepEqual(texts(st), ["user:hi", "assistant:one two"]);
});

test("tool_call / tool_call_update merge by toolCallId, in place", () => {
  seq = 0;
  const store = new SessionFeedStore();
  let st = store.applyFeed(
    SID,
    frame([
      ev("turn_start"),
      ev("user_message", { text: "read it" }),
      ev("tool_call", {
        toolCallId: "t1",
        title: "read_file",
        status: "pending",
        rawInput: { path: "/tmp/a.txt" },
      }),
    ]),
  ).state;
  assert.equal(st.messages[1].tools.length, 1);
  assert.equal(st.messages[1].tools[0].status, "pending");
  assert.equal(st.messages[1].tools[0].path, "/tmp/a.txt");

  st = store.applyFeed(
    SID,
    frame(
      [ev("tool_call_update", { toolCallId: "t1", status: "completed", output: "file body" })],
      { fromSeq: 3 },
    ),
  ).state;
  const tools = st.messages[1].tools;
  assert.equal(tools.length, 1, "update must not append a second row");
  assert.equal(tools[0].status, "completed");
  assert.equal(tools[0].output, "file body");
});

test("a tool_call_update after the bubble closed still updates its tool", () => {
  seq = 0;
  const store = new SessionFeedStore();
  let st = store.applyFeed(
    SID,
    frame([
      ev("agent_message", { text: "running" }),
      ev("tool_call", { toolCallId: "t9", title: "bash", status: "in_progress" }),
      ev("turn_end"),
      ev("user_message", { text: "next" }),
    ]),
  ).state;
  st = store.applyFeed(
    SID,
    frame([ev("tool_call_update", { toolCallId: "t9", status: "completed" })], { fromSeq: 4 }),
  ).state;
  const assistant = st.messages.find((m) => m.role === "assistant");
  assert.equal(assistant.tools[0].status, "completed");
  assert.equal(st.messages.filter((m) => m.role === "assistant").length, 1);
});

/* -------------------------------------------------- idempotency + gaps */

test("applying the same frame twice is a no-op", () => {
  seq = 0;
  const store = new SessionFeedStore();
  const f = frame([
    ev("user_message", { text: "ok" }),
    ev("agent_message", { text: "sure" }),
  ]);
  const a = store.applyFeed(SID, f);
  const b = store.applyFeed(SID, f);
  assert.deepEqual(texts(a.state), ["user:ok", "assistant:sure"]);
  assert.deepEqual(texts(b.state), ["user:ok", "assistant:sure"]);
  assert.equal(b.applied, 0);
  assert.equal(a.state.seq, b.state.seq);
});

test("overlapping frames do not duplicate — seq is the only identity", () => {
  seq = 0;
  const store = new SessionFeedStore();
  const e1 = ev("user_message", { text: "one" });
  const e2 = ev("agent_message", { text: "two" });
  const e3 = ev("agent_message", { text: " three" });
  store.applyFeed(SID, frame([e1, e2]));
  const st = store.applyFeed(SID, frame([e2, e3], { fromSeq: 1 })).state;
  assert.deepEqual(texts(st), ["user:one", "assistant:two three"]);
});

test("a frame that starts past the cursor is refused as a gap", () => {
  seq = 0;
  const store = new SessionFeedStore();
  store.applyFeed(SID, frame([ev("user_message", { text: "one" })]));
  const res = store.applyFeed(
    SID,
    frame([{ seq: 40, at: 1, sessionId: SID, kind: "agent_message", src: "updates", text: "hole" }], {
      fromSeq: 39,
    }),
  );
  assert.equal(res.gap, true);
  assert.equal(res.applied, 0);
  assert.deepEqual(texts(res.state), ["user:one"], "nothing concatenated over the hole");
  assert.equal(res.state.seq, 1, "cursor stays put so the caller can refetch");
});

test("a fromSeq label ahead of the cursor is not a gap when the frame covers it", () => {
  seq = 0;
  const store = new SessionFeedStore();
  store.applyFeed(SID, frame([ev("user_message", { text: "one" }), ev("agent_message", { text: "a" })]));
  // The daemon's handle raced ahead between read and send (found by smoke:switch):
  // fromSeq says 6 but the frame actually carries seq 3..6, so nothing is missing.
  const res = store.applyFeed(
    SID,
    frame(
      [
        ev("agent_message", { text: "b" }),
        ev("agent_message", { text: "c" }),
        ev("agent_message", { text: "d" }),
        ev("agent_message", { text: "e" }),
      ],
      { fromSeq: 6, seq: 6 },
    ),
  );
  assert.equal(res.gap, false, "an overlapping frame is idempotent, not a hole");
  assert.deepEqual(texts(res.state), ["user:one", "assistant:abcde"]);
});

test("a rotated log resets — but only on a catch-up, never on a stale delta", () => {
  seq = 0;
  const store = new SessionFeedStore();
  store.applyFeed(SID, frame([ev("user_message", { text: "old" }), ev("agent_message", { text: "old reply" })]));

  // A duplicate delta still in flight must be a plain no-op, NOT a reset:
  // resetting here threw away a correct transcript (found by smoke:switch).
  seq = 0;
  const dupe = store.applyFeed(SID, frame([ev("user_message", { text: "old" })], { fromSeq: 0 })).state;
  assert.deepEqual(texts(dupe), ["user:old", "assistant:old reply"]);
  assert.equal(dupe.seq, 2);

  // A catch-up that reports LESS history than we hold is authoritative.
  seq = 0;
  const st = store.applyFeed(
    SID,
    frame([ev("user_message", { text: "fresh" })], { fromSeq: 0, catchUp: true }),
  ).state;
  assert.deepEqual(texts(st), ["user:fresh"]);
});

/* ------------------------------------------------------- the "ok" case */

test('sending "ok" twice keeps both', () => {
  seq = 0;
  const store = new SessionFeedStore();
  const st = store.applyFeed(
    SID,
    frame([
      ev("user_message", { text: "ok" }),
      ev("agent_message", { text: "first" }),
      ev("turn_end"),
      ev("user_message", { text: "ok" }),
      ev("agent_message", { text: "second" }),
      ev("turn_end"),
    ]),
  ).state;
  assert.deepEqual(texts(st), [
    "user:ok",
    "assistant:first",
    "user:ok",
    "assistant:second",
  ]);
  assert.equal(st.messages.filter((m) => m.role === "user").length, 2);
});

test("no 200-row cap — long chats stay whole", () => {
  seq = 0;
  const store = new SessionFeedStore();
  const events = [];
  for (let i = 0; i < 300; i += 1) {
    events.push(ev("user_message", { text: `q${i}` }));
    events.push(ev("agent_message", { text: `a${i}` }));
    events.push(ev("turn_end"));
  }
  const st = store.applyFeed(SID, frame(events)).state;
  assert.equal(st.messages.length, 600);
  assert.equal(st.messages[0].content, "q0");
  assert.equal(st.messages[599].content, "a299");
});

/* --------------------------------------------------------- isolation */

test("a frame never touches another session", () => {
  seq = 0;
  const store = new SessionFeedStore();
  store.applyFeed("A", frame([ev("agent_message", { text: "alpha" }, "A")], { sessionId: "A" }));
  store.applyFeed("B", frame([ev("agent_message", { text: "beta" }, "B")], { sessionId: "B" }));
  assert.deepEqual(texts(store.get("A")), ["assistant:alpha"]);
  assert.deepEqual(texts(store.get("B")), ["assistant:beta"]);
  // A frame whose sessionId disagrees with the target is ignored outright.
  const res = store.applyFeed("A", frame([ev("agent_message", { text: "leak" }, "B")], { sessionId: "B" }));
  assert.equal(res.ignored, true);
  assert.deepEqual(texts(store.get("A")), ["assistant:alpha"]);
});

test("drafts are never shared across sessions", () => {
  seq = 0;
  const store = new SessionFeedStore();
  store.applyFeed(
    "A",
    frame([ev("agent_message", { text: "alpha" }, "A")], {
      sessionId: "A",
      live: true,
      working: true,
      owner: { sessionId: "A", pid: 1, cwd: null, openedAt: null },
    }),
  );
  const dA = draftFromState(store.get("A"));
  dA.content = "MUTATED";
  dA.tools.push({ id: "x", title: "x", status: "pending" });
  assert.equal(store.get("A").messages[0].content, "alpha");
  assert.equal(store.get("B"), null);
});

/* ------------------------------------------------------ working / owner */

test("working is live && owner — a crashed-mid-turn session is not working", () => {
  seq = 0;
  const store = new SessionFeedStore();
  // Orphan turn_started, no owner: live true, working false.
  const st = store.applyFeed(
    SID,
    frame([ev("turn_start"), ev("agent_message", { text: "half" })], {
      live: true,
      working: false,
      owner: null,
    }),
  ).state;
  assert.equal(st.live, true);
  assert.equal(st.working, false);
  assert.equal(st.messages[0].streaming, false, "nothing streams without an owner");
  assert.equal(draftFromState(st), null);
});

test("owner && ok gates read-only; owner without ok never locks the composer", () => {
  seq = 0;
  const store = new SessionFeedStore();
  const owner = { sessionId: SID, pid: 4242, cwd: "/tmp/p", openedAt: null };
  let st = store.applyFeed(SID, frame([ev("agent_message", { text: "cli" })], {
    live: true,
    working: true,
    owner,
  })).state;
  assert.equal(st.readOnly, true);
  assert.equal(st.working, true);
  assert.equal(st.messages[0].streaming, true);

  // The session dir is gone but active_sessions.json still names an owner.
  st = store.applyFeed(SID, frame([], { error: "session not found", owner })).state;
  assert.equal(st.ok, false);
  assert.equal(st.readOnly, false, "owner && ok — never owner alone");
  assert.equal(st.working, false);
});

test("the feed's turn_end is the finalize — turnEndSeq advances", () => {
  seq = 0;
  const store = new SessionFeedStore();
  let st = store.applyFeed(SID, frame([ev("turn_start"), ev("agent_message", { text: "x" })], {
    live: true,
    working: true,
    owner: { sessionId: SID, pid: 1, cwd: null, openedAt: null },
  })).state;
  assert.equal(st.turnEndSeq, 0);
  const endSeq = seq + 1;
  st = store.applyFeed(SID, frame([ev("turn_end", { outcome: "ok" })], { fromSeq: 2 })).state;
  assert.equal(st.turnEndSeq, endSeq);
  assert.equal(st.messages[0].streaming, false);
});

/* ------------------------------------------------------------- cursors */

test("cursor is 0 until something is rendered, then the real seq", () => {
  seq = 0;
  const store = new SessionFeedStore();
  assert.equal(store.cursor(SID), 0);
  store.applyFeed(SID, frame([ev("agent_message", { text: "a" })]));
  assert.equal(store.cursor(SID), 1);
  assert.equal(store.seqOf(SID), 1);
});

test("hydrate + persist give a reload the cursor instead of a blank chat", () => {
  bag.clear();
  seq = 0;
  const store = new SessionFeedStore();
  store.applyFeed(
    SID,
    frame([ev("user_message", { text: "before reload" }), ev("agent_message", { text: "reply" })]),
  );
  persistFeed(store.get(SID));

  const saved = loadPersistedFeed(SID);
  assert.equal(saved.seq, 2);
  assert.equal(saved.messages.length, 2);

  // Fresh page: hydrate, then resume at the cursor.
  const reloaded = new SessionFeedStore();
  reloaded.hydrate(SID, saved.seq, saved.messages);
  assert.deepEqual(texts(reloaded.get(SID)), ["user:before reload", "assistant:reply"]);
  assert.equal(reloaded.cursor(SID), 2);

  const st = reloaded.applyFeed(
    SID,
    frame([ev("agent_message", { text: " continued" })], { fromSeq: 2 }),
  ).state;
  assert.deepEqual(texts(st), ["user:before reload", "assistant:reply continued"]);
});

test("workingIds / otherWorkingId drive the background banner", () => {
  seq = 0;
  const store = new SessionFeedStore();
  const owner = (id) => ({ sessionId: id, pid: 9, cwd: null, openedAt: null });
  store.applyFeed("A", frame([ev("agent_message", { text: "a" }, "A")], {
    sessionId: "A",
    live: true,
    working: true,
    owner: owner("A"),
  }));
  store.applyFeed("B", frame([ev("agent_message", { text: "b" }, "B")], { sessionId: "B" }));
  assert.deepEqual(store.workingIds(), ["A"]);
  assert.equal(store.otherWorkingId("B"), "A");
  assert.equal(store.otherWorkingId("A"), null);
});

console.log(`\n${passed} tests passed`);
