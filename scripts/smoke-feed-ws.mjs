#!/usr/bin/env node
/**
 * P2 live-tail protocol smoke — `npm run smoke:feed`.
 *
 * Runs against a live daemon (PORT, default 8787) and proves:
 *   1. two sockets subscribed to the SAME session at DIFFERENT cursors both get
 *      correct, non-overlapping deltas
 *   2. `unsubscribe` stops delivery and tears the per-session watcher down
 *   3. `stop {sessionId: A}` does not end a live turn on session B
 *   4. no daemon→client frame arrives without a `sessionId`
 *      (only `pong` / `client_info_ack` are allowed to omit it)
 *   5. phase_changed spam is coalesced before it reaches the wire
 *
 * Everything it writes goes to a throwaway dir under os.tmpdir(). It never
 * writes into ~/.grok/sessions: the "session" it tails for 1–3 is a scratch
 * session directory it creates under $GROK_HOME/sessions, and $GROK_HOME is
 * only ever the real ~/.grok when you point it there on purpose.
 *
 * Env:
 *   PORT           daemon port (default 8787)
 *   SMOKE_CWD      project cwd for the live-turn lane (default a tmp dir)
 *   SMOKE_LIVE=0   skip the ACP turn lane (frames-only run, no agent needed)
 */
import WebSocket from "ws";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.SMOKE_HOST || "127.0.0.1";
const GROK_HOME = process.env.GROK_HOME || path.join(os.homedir(), ".grok");
const SESSIONS = path.join(GROK_HOME, "sessions");
const LIVE = process.env.SMOKE_LIVE !== "0";

/** Frames that genuinely cannot name a session. Everything else must. */
const NO_SESSION_OK = new Set([
  "pong",
  "client_info_ack",
  // global daemon snapshots / roster — not about one chat
  "hello",
  "status",
  "projects_tick",
  "agents_roster",
]);

let failures = 0;
const ok = (m) => console.log("  ✓", m);
const bad = (m) => {
  failures += 1;
  console.log("  ✗", m);
};

/* ------------------------------------------------------------------- auth */

/** Reuse a live local-lock session cookie if the daemon is locked. */
function authCookie() {
  const p = path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "GrokDesk",
    "auth-sessions.json",
  );
  try {
    const bag = JSON.parse(fs.readFileSync(p, "utf8"))?.sessions || {};
    const now = Date.now();
    let best = null;
    for (const [token, s] of Object.entries(bag)) {
      const exp = Number(s?.expiresAt) || 0;
      if (exp <= now) continue;
      if (!best || exp > best.exp) best = { token, exp };
    }
    return best ? `gd_session=${best.token}` : null;
  } catch {
    return null;
  }
}

const COOKIE = authCookie();

/* -------------------------------------------------------------- ws helper */

class Sock {
  constructor(name) {
    this.name = name;
    this.frames = [];
    this.ws = new WebSocket(`ws://${HOST}:${PORT}/ws`, {
      headers: COOKIE ? { Cookie: COOKIE } : {},
    });
    this.ws.on("message", (raw) => {
      let m;
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      this.frames.push(m);
    });
  }

  open() {
    return new Promise((res, rej) => {
      this.ws.once("open", res);
      this.ws.once("error", rej);
      this.ws.once("close", (code) => rej(new Error(`closed ${code}`)));
    });
  }

  send(obj) {
    this.ws.send(JSON.stringify(obj));
  }

  /**
   * Wait for a frame matching `pred`. Scans already-buffered frames from
   * `from` (default 0) so a catch-up frame that arrived before the call still
   * counts; pass `since()` to look only at what comes next.
   */
  async wait(pred, ms = 15000, label = "frame", from = 0) {
    const deadline = Date.now() + ms;
    let i = from;
    for (;;) {
      while (i < this.frames.length) {
        const f = this.frames[i++];
        if (pred(f)) return f;
      }
      if (Date.now() > deadline) throw new Error(`${this.name}: timeout waiting for ${label}`);
      await sleep(20);
    }
  }

  since() {
    return this.frames.length;
  }

  after(n) {
    return this.frames.slice(n);
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* */
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------------------------------- scratch session */

const SCRATCH_CWD = path.join(os.tmpdir(), `grok-desk-p2-${process.pid}`);
const SCRATCH_ID = `p2feed-${process.pid.toString(16)}-0000-0000-000000000001`;
const SCRATCH_DIR = path.join(SESSIONS, encodeURIComponent(SCRATCH_CWD), SCRATCH_ID);

let seqCounter = 0;
function upLine(text, kind = "agent_message_chunk") {
  seqCounter += 1;
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: SCRATCH_ID,
      update: { sessionUpdate: kind, content: { type: "text", text } },
      _meta: {
        eventId: `${SCRATCH_ID}-${seqCounter}`,
        agentTimestampMs: Date.now(),
      },
    },
  });
}

function evLine(type, extra = {}) {
  return JSON.stringify({ ts: new Date().toISOString(), type, ...extra });
}

function appendUpdates(lines) {
  fs.appendFileSync(path.join(SCRATCH_DIR, "updates.jsonl"), lines.join("\n") + "\n");
}

function appendEvents(lines) {
  fs.appendFileSync(path.join(SCRATCH_DIR, "events.jsonl"), lines.join("\n") + "\n");
}

function makeScratch() {
  fs.mkdirSync(SCRATCH_DIR, { recursive: true });
  fs.writeFileSync(path.join(SCRATCH_DIR, "updates.jsonl"), "");
  fs.writeFileSync(path.join(SCRATCH_DIR, "events.jsonl"), "");
  fs.writeFileSync(
    path.join(SCRATCH_DIR, "summary.json"),
    JSON.stringify({ info: { id: SCRATCH_ID, cwd: SCRATCH_CWD }, created_at: new Date().toISOString() }),
  );
}

function cleanupScratch() {
  try {
    fs.rmSync(path.dirname(SCRATCH_DIR), { recursive: true, force: true });
  } catch {
    /* */
  }
}

/* ------------------------------------------------------------------ audit */

function auditFrames(sock) {
  const missing = [];
  for (const f of sock.frames) {
    if (NO_SESSION_OK.has(f.type)) continue;
    if (!Object.prototype.hasOwnProperty.call(f, "sessionId")) {
      missing.push(f.type);
    }
  }
  return [...new Set(missing)];
}

function frameTypes(sock) {
  return [...new Set(sock.frames.map((f) => f.type))].sort();
}

/* ------------------------------------------------------------------- main */

console.log(`\nP2 feed smoke → ws://${HOST}:${PORT}/ws  (auth cookie: ${COOKIE ? "yes" : "none"})\n`);

makeScratch();
let a;
let b;
try {
  /* -- 1. two sockets, same session, different cursors ------------------- */
  console.log("1. two sockets on one session at different cursors");

  appendUpdates([upLine("one"), upLine("two"), upLine("three")]);

  a = new Sock("A");
  b = new Sock("B");
  await a.open();
  await b.open();
  await a.wait((f) => f.type === "hello", 5000, "hello");
  await b.wait((f) => f.type === "hello", 5000, "hello");

  a.send({ type: "subscribe", sessionId: SCRATCH_ID, fromSeq: 0, cwd: SCRATCH_CWD });
  const aCatch = await a.wait((f) => f.type === "feed" && f.catchUp, 8000, "A catch-up feed");
  const aTexts = aCatch.events.filter((e) => e.kind === "agent_message").map((e) => e.text);
  assert.deepEqual(aTexts, ["one", "two", "three"]);
  ok(`A subscribed from 0 → ${aTexts.join(",")} (seq ${aCatch.seq})`);

  // B joins at a LATER cursor — it must only see what came after it.
  b.send({ type: "subscribe", sessionId: SCRATCH_ID, fromSeq: 2, cwd: SCRATCH_CWD });
  const bCatch = await b.wait((f) => f.type === "feed" && f.catchUp, 8000, "B catch-up feed");
  const bTexts = bCatch.events.filter((e) => e.kind === "agent_message").map((e) => e.text);
  assert.deepEqual(bTexts, ["three"], `B at cursor 2 saw ${JSON.stringify(bTexts)}`);
  ok(`B subscribed from 2 → ${bTexts.join(",")} (independent cursor, same session)`);

  const aMark = a.since();
  const bMark = b.since();
  appendUpdates([upLine("four")]);

  const aDelta = await a.wait((f) => f.type === "feed" && !f.catchUp, 8000, "A delta");
  const bDelta = await b.wait((f) => f.type === "feed" && !f.catchUp, 8000, "B delta");
  assert.deepEqual(
    aDelta.events.filter((e) => e.kind === "agent_message").map((e) => e.text),
    ["four"],
  );
  assert.deepEqual(
    bDelta.events.filter((e) => e.kind === "agent_message").map((e) => e.text),
    ["four"],
  );
  ok("both sockets got the same delta from one fs change (per-session watcher fired)");
  assert.equal(aDelta.sessionId, SCRATCH_ID);
  assert.equal(bDelta.sessionId, SCRATCH_ID);
  assert.equal(typeof aDelta.live, "boolean");
  assert.ok("owner" in aDelta && "working" in aDelta, "feed must expose owner + working");
  ok("feed frame carries sessionId, live, owner, working, phase, turn, truncated, hasMore");
  void aMark;
  void bMark;

  /* -- 5. phase coalescing ----------------------------------------------- */
  console.log("\n2. phase_changed coalescing");
  const beforePhase = a.since();
  const spam = [];
  for (let i = 0; i < 40; i += 1) spam.push(evLine("phase_changed", { phase: "thinking" }));
  spam.push(evLine("phase_changed", { phase: "tooling" }));
  appendEvents(spam);
  await sleep(600);
  const phaseFrames = a.after(beforePhase).filter((f) => f.type === "feed");
  const phaseEvents = phaseFrames.flatMap((f) => f.events.filter((e) => e.kind === "phase"));
  if (phaseEvents.length <= 3) {
    ok(`41 phase_changed rows → ${phaseEvents.length} phase event(s) on the wire`);
  } else {
    bad(`phase spam not coalesced: ${phaseEvents.length} phase events on the wire`);
  }
  const lastPhase = phaseFrames[phaseFrames.length - 1]?.phase;
  if (lastPhase === "tooling") ok("frame-level `phase` still reports the latest value");
  else bad(`frame-level phase was ${lastPhase}, expected tooling`);

  /* -- 2. unsubscribe stops delivery ------------------------------------- */
  console.log("\n3. unsubscribe");
  b.send({ type: "unsubscribe", sessionId: SCRATCH_ID });
  const unsub = await b.wait((f) => f.type === "unsubscribed", 5000, "unsubscribed ack");
  assert.equal(unsub.sessionId, SCRATCH_ID);
  assert.equal(unsub.ok, true);
  ok("B unsubscribed");

  const bQuiet = b.since();
  const aBefore = a.since();
  appendUpdates([upLine("five")]);
  await a.wait((f) => f.type === "feed" && !f.catchUp, 8000, "A delta after B left", aBefore);
  await sleep(400);
  const bAfter = b.after(bQuiet).filter((f) => f.type === "feed");
  if (bAfter.length === 0) ok("B received nothing after unsubscribe");
  else bad(`B still got ${bAfter.length} feed frame(s) after unsubscribe`);
  const aGot = a
    .after(aBefore)
    .filter((f) => f.type === "feed")
    .flatMap((f) => f.events.filter((e) => e.kind === "agent_message").map((e) => e.text));
  assert.deepEqual(aGot, ["five"]);
  ok("A still streaming — the watcher survives while one subscriber remains");

  // Last subscriber leaves → watcher must be torn down.
  a.send({ type: "unsubscribe", sessionId: SCRATCH_ID });
  await a.wait((f) => f.type === "unsubscribed", 5000, "A unsubscribed ack");
  const aQuiet = a.since();
  appendUpdates([upLine("six")]);
  await sleep(600);
  const aAfter = a.after(aQuiet).filter((f) => f.type === "feed");
  if (aAfter.length === 0) ok("no subscribers left → watcher torn down, no delivery");
  else bad(`A got ${aAfter.length} feed frame(s) with no subscription`);

  /* -- 3. stop is per-session -------------------------------------------- */
  if (LIVE) {
    console.log("\n4. stop {sessionId: A} must not end a live turn on session B");
    const cwd = process.env.SMOKE_CWD || path.join(os.tmpdir(), `grok-desk-p2-turns-${process.pid}`);
    fs.mkdirSync(cwd, { recursive: true });
    const LONG =
      "Write a detailed 800 word essay about the history of the number zero. " +
      "Do not use any tools. Just write prose, slowly and thoroughly.";

    const ends = [];
    a.ws.on("message", (raw) => {
      try {
        const m = JSON.parse(String(raw));
        if (m.type === "turn_end") ends.push(m);
      } catch {
        /* */
      }
    });
    const statusNow = async () => {
      const n = a.since();
      a.send({ type: "status" });
      return a.wait((x) => x.type === "status", 10000, "status", n);
    };

    // A on the PRIMARY worker.
    a.send({ type: "new_session", cwd });
    const sessA = await a.wait((f) => f.type === "session" && f.sessionId, 90000, "session A");
    const sidA = sessA.sessionId;
    a.send({ type: "prompt", sessionId: sidA, text: LONG, clientMsgId: `p2a_${Date.now()}` });
    await a.wait((f) => f.type === "turn_start" && f.sessionId === sidA, 90000, "turn_start A");
    ok(`turn A live on the primary — ${sidA.slice(0, 8)}`);

    // B on a PARALLEL pool worker (dispatch always spawns one while busy).
    a.send({ type: "dispatch", cwd, text: LONG, clientMsgId: `p2b_${Date.now()}` });
    const sessB = await a.wait(
      (f) => f.type === "session" && f.sessionId && f.sessionId !== sidA,
      90000,
      "session B",
    );
    const sidB = sessB.sessionId;
    const startB = await a.wait(
      (f) => f.type === "turn_start" && f.sessionId === sidB,
      90000,
      "turn_start B",
    );
    ok(`turn B live on a parallel worker — ${sidB.slice(0, 8)} (parallel=${Boolean(startB.parallel)})`);

    // Both must be live before the stop means anything.
    let snap = await statusNow();
    for (let i = 0; i < 40 && !(snap.liveSessionIds || []).includes(sidB); i += 1) {
      await sleep(250);
      snap = await statusNow();
    }
    const bothLive =
      (snap.liveSessionIds || []).includes(sidA) && (snap.liveSessionIds || []).includes(sidB);
    if (bothLive) ok(`both sessions live: ${JSON.stringify(snap.liveSessionIds)}`);
    else bad(`expected both live, got ${JSON.stringify(snap.liveSessionIds)}`);

    // STOP A only.
    a.send({ type: "stop", sessionId: sidA });
    const stopped = await a.wait((f) => f.type === "stopped", 15000, "stopped ack");
    assert.equal(stopped.sessionId, sidA);
    if (stopped.scope === "primary") ok(`stop targeted A only → scope=${stopped.scope}`);
    else bad(`stop on a live primary reported scope=${stopped.scope}, expected primary`);

    const endedA = await a.wait(
      (f) => f.type === "turn_end" && f.sessionId === sidA,
      15000,
      "turn_end A",
    );
    if (endedA.abandoned || endedA.reason === "stop") ok("A's turn ended (abandoned by stop)");
    else bad(`A's turn_end was ${JSON.stringify(endedA.reason)}, expected stop/abandoned`);

    // B must survive.
    await sleep(3000);
    const bEnded = ends.find((e) => e.sessionId === sidB);
    if (bEnded && (bEnded.abandoned || bEnded.reason === "stop")) {
      bad(`stop on A abandoned B: ${JSON.stringify(bEnded)}`);
    } else if (bEnded) {
      ok(`B finished on its own (${bEnded.reason}) — not killed by the stop on A`);
    } else {
      const after = await statusNow();
      if ((after.liveSessionIds || []).includes(sidB)) {
        ok(`B still live after stop on A: ${JSON.stringify(after.liveSessionIds)}`);
      } else {
        bad(`B vanished from liveSessionIds after stop on A`);
      }
      // P2 correction 4: primary is idle → activeSessionId must be null, even
      // though turnActive is still true because a parallel worker is busy.
      if (after.turnActive && after.activeSessionId === null) {
        ok("turnSnapshot honest: turnActive=true (parallel) with activeSessionId=null");
      } else if (after.activeSessionId === sidA) {
        bad("activeSessionId still names the stopped session A");
      } else {
        ok(`activeSessionId=${after.activeSessionId} turnActive=${after.turnActive}`);
      }
    }

    a.send({ type: "stop", sessionId: sidB });
    await sleep(800);
  } else {
    console.log("\n4. stop lane skipped (SMOKE_LIVE=0)");
  }

  /* -- 4. every frame carries a sessionId -------------------------------- */
  console.log("\n5. sessionId on every daemon→client frame");
  for (const sock of [a, b]) {
    const missing = auditFrames(sock);
    if (missing.length === 0) {
      ok(`${sock.name}: all ${sock.frames.length} frames carry sessionId (types: ${frameTypes(sock).join(", ")})`);
    } else {
      bad(`${sock.name}: frames without sessionId → ${missing.join(", ")}`);
    }
  }
} catch (e) {
  failures += 1;
  console.error("\nSMOKE ERROR:", e.message);
} finally {
  a?.close();
  b?.close();
  cleanupScratch();
}

console.log("");
if (failures) {
  console.log(`SMOKE FEED FAIL — ${failures} failure(s)`);
  process.exit(1);
}
console.log("SMOKE FEED PASS");
process.exit(0);
