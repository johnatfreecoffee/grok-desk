#!/usr/bin/env node
/**
 * P4 — `npm run smoke:cli`. Ownership, and never clobber the CLI.
 *
 * `chat_history.jsonl` is whole-file rewritten at the end of every turn, not
 * appended: each process serialises ITS OWN view of the conversation. So if a
 * terminal `grok` and a Desk ACP worker hold the same session at once, the last
 * writer wins and the other process's turns are silently erased. This smoke
 * proves Desk never gets into that position.
 *
 * Asserted:
 *   1. Desk REFUSES to `session/load` a session whose owning pid is alive —
 *      over the WebSocket and over POST /api/load-session — and refuses to
 *      prompt it. No ACP worker is attached at all.
 *   2. While owned, Desk's feed still matches that session's updates.jsonl in
 *      content, live within 1 s.
 *   3. When the owner exits, the session becomes sendable WITHOUT a reload and
 *      without a resubscribe — the daemon pushes the takeover on its own.
 *   4. deleteSession on an owned session is refused, naming the pid.
 *   5. A live pid that is not a `grok` CLI (a recycled pid) does not register
 *      as an owner.
 *
 * Everything is throwaway: its own daemon on its own port, its own GROK_HOME,
 * its own project cwd under os.tmpdir(). It never touches ~/.grok/sessions and
 * never talks to the daemon on :8787. The whole process group is killed on the
 * way out and the survivors are printed as proof.
 *
 * The "terminal grok" in the default lane is a SYMLINK to /bin/sleep named
 * `grok`: the ownership probe asks the process table what the executable behind
 * the pid is, so a process genuinely named `grok` is exactly what it needs — no
 * API tokens, no real CLI, no chance of leaving a real agent running.
 *
 * `node scripts/smoke-cli.mjs --real` runs the CLOBBER PROOF instead: a REAL
 * `grok` TUI under a pty, prompted before and after Desk opens the same session,
 * with `chat_history.jsonl` turn counts compared on both sides. It needs python3
 * (for the pty) and spends real tokens, which is why it is opt-in.
 *
 * Usage: node scripts/smoke-cli.mjs [--real]
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import {
  Client,
  Scratch,
  authCookie,
  diskAssistantText,
  loadFeedStore,
  reporter,
  sleep,
} from "./lib/feed-smoke-kit.mjs";

const SHORT = "Reply with exactly: ready. No tools, nothing else.";
const SECOND = "Reply with exactly: taken over. No tools, nothing else.";

const r = reporter();
const scratch = new Scratch("p4cli");
let client;
/** Every helper process this smoke starts, so nothing can be left behind. */
const spawned = [];

/**
 * A live process whose executable really is named `grok`.
 *
 * A SYMLINK to /bin/sleep, not a copy: `ps -o comm=` reports the path it was
 * executed as, and macOS code-signing enforcement SIGKILLs an unsigned copy of
 * a platform binary a second or so after it starts (which is exactly the kind
 * of flake that makes an ownership test lie).
 */
async function startFakeGrok(tag) {
  const dir = path.join(scratch.root, "bin", tag);
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, "grok");
  fs.symlinkSync("/bin/sleep", bin);
  const proc = spawn(bin, ["900"], { stdio: "ignore" });
  spawned.push(proc);
  for (let i = 0; i < 200; i += 1) {
    try {
      const comm = execFileSync("ps", ["-p", String(proc.pid), "-o", "comm="], {
        encoding: "utf8",
      }).trim();
      if (path.basename(comm) === "grok") return proc;
    } catch {
      /* not visible yet */
    }
    await sleep(20);
  }
  throw new Error("fake grok never appeared in the process table as `grok`");
}

/** The owner must still be alive, or the assertions around it prove nothing. */
function assertAlive(proc, when) {
  try {
    process.kill(proc.pid, 0);
  } catch {
    throw new Error(`the fake grok (pid ${proc.pid}) died before ${when} — assertions would be void`);
  }
}

function killSpawned() {
  for (const p of spawned) {
    try {
      process.kill(p.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

function writeRegistry(rows) {
  fs.writeFileSync(
    path.join(scratch.home, "active_sessions.json"),
    JSON.stringify(rows, null, 2),
  );
}

const api = (port, route, init = {}) => {
  const cookie = authCookie();
  return fetch(`http://127.0.0.1:${port}${route}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
      ...(init.headers || {}),
    },
  }).then((res) => res.json());
};

/**
 * Compare the projection with the disk log ignoring whitespace: the projector
 * splits the log into chat bubbles and trims each one, so a space that sat at a
 * bubble boundary legitimately does not survive. Every non-space character must.
 */
const sameText = (a, b) => a.replace(/\s+/g, "") === b.replace(/\s+/g, "");

let seqCounter = 100000;
/** One `session/update` line, exactly the shape the CLI appends. */
function upLine(sessionId, text) {
  seqCounter += 1;
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
      _meta: { eventId: `${sessionId}-${seqCounter}`, agentTimestampMs: Date.now() },
    },
  });
}

const REAL = process.argv.includes("--real");

if (!REAL) try {
  console.log(`\nP4 CLI-ownership smoke — scratch daemon, scratch GROK_HOME\n  home ${scratch.home}`);
  const feedmod = await loadFeedStore();
  const port = await scratch.startDaemon();
  console.log(`  daemon :${port}\n`);

  client = new Client("desk", port, feedmod);
  await client.open();

  /* -- 1. an unowned session Desk can drive normally --------------------- */
  console.log("1. baseline: Desk owns nothing, so it can send");
  client.send({ type: "new_session", cwd: scratch.cwd });
  const sess = await client.wait((f) => f.type === "session" && f.sessionId, 120_000, "session");
  const SID = sess.sessionId;
  client.subscribe(SID, scratch.cwd);
  await client.wait((f) => f.type === "feed" && f.sessionId === SID && f.catchUp, 20_000, "catch-up");
  client.send({ type: "prompt", sessionId: SID, text: SHORT, clientMsgId: `cli_1_${Date.now()}` });
  await client.until(SID, (st) => st.turnEndSeq > 0, 240_000, "first turn to finish");
  const dir = scratch.sessionDir(SID);
  r.check(
    client.assistantText(SID).trim().length > 0 &&
      sameText(client.assistantText(SID), diskAssistantText(dir)),
    `Desk drove a real turn on ${SID.slice(0, 8)} and the feed equals updates.jsonl`,
    "the baseline turn did not project cleanly",
  );
  r.check(!client.state(SID).readOnly, "unowned session is sendable (readOnly false)");

  /* -- 2. a live `grok` takes the session -------------------------------- */
  console.log("\n2. a live terminal `grok` takes ownership");
  const grokProc = await startFakeGrok("owner");
  writeRegistry([
    {
      session_id: SID,
      pid: grokProc.pid,
      cwd: scratch.cwd,
      opened_at: new Date().toISOString(),
    },
  ]);
  const subsBefore = client.frames.filter((f) => f.type === "feed").length;
  const locked = await client.until(SID, (st) => st.readOnly, 15_000, "read-only to arrive");
  r.ok(`Desk went read-only on its own — owner pid ${locked.owner?.pid} (no reload)`);
  assert.equal(locked.owner?.pid, grokProc.pid, "the frame must name the owning pid");
  r.check(locked.owner?.kind === "tui", `owner reported as kind=${locked.owner?.kind}`);
  r.check(
    client.frames.filter((f) => f.type === "feed").length > subsBefore,
    "the lock arrived as a pushed feed frame",
  );

  /* -- 3. refuse to attach ----------------------------------------------- */
  console.log("\n3. Desk must refuse to attach the ACP worker");
  const beforeLoad = client.since();
  client.send({ type: "load_session", sessionId: SID, cwd: scratch.cwd });
  const loaded = await client.wait(
    (f) => f.type === "session_loaded" && f.sessionId === SID,
    30_000,
    "session_loaded",
    beforeLoad,
  );
  r.check(loaded.agentResumed === false, "WS session/load refused — agentResumed:false");
  r.check(loaded.readOnly === true, "WS session_loaded is marked readOnly");
  r.check(loaded.owner?.pid === grokProc.pid, `WS refusal names the owning pid ${grokProc.pid}`);
  r.check(
    (loaded.messages?.length ?? 0) > 0,
    `the transcript is still served from disk (${loaded.messages?.length} rows)`,
  );

  assertAlive(grokProc, "the HTTP load refusal");
  const httpLoad = await api(port, "/api/load-session", {
    method: "POST",
    body: JSON.stringify({ sessionId: SID, cwd: scratch.cwd }),
  });
  r.check(httpLoad.agentResumed === false, "POST /api/load-session refused — agentResumed:false");
  r.check(httpLoad.readOnly === true, "HTTP refusal is marked readOnly");
  r.check(httpLoad.owner?.pid === grokProc.pid, "HTTP refusal names the owning pid");

  assertAlive(grokProc, "the prompt refusal");
  const beforeErr = client.since();
  client.send({ type: "prompt", sessionId: SID, text: "this must not be sent", clientMsgId: `cli_x_${Date.now()}` });
  const err = await client.wait((f) => f.type === "error" && f.sessionId === SID, 15_000, "refusal", beforeErr);
  r.check(err.code === "session_owned", `a prompt on an owned session is refused (${err.code})`);
  await sleep(600);
  r.check(
    !client.frames.slice(beforeErr).some((f) => f.type === "turn_start" && f.sessionId === SID),
    "no turn was started for the refused prompt",
  );

  /* -- 4. the feed still tails the owner's writes, live ------------------ */
  console.log("\n4. the feed still mirrors the terminal while it owns the session");
  assertAlive(grokProc, "the live-tail check");
  const marker = `[terminal-wrote-${Date.now().toString(36)}]`;
  const t0 = Date.now();
  fs.appendFileSync(path.join(dir, "updates.jsonl"), upLine(SID, marker) + "\n");
  await client.until(SID, (st) => JSON.stringify(st.messages).includes(marker), 5000, "the CLI's line");
  const lag = Date.now() - t0;
  r.check(lag <= 1000, `the terminal's append reached Desk in ${lag} ms (≤ 1000)`, `took ${lag} ms`);
  r.check(
    sameText(client.assistantText(SID), diskAssistantText(dir)),
    "the projection still equals updates.jsonl",
  );

  /* -- 5. delete is refused ---------------------------------------------- */
  console.log("\n5. delete must be refused while a live grok holds the store");
  assertAlive(grokProc, "the delete refusal");
  const del = await api(port, "/api/build/session-delete", {
    method: "POST",
    body: JSON.stringify({ sessionId: SID, cwd: scratch.cwd }),
  });
  r.check(del.ok === false, "deleteSession refused");
  r.check(
    String(del.error || "").includes(String(grokProc.pid)),
    `the refusal names the owning pid — "${del.error}"`,
  );
  r.check(fs.existsSync(dir), "the session directory is still on disk");

  /* -- 6. auto-takeover, no reload --------------------------------------- */
  console.log("\n6. the owner exits → sendable again, with no reload");
  const feedFramesBefore = client.frames.filter((f) => f.type === "feed").length;
  const gapsBefore = client.gaps;
  process.kill(grokProc.pid, "SIGKILL");
  // The registry row is deliberately LEFT BEHIND: a `grok` that was killed (or
  // a machine that rebooted) never gets to clean up after itself, and Desk must
  // still hand the session back.
  const free = await client.until(SID, (st) => !st.readOnly, 20_000, "read-only to clear");
  r.ok("the composer unlocked itself — no reload, no resubscribe");
  assert.equal(free.owner, null, "the takeover frame clears the owner");
  r.check(
    String(fs.readFileSync(path.join(scratch.home, "active_sessions.json"), "utf8")).includes(
      String(grokProc.pid),
    ),
    "and it unlocked with the STALE registry row still on disk (dead pid ≠ owner)",
  );
  r.check(client.gaps === gapsBefore, "the takeover did not force a client resubscribe");
  r.check(
    client.frames.filter((f) => f.type === "feed").length > feedFramesBefore,
    "the takeover arrived as a pushed feed frame",
  );

  const beforeSend = client.since();
  client.send({ type: "prompt", sessionId: SID, text: SECOND, clientMsgId: `cli_2_${Date.now()}` });
  await client.wait((f) => f.type === "turn_start" && f.sessionId === SID, 120_000, "turn_start", beforeSend);
  await client.until(SID, (st) => st.turnEndSeq > 0 && st.messages.length >= 5, 240_000, "second turn");
  r.ok("Desk attached and completed a real turn after the takeover");
  r.check(
    sameText(client.assistantText(SID), diskAssistantText(dir)),
    "post-takeover projection still equals updates.jsonl",
  );

  /* -- 7. a recycled / non-grok pid is not an owner ---------------------- */
  console.log("\n7. a recycled pid must not impersonate an owner");
  const notGrok = spawn("/bin/sleep", ["900"], { stdio: "ignore" });
  spawned.push(notGrok);
  await sleep(200);
  writeRegistry([
    { session_id: SID, pid: notGrok.pid, cwd: scratch.cwd, opened_at: new Date().toISOString() },
  ]);
  await sleep(2500); // longer than the ownership tick + the ps cache
  const httpFeed = await api(port, `/api/sessions/${SID}/feed?from=0&limit=5`);
  r.check(
    httpFeed.owner === null,
    `a live non-grok pid (${notGrok.pid}, /bin/sleep) is NOT an owner`,
    `owner leaked through: ${JSON.stringify(httpFeed.owner)}`,
  );
  r.check(!client.state(SID).readOnly, "and the composer stayed unlocked");
  r.check(
    Object.prototype.hasOwnProperty.call(httpFeed, "working"),
    "GET /api/sessions/:id/feed carries `working`, like the WS feed frame",
  );
  const wsFeed = [...client.frames].reverse().find((f) => f.type === "feed" && f.sessionId === SID);
  const missing = ["live", "phase", "owner", "working", "context", "subagents", "turn", "truncated", "hasMore"]
    .filter((k) => !Object.prototype.hasOwnProperty.call(httpFeed, k));
  r.check(missing.length === 0, "HTTP and WS feed payloads carry the same keys", `HTTP is missing ${missing}`);
  r.check(httpFeed.working === wsFeed.working, `working agrees across transports (${httpFeed.working})`);

  /* -- 8. and a dead pid never was ---------------------------------------- */
  writeRegistry([
    { session_id: SID, pid: 2147483646, cwd: scratch.cwd, opened_at: new Date().toISOString() },
  ]);
  await sleep(2200);
  r.check(!client.state(SID).readOnly, "a dead pid in the registry never locks the session");
} catch (e) {
  r.fail();
  console.error("\n✗ smoke:cli threw:", e?.stack || e);
  const tail = client?.frames.filter((f) => f.type === "feed").slice(-8) || [];
  console.error("\n--- last feed frames ---");
  for (const f of tail) {
    console.error(
      `  ${f.fromSeq}→${f.seq} owner=${f.owner?.pid ?? "-"} working=${f.working} ` +
        `events=[${(f.events || []).map((e) => `${e.kind}:${e.seq}`).join(",")}]`,
    );
  }
  console.error("\n--- daemon log ---\n" + scratch.daemonLog(60));
} finally {
  client?.close();
  killSpawned();
  const survivors = scratch.survivorLines();
  console.log(`\n  smoke process group before cleanup: ${survivors.length} process(es)`);
  for (const line of survivors) console.log("   ", line.slice(0, 110));
  await scratch.stop();
  killSpawned();
  const left = scratch.survivorLines();
  const helpers = spawned.filter((p) => {
    try {
      process.kill(p.pid, 0);
      return true;
    } catch {
      return false;
    }
  });
  console.log(
    `  after cleanup: ${left.length || helpers.length ? `${left.length} daemon-group + ${helpers.length} helper(s) LEFT` : "none"}`,
  );
  if (left.length || helpers.length) r.fail();
}

/* ===================================================================== real
 * THE CLOBBER PROOF.
 *
 * A real `grok` TUI, a real session, real turns — and Desk opening the same
 * chat in the middle of it. `chat_history.jsonl` is the file that gets
 * rewritten whole at the end of a turn, so the numbers that matter are its turn
 * counts before and after Desk gets involved: every line the terminal wrote has
 * to still be there, byte for byte, at the end.
 *
 * The TUI needs a tty, so it runs behind a small python pty bridge that
 * forwards this process's pipe into the pty master. Everything (bridge, TUI,
 * every process it spawns) lives in one process group that is killed on the way
 * out, and the survivors are printed.
 * =========================================================================== */

/** stdin(pipe) → pty master → `grok`, so a TUI can be driven from node. */
const PTY_BRIDGE = `
import os, pty, sys, select, signal
argv = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0:
    os.environ["TERM"] = "xterm-256color"
    os.execvp(argv[0], argv)
os.write(2, ("PTYCHILD %d\\n" % pid).encode())
try:
    while True:
        rl, _, _ = select.select([0, fd], [], [], 0.2)
        if 0 in rl:
            data = os.read(0, 4096)
            if not data: break
            os.write(fd, data)
        if fd in rl:
            try: out = os.read(fd, 4096)
            except OSError: break
            if not out: break
            os.write(1, out)
finally:
    try: os.kill(pid, signal.SIGKILL)
    except Exception: pass
`;

if (REAL) {
  const real = new Scratch("p4real");
  let tui = null;
  let tuiPid = null;
  let rclient = null;
  const grokBin = process.env.GROK_BIN || path.join(process.env.HOME || "", ".grok", "bin", "grok");
  const chatLines = (d) => {
    try {
      return fs.readFileSync(path.join(d, "chat_history.jsonl"), "utf8").split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
  /**
   * `chat_history.jsonl` is REWRITTEN whole every turn, so comparing raw lines
   * proves nothing — the CLI legitimately reserialises what it already had. The
   * question is whether the terminal's TURNS are still in there, so read them
   * as messages: the human turns (wrapped in <user_query>) and the assistant
   * replies. Those are what a clobber would destroy.
   */
  const historyOf = (d) => {
    const users = [];
    let assistants = 0;
    for (const line of chatLines(d)) {
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      const type = String(m?.type || m?.role || "");
      const content =
        typeof m?.content === "string"
          ? m.content
          : Array.isArray(m?.content)
            ? m.content.map((c) => (typeof c === "string" ? c : c?.text || "")).join("")
            : "";
      if (type === "assistant") assistants += 1;
      if (type === "user") {
        const q = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/.exec(content);
        if (q) users.push(q[1].trim());
      }
    }
    return { users, assistants, lines: chatLines(d).length };
  };
  /** Completed turns, straight out of the CLI's own events.jsonl. */
  const turnsEnded = (d) => {
    try {
      return fs
        .readFileSync(path.join(d, "events.jsonl"), "utf8")
        .split("\n")
        .filter((l) => l.includes('"turn_ended"') || l.includes('"turn_completed"')).length;
    } catch {
      return 0;
    }
  };
  /** Wait until the CLI finishes a turn (or give up). */
  const waitTurn = async (d, was, ms = 300_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (turnsEnded(d) > was) return true;
      await sleep(500);
    }
    return false;
  };
  /** Everything under this scratch root, whoever reparented it. */
  const strays = () => {
    try {
      return execFileSync("ps", ["-eo", "pid=,command="], { encoding: "utf8" })
        .split("\n")
        .filter((l) => l.includes(real.root))
        .map((l) => l.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  };
  const killTui = () => {
    for (const p of [tuiPid, tui?.pid]) {
      if (!p) continue;
      try {
        process.kill(-p, "SIGKILL");
      } catch {
        /* */
      }
      try {
        process.kill(p, "SIGKILL");
      } catch {
        /* */
      }
    }
    for (const line of strays()) {
      const pid = Number(line.split(/\s+/)[0]);
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* */
        }
      }
    }
  };

  try {
    console.log(`\nP4 CLOBBER PROOF — a real terminal grok\n  home ${real.home}`);
    assert.ok(fs.existsSync(grokBin), `grok CLI not found at ${grokBin}`);

    /* -- 1. a real TUI, a real turn ------------------------------------- */
    console.log("\n1. start a real `grok` TUI and give it a turn");
    const tuiLog = fs.openSync(path.join(real.root, "tui.log"), "a");
    tui = spawn("python3", ["-c", PTY_BRIDGE, grokBin, "--cwd", real.cwd], {
      cwd: real.cwd,
      env: { ...process.env, GROK_HOME: real.home, NO_COLOR: "1" },
      stdio: ["pipe", tuiLog, "pipe"],
      detached: true,
    });
    tui.stderr.on("data", (b) => {
      const m = /PTYCHILD (\d+)/.exec(String(b));
      if (m) tuiPid = Number(m[1]);
    });
    await sleep(6000);
    tui.stdin.write("\r"); // dismiss whatever the first screen is
    await sleep(1500);
    tui.stdin.write("Reply with exactly: one\r");

    let row = null;
    for (let i = 0; i < 240 && !row; i += 1) {
      try {
        const rows = JSON.parse(fs.readFileSync(path.join(real.home, "active_sessions.json"), "utf8"));
        if (Array.isArray(rows) && rows.length) row = rows[0];
      } catch {
        /* not written yet */
      }
      if (!row) await sleep(500);
    }
    assert.ok(row, "the TUI never registered in active_sessions.json");
    const SID = row.session_id;
    r.ok(`the TUI registered ${SID.slice(0, 8)} — pid ${row.pid}, cwd ${row.cwd}`);
    // The registry records the REAL path (/private/var/...) while os.tmpdir()
    // hands out /var/... — the exact symlink skew the cwd normalisation fixes.
    r.check(
      row.cwd !== real.cwd,
      `registry cwd ${row.cwd} ≠ tmpdir cwd ${real.cwd} — the /private skew is live here`,
      "no symlink skew on this machine; the normalisation is untested by this run",
    );
    const dir = path.join(real.home, "sessions", encodeURIComponent(row.cwd), SID);
    assert.ok(fs.existsSync(dir), `session dir not found: ${dir}`);

    r.check(await waitTurn(dir, 0), "terminal turn 1 completed", "terminal turn 1 never finished");
    const before = historyOf(dir);
    r.check(
      before.users.length >= 1 && before.assistants >= 1,
      `terminal turn 1 landed — ${before.users.length} user turn(s), ` +
        `${before.assistants} assistant message(s), ${before.lines} chat_history lines`,
      `chat_history did not record the turn: ${JSON.stringify(before)}`,
    );

    /* -- 2. Desk opens the very same session ---------------------------- */
    console.log("\n2. Desk opens the same session while the TUI still holds it");
    const feedmod = await loadFeedStore();
    const port = await real.startDaemon();
    rclient = new Client("desk", port, feedmod);
    await rclient.open();
    rclient.subscribe(SID, row.cwd);
    await rclient.wait((f) => f.type === "feed" && f.sessionId === SID, 30_000, "feed");
    const lockedReal = await rclient.until(SID, (st) => st.readOnly, 20_000, "read-only");
    r.check(lockedReal.owner?.pid === row.pid, `Desk sees the real TUI as the owner (pid ${row.pid})`);

    rclient.send({ type: "load_session", sessionId: SID, cwd: row.cwd });
    const rLoaded = await rclient.wait(
      (f) => f.type === "session_loaded" && f.sessionId === SID,
      30_000,
      "session_loaded",
    );
    r.check(rLoaded.agentResumed === false, "Desk refused to attach an ACP worker to the live session");
    r.check(
      rclient.assistantText(SID).trim().length > 0,
      `Desk is showing the terminal's turn (${rclient.assistantText(SID).trim().length} chars projected)`,
    );

    /* -- 3. the terminal takes another turn ----------------------------- */
    console.log("\n3. the terminal takes another turn with Desk watching");
    const endedBefore = turnsEnded(dir);
    tui.stdin.write("Reply with exactly: two\r");
    r.check(await waitTurn(dir, endedBefore), "terminal turn 2 completed", "terminal turn 2 never finished");
    const after = historyOf(dir);
    r.check(
      after.users.length > before.users.length && after.assistants > before.assistants,
      `terminal turn 2 landed — user turns ${before.users.length} → ${after.users.length}, ` +
        `assistant messages ${before.assistants} → ${after.assistants}, ` +
        `chat_history lines ${before.lines} → ${after.lines}`,
      `chat_history did not grow: ${JSON.stringify(before)} → ${JSON.stringify(after)}`,
    );
    const lost = before.users.filter((u) => !after.users.includes(u));
    r.check(
      lost.length === 0,
      `every one of the terminal's ${before.users.length} earlier turn(s) is still there`,
      `THE CLOBBER HAPPENED — lost terminal turns: ${JSON.stringify(lost)}`,
    );

    /* -- 4. the terminal quits, Desk takes over, history still intact ---- */
    console.log("\n4. the terminal quits → Desk takes over and writes its own turn");
    killTui();
    await rclient.until(SID, (st) => !st.readOnly, 30_000, "the takeover");
    r.ok("Desk unlocked itself when the real TUI exited");
    rclient.send({
      type: "prompt",
      sessionId: SID,
      text: "Reply with exactly: three",
      clientMsgId: `real_${Date.now()}`,
    });
    await rclient.until(SID, (st) => st.turnEndSeq > 0, 300_000, "Desk's own turn");
    // chat_history.jsonl is rewritten at the END of the turn; give that write
    // time to land rather than reading the file mid-flight.
    for (let i = 0; i < 40 && historyOf(dir).assistants <= after.assistants; i += 1) await sleep(500);
    const final = historyOf(dir);
    r.check(
      final.users.length > after.users.length,
      `Desk's turn appended — user turns ${after.users.length} → ${final.users.length}, ` +
        `assistant messages ${after.assistants} → ${final.assistants}`,
    );
    const lostAfterDesk = after.users.filter((u) => !final.users.includes(u));
    r.check(
      lostAfterDesk.length === 0 && final.assistants >= after.assistants,
      `all ${after.users.length} terminal turn(s) are STILL intact after Desk wrote the same session`,
      `DESK CLOBBERED THE TERMINAL — lost: ${JSON.stringify(lostAfterDesk)}, ` +
        `assistants ${after.assistants} → ${final.assistants}`,
    );
    console.log(
      `\n  chat_history.jsonl — user turns ${before.users.length} → ${after.users.length} → ${final.users.length}` +
        ` · assistant messages ${before.assistants} → ${after.assistants} → ${final.assistants}` +
        ` · lines ${before.lines} → ${after.lines} → ${final.lines}`,
    );
    console.log(`  turns on record: ${JSON.stringify(final.users)}`);
  } catch (e) {
    r.fail();
    console.error("\n✗ clobber proof threw:", e?.stack || e);
    try {
      console.error(
        "\n--- tui log tail ---\n" +
          fs
            .readFileSync(path.join(real.root, "tui.log"), "utf8")
            .replace(/\[[0-9;?]*[a-zA-Z]/g, "")
            .slice(-1500),
      );
    } catch {
      /* */
    }
    console.error("\n--- daemon log ---\n" + real.daemonLog(40));
  } finally {
    rclient?.close();
    killTui();
    await real.stop();
    killTui();
    await sleep(500);
    const left = [...real.survivorLines(), ...strays()];
    console.log(`\n  after cleanup: ${left.length ? `${left.length} LEFT` : "none"}`);
    for (const line of left) console.log("   ", line.slice(0, 120));
    if (left.length) r.fail();
  }
}

if (r.failures) {
  console.log(`\nSMOKE CLI FAIL — ${r.failures} problem(s)`);
  process.exit(1);
}
console.log(`\n${REAL ? "CLOBBER PROOF PASS" : "SMOKE CLI PASS"}`);
