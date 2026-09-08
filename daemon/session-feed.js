/**
 * Session feed projector — read-only, cursor-based projection of the Grok CLI's
 * own on-disk session store.
 *
 * Truth lives in ~/.grok/sessions/<encodeURIComponent(cwd)>/<sessionId>/:
 *   updates.jsonl  — authoritative conversation log (JSON-RPC frames, append-only)
 *   events.jsonl   — live turn telemetry ({ts,type,...})
 *   summary.json   — session metadata
 *   signals.json   — context window / tool counters
 *   subagents/<childId>/{meta.json,output.json}
 *
 * This module NEVER writes into ~/.grok/sessions. It only stats, opens "r",
 * and reads.
 *
 * Cursor = { updatesBytes, eventsBytes, seq }
 *   - byte offsets always point at the FIRST BYTE OF THE NEXT (possibly
 *     incomplete) line, so a torn CLI append is simply re-read next tick
 *     rather than being half-parsed. Nothing partial is carried in memory,
 *     which makes the cursor restart-safe.
 *   - seq is monotonic per session, taken from the numeric suffix of
 *     `_meta.eventId` (`<sessionId>-<n>`), clamped so it can never go
 *     backwards; a running counter fills in when eventId is absent
 *     (every events.jsonl row) or malformed.
 *
 * P2 owns the fs watchers. This module never installs one and never runs a
 * timer: call `poll(sessionId)` when something tells you the files moved.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  sessionsRoot,
  findSessionDir,
  findSessionCwd,
  readSummary,
  isSubagentKind,
} from "./session-store.js";

/** Bytes pulled per readSync — bounds memory on 500 MB updates.jsonl files. */
const CHUNK = 1 << 20;
/** FeedEvents retained in memory per session (the "tail window"). */
const MAX_BUFFER = 3000;
/** Default number of events returned by read(). */
const DEFAULT_LIMIT = 1000;
/** Skip absurd subagent outputs rather than paging them into every read. */
const MAX_OUTPUT_BYTES = 1 << 20;

const NEWLINE = 0x0a;
const EMPTY = Buffer.alloc(0);

/* ------------------------------------------------------------------ paths */

/** ~/.grok (or $GROK_HOME) — derived from session-store, never re-implemented. */
export function grokHome() {
  return path.dirname(sessionsRoot());
}

export function activeSessionsPath() {
  return path.join(grokHome(), "active_sessions.json");
}

/* ------------------------------------------------------------ line reader */

/**
 * Lazily yield complete lines from `file` starting at byte `fromBytes`.
 * A trailing fragment with no "\n" is held back: `end` never advances past
 * the last newline, so the next pass re-reads the torn bytes.
 *
 * @yields {{ text: string, end: number }} end = byte offset just past the "\n"
 */
function* lineIterator(file, fromBytes, counter) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return;
  }
  if (!stat.isFile()) return;
  let offset = fromBytes > 0 ? fromBytes : 0;
  if (stat.size < offset) offset = 0; // truncated / rotated → resync
  if (offset >= stat.size) return;

  let fd;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return;
  }
  try {
    const chunk = Buffer.allocUnsafe(CHUNK);
    let acc = EMPTY;
    let accStart = offset;
    while (offset < stat.size) {
      const want = Math.min(CHUNK, stat.size - offset);
      const n = fs.readSync(fd, chunk, 0, want, offset);
      if (n <= 0) break;
      offset += n;
      if (counter) counter.bytes += n;
      acc = acc.length
        ? Buffer.concat([acc, chunk.subarray(0, n)])
        : Buffer.from(chunk.subarray(0, n));
      let start = 0;
      let nl;
      while ((nl = acc.indexOf(NEWLINE, start)) >= 0) {
        yield { text: acc.toString("utf8", start, nl), end: accStart + nl + 1 };
        start = nl + 1;
      }
      if (start > 0) {
        accStart += start;
        acc = start >= acc.length ? EMPTY : Buffer.from(acc.subarray(start));
      }
    }
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* */
    }
  }
}

/**
 * Peekable record stream over a line iterator.
 * `end` tracks the byte offset of the last line CONSUMED (parseable or not),
 * so the cursor advances past junk lines instead of re-reading them forever.
 */
function recordStream(iter, parse) {
  const state = { cur: null, end: -1, closed: false };
  const pull = () => {
    for (;;) {
      const r = iter.next();
      if (r.done) {
        state.cur = null;
        state.closed = true;
        return;
      }
      state.pendingEnd = r.value.end;
      const rec = parse(r.value.text);
      if (rec) {
        state.cur = rec;
        return;
      }
      // unparseable / blank — still consume its bytes
      state.end = r.value.end;
    }
  };
  pull();
  return {
    peek: () => state.cur,
    next() {
      const v = state.cur;
      if (v) state.end = state.pendingEnd;
      pull();
      return v;
    },
    get end() {
      return state.end;
    },
    close() {
      try {
        iter.return?.();
      } catch {
        /* */
      }
    },
  };
}

/* -------------------------------------------------------------- normalize */

function contentText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(contentText).join("");
  if (typeof content !== "object") return "";
  if (content.type === "text" && typeof content.text === "string") return content.text;
  if (typeof content.text === "string") return content.text;
  return "";
}

function contentImage(content) {
  if (!content || typeof content !== "object" || Array.isArray(content)) return null;
  if (content.type !== "image") return null;
  return {
    mimeType: content.mimeType || content.mime_type || null,
    data: typeof content.data === "string" ? content.data : null,
  };
}

/** tool_call_update content is [{type:"content",content:{type:"text",text}}]. */
function toolOutputText(content) {
  if (content == null) return "";
  if (!Array.isArray(content)) return contentText(content);
  return content
    .map((c) => {
      if (!c) return "";
      if (typeof c === "string") return c;
      if (c.type === "content") return contentText(c.content);
      return contentText(c);
    })
    .join("");
}

function lower(v) {
  return v == null ? undefined : String(v).toLowerCase();
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Numeric suffix of `<sessionId>-<n>`, else null. */
function eventIdSeq(eventId) {
  if (typeof eventId !== "string") return null;
  const m = /-(\d+)$/.exec(eventId);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/**
 * `updates.jsonl` line → intermediate record.
 * Returns null for blank/malformed lines (they are skipped, not dropped
 * silently — the byte cursor still advances past them).
 */
function parseUpdatesLine(text, ctx) {
  if (!text || !text.trim()) return null;
  let row;
  try {
    row = JSON.parse(text);
  } catch {
    return null;
  }
  const update = row?.params?.update || row?.update;
  if (!update || typeof update !== "object") return null;
  const meta = row?.params?._meta || {};
  let at = num(meta.agentTimestampMs);
  if (at == null) {
    const ts = num(row.timestamp);
    at = ts == null ? null : ts * 1000;
  }
  if (at == null) at = ctx.lastAt;
  ctx.lastAt = at;
  return {
    src: "updates",
    at,
    candidate: eventIdSeq(meta.eventId),
    sessionId: row?.params?.sessionId || null,
    method: row.method || null,
    meta,
    update,
  };
}

/** `events.jsonl` line → intermediate record. */
function parseEventsLine(text, ctx) {
  if (!text || !text.trim()) return null;
  let row;
  try {
    row = JSON.parse(text);
  } catch {
    return null;
  }
  if (!row || typeof row !== "object" || !row.type) return null;
  let at = Date.parse(row.ts);
  if (!Number.isFinite(at)) at = ctx.lastAt;
  ctx.lastAt = at;
  return { src: "events", at, candidate: null, row };
}

const UPDATE_KIND = {
  user_message_chunk: "user_message",
  agent_message_chunk: "agent_message",
  agent_thought_chunk: "agent_thought",
  tool_call: "tool_call",
  tool_call_update: "tool_call_update",
  plan: "plan",
  turn_completed: "turn_completed",
  subagent_spawned: "subagent_start",
  subagent_finished: "subagent_finish",
  task_backgrounded: "task_backgrounded",
  task_completed: "task_completed",
};

const EVENT_KIND = {
  turn_started: "turn_start",
  turn_ended: "turn_end",
  phase_changed: "phase",
  tool_started: "tool_status",
  tool_completed: "tool_status",
  permission_requested: "permission_request",
  permission_resolved: "permission_resolve",
};

/** updates record → FeedEvent */
function normalizeUpdate(rec, seq, sessionId) {
  const u = rec.update;
  const raw = String(u.sessionUpdate || u.type || "unknown");
  const kind = UPDATE_KIND[raw] || "other";
  const ev = { seq, at: rec.at, sessionId, kind, src: "updates" };
  if (rec.meta?.promptId) ev.promptId = rec.meta.promptId;
  const tokens = num(rec.meta?.totalTokens);
  if (tokens != null) ev.totalTokens = tokens;

  switch (kind) {
    case "user_message":
    case "agent_message":
    case "agent_thought": {
      ev.text = contentText(u.content ?? u.text ?? "");
      const img = contentImage(u.content);
      if (img) ev.image = img;
      return ev;
    }
    case "tool_call": {
      ev.toolCallId = String(u.toolCallId || u.tool_call_id || u.id || "");
      ev.title = u.title == null ? undefined : String(u.title);
      ev.toolKind = lower(u.kind);
      ev.status = lower(u.status) || "pending";
      if (u.rawInput !== undefined) ev.rawInput = u.rawInput;
      if (Array.isArray(u.locations)) ev.locations = u.locations;
      return ev;
    }
    case "tool_call_update": {
      ev.toolCallId = String(u.toolCallId || u.tool_call_id || u.id || "");
      if (u.title != null) ev.title = String(u.title);
      if (u.kind != null) ev.toolKind = lower(u.kind);
      if (u.status != null) ev.status = lower(u.status);
      const out = toolOutputText(u.content);
      if (out) ev.output = out;
      if (u.rawOutput !== undefined) ev.rawOutput = u.rawOutput;
      if (u.rawInput !== undefined) ev.rawInput = u.rawInput;
      if (Array.isArray(u.locations)) ev.locations = u.locations;
      return ev;
    }
    case "plan": {
      ev.entries = Array.isArray(u.entries)
        ? u.entries.map((e) => ({
            content: String(e?.content ?? ""),
            status: lower(e?.status) || "pending",
            priority: e?.priority == null ? undefined : lower(e.priority),
          }))
        : [];
      return ev;
    }
    case "subagent_start": {
      ev.subagentId = u.subagent_id || u.subagentId || null;
      ev.childSessionId = u.child_session_id || u.childSessionId || null;
      ev.parentSessionId = u.parent_session_id || u.parentSessionId || null;
      ev.subagentType = u.subagent_type || u.subagentType || null;
      ev.description = u.description == null ? null : String(u.description);
      ev.role = u.role || null;
      ev.model = u.model || u.effective_model_id || null;
      ev.capabilityMode = u.capability_mode || null;
      return ev;
    }
    case "subagent_finish": {
      ev.subagentId = u.subagent_id || u.subagentId || null;
      ev.childSessionId = u.child_session_id || u.childSessionId || null;
      ev.status = lower(u.status) || null;
      ev.toolCalls = num(u.tool_calls);
      ev.turns = num(u.turns);
      ev.durationMs = num(u.duration_ms);
      ev.tokensUsed = num(u.tokens_used);
      if (typeof u.output === "string") ev.output = u.output;
      if (u.will_wake != null) ev.willWake = Boolean(u.will_wake);
      return ev;
    }
    case "task_backgrounded": {
      ev.taskId = u.task_id || u.taskId || null;
      ev.toolCallId = u.tool_call_id || u.toolCallId || null;
      ev.command = u.command == null ? null : String(u.command);
      ev.cwd = u.cwd || null;
      ev.outputFile = u.output_file || u.outputFile || null;
      ev.description = u.description == null ? null : String(u.description);
      return ev;
    }
    case "task_completed": {
      ev.taskId = u.task_id || u.taskId || null;
      ev.toolCallId = u.tool_call_id || u.toolCallId || null;
      ev.status = lower(u.status) || undefined;
      ev.exitCode = num(u.exit_code ?? u.exitCode);
      ev.raw = u;
      return ev;
    }
    case "turn_completed": {
      ev.stopReason = u.stop_reason || u.stopReason || undefined;
      ev.raw = u;
      return ev;
    }
    default: {
      // Never drop a kind we do not recognise — pass it through whole.
      ev.type = raw;
      ev.method = rec.method || undefined;
      ev.raw = u;
      return ev;
    }
  }
}

/** events record → FeedEvent */
function normalizeEvent(rec, seq, sessionId) {
  const r = rec.row;
  const type = String(r.type);
  const kind = EVENT_KIND[type] || "other";
  const ev = { seq, at: rec.at, sessionId, kind, src: "events" };

  switch (kind) {
    case "turn_start":
      ev.turnNumber = num(r.turn_number);
      ev.modelId = r.model_id || null;
      ev.yoloMode = r.yolo_mode == null ? undefined : Boolean(r.yolo_mode);
      ev.relationship = r.session_relationship || null;
      ev.messageCount = num(r.conversation_message_count);
      return ev;
    case "turn_end":
      ev.outcome = r.outcome == null ? null : String(r.outcome);
      return ev;
    case "phase":
      ev.phase = r.phase == null ? null : String(r.phase);
      return ev;
    case "tool_status":
      ev.tool = r.tool_name || null;
      ev.phase = type === "tool_started" ? "started" : "completed";
      ev.toolCallId = r.tool_call_id || null;
      ev.durationMs = num(r.duration_ms);
      ev.outcome = r.outcome == null ? undefined : String(r.outcome);
      return ev;
    case "permission_request":
      ev.tool = r.tool_name || null;
      return ev;
    case "permission_resolve":
      ev.tool = r.tool_name || null;
      ev.decision = r.decision == null ? null : String(r.decision);
      ev.waitMs = num(r.wait_ms);
      return ev;
    default:
      ev.type = type;
      ev.raw = r;
      return ev;
  }
}

/* ------------------------------------------------------------------ state */

/** sessionId → tail state. Purely in-memory; safe to drop at any time. */
const states = new Map();

function newState(sessionId, dir, cwd) {
  return {
    sessionId: String(sessionId),
    dir,
    cwd: cwd || null,
    cursor: { updatesBytes: 0, eventsBytes: 0, seq: 0 },
    buf: [],
    dropped: 0,
    maxBuffer: MAX_BUFFER,
    live: false,
    turn: null,
    phase: null,
    phaseAt: null,
    logSubagents: new Map(),
    subagentsCache: null,
    lastBytesRead: 0,
    totalBytesRead: 0,
  };
}

function resetDerived(st) {
  st.buf.length = 0;
  st.dropped = 0;
  st.live = false;
  st.turn = null;
  st.phase = null;
  st.phaseAt = null;
  st.logSubagents.clear();
}

function applyDerived(st, ev) {
  switch (ev.kind) {
    case "turn_start":
      st.live = true;
      st.turn = {
        number: ev.turnNumber ?? null,
        modelId: ev.modelId ?? null,
        yoloMode: ev.yoloMode ?? null,
        relationship: ev.relationship ?? null,
        startedAt: ev.at,
      };
      break;
    case "turn_end":
      st.live = false;
      if (st.turn) st.turn = { ...st.turn, endedAt: ev.at, outcome: ev.outcome ?? null };
      break;
    case "phase":
      st.phase = ev.phase;
      st.phaseAt = ev.at;
      break;
    case "subagent_start": {
      const id = ev.childSessionId || ev.subagentId;
      if (!id) break;
      st.logSubagents.set(id, {
        ...(st.logSubagents.get(id) || {}),
        id,
        subagentId: ev.subagentId || id,
        childSessionId: ev.childSessionId || id,
        parentSessionId: ev.parentSessionId || st.sessionId,
        type: ev.subagentType || null,
        description: ev.description || null,
        role: ev.role || null,
        model: ev.model || null,
        status: "running",
        startedAt: ev.at,
      });
      break;
    }
    case "subagent_finish": {
      const id = ev.childSessionId || ev.subagentId;
      if (!id) break;
      st.logSubagents.set(id, {
        ...(st.logSubagents.get(id) || { id, childSessionId: id }),
        id,
        subagentId: ev.subagentId || id,
        childSessionId: ev.childSessionId || id,
        status: ev.status || "completed",
        toolCalls: ev.toolCalls ?? null,
        turns: ev.turns ?? null,
        durationMs: ev.durationMs ?? null,
        tokensUsed: ev.tokensUsed ?? null,
        completedAt: ev.at,
        output: typeof ev.output === "string" ? ev.output : undefined,
      });
      break;
    }
    default:
      break;
  }
}

function pushEvent(st, ev, sink) {
  applyDerived(st, ev);
  if (!sink) return;
  sink.push(ev);
  if (sink.length > st.maxBuffer * 2) {
    const cut = sink.length - st.maxBuffer;
    sink.splice(0, cut);
    st.dropped += cut;
  }
}

function sizeOf(file) {
  try {
    const s = fs.statSync(file);
    return s.isFile() ? s.size : -1;
  } catch {
    return -1;
  }
}

/**
 * Tail both logs from the stored byte offsets, merge them into one ordered
 * FeedEvent stream and fold the derived state.
 *
 * Ordering: updates.jsonl carries the conversation in append order (its own
 * seq); events.jsonl telemetry is interleaved by timestamp. Ties go to
 * updates so the merge is deterministic.
 *
 * @returns {number} bytes read from disk on this pass
 */
function advance(st, { sink = st.buf, filterSeq = 0 } = {}) {
  const uPath = path.join(st.dir, "updates.jsonl");
  const ePath = path.join(st.dir, "events.jsonl");
  const uSize = sizeOf(uPath);
  const eSize = sizeOf(ePath);

  // Truncation / rotation — the file is shorter than where we left off.
  let resync = false;
  if (uSize >= 0 && uSize < st.cursor.updatesBytes) {
    st.cursor.updatesBytes = 0;
    resync = true;
  }
  if (eSize >= 0 && eSize < st.cursor.eventsBytes) {
    st.cursor.eventsBytes = 0;
    resync = true;
  }
  if (resync && sink === st.buf) resetDerived(st);

  const counter = { bytes: 0 };
  const uCtx = { lastAt: 0 };
  const eCtx = { lastAt: 0 };
  const uStream = recordStream(lineIterator(uPath, st.cursor.updatesBytes, counter), (t) =>
    parseUpdatesLine(t, uCtx),
  );
  const eStream = recordStream(lineIterator(ePath, st.cursor.eventsBytes, counter), (t) =>
    parseEventsLine(t, eCtx),
  );

  try {
    for (;;) {
      const a = uStream.peek();
      const b = eStream.peek();
      if (!a && !b) break;
      let rec;
      let fromUpdates;
      if (a && b) {
        fromUpdates = a.at <= b.at; // tie → updates first (deterministic)
      } else {
        fromUpdates = Boolean(a);
      }
      rec = fromUpdates ? uStream.next() : eStream.next();

      // seq: eventId suffix when we have one, clamped so it never goes back.
      const candidate = rec.candidate;
      const next =
        candidate != null && candidate > st.cursor.seq ? candidate : st.cursor.seq + 1;
      st.cursor.seq = next;

      const ev = fromUpdates
        ? normalizeUpdate(rec, next, st.sessionId)
        : normalizeEvent(rec, next, st.sessionId);
      pushEvent(st, ev, next > filterSeq ? sink : null);
    }
  } finally {
    uStream.close();
    eStream.close();
    if (uStream.end >= 0) st.cursor.updatesBytes = uStream.end;
    if (eStream.end >= 0) st.cursor.eventsBytes = eStream.end;
  }

  st.lastBytesRead = counter.bytes;
  st.totalBytesRead += counter.bytes;
  return counter.bytes;
}

/* ---------------------------------------------------------------- derived */

function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    // EPERM = the pid exists but belongs to another user → alive.
    // ESRCH  = no such process → dead.
    return e?.code === "EPERM";
  }
}

/* --------------------------------------------------------- process probe */
/*
 * P4. "Is that pid alive" is not ownership. `process.kill(pid, 0)` succeeds for
 * ANY live pid, so after a reboot or a pid wrap the registry's stale row would
 * point at whatever unrelated process now holds that number — and Desk would
 * lock a perfectly free session read-only forever. Every candidate owner is
 * therefore checked against the process table: the executable behind the pid
 * must actually be a `grok` CLI.
 *
 * Results are cached per pid for PROC_TTL_MS so a poll loop does not fork `ps`
 * on every read.
 */

/** How long a pid's `ps` verdict is trusted. */
const PROC_TTL_MS = Number(process.env.DESK_OWNER_PROC_TTL_MS || 3000);
/** How long the full process sweep is trusted — it is the expensive one. */
const SCAN_TTL_MS = Number(process.env.DESK_OWNER_SCAN_TTL_MS || 5000);
/** pid → { at, grok, command } */
const procCache = new Map();
/** ps scan of `--resume`-style headless runs → { at, byId: Map }. */
let resumeScan = { at: 0, byId: new Map() };
let psWarned = false;

function ps(args) {
  try {
    return String(execFileSync("ps", args, { encoding: "utf8", timeout: 4000 })).trim();
  } catch (e) {
    // A pid that has gone away makes ps exit 1 with no output — not a failure.
    if (e?.stdout != null && String(e.stdout).trim()) return String(e.stdout).trim();
    if (e?.status === 1) return "";
    if (!psWarned) {
      psWarned = true;
      console.warn("[feed] ps unavailable — ownership falls back to a liveness check:", e?.message);
    }
    return null; // null = could not ask, distinct from "" = asked, nothing there
  }
}

/** argv[0]'s (or comm's) basename, minus a platform suffix. */
function execName(s) {
  const first = String(s || "").trim();
  if (!first) return "";
  return path.basename(first).replace(/\.(exe|bat|cmd)$/i, "");
}

/**
 * Is `pid` a live `grok` CLI?
 *
 * Fails OPEN (`grok: true`) when `ps` itself cannot be run: the whole point of
 * this phase is that Desk must never attach to a session another `grok` holds,
 * so an unknown process is treated as an owner rather than risking the clobber.
 *
 * @returns {{grok:boolean, command:string|null}}
 */
function grokProcess(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return { grok: false, command: null };
  const now = Date.now();
  const hit = procCache.get(n);
  if (hit && now - hit.at < PROC_TTL_MS) return { grok: hit.grok, command: hit.command };

  const comm = ps(["-p", String(n), "-o", "comm="]);
  let out;
  if (comm === null) {
    out = { grok: true, command: null, unverified: true }; // no ps → fail open
  } else if (!comm) {
    out = { grok: false, command: null }; // pid gone between kill(0) and ps
  } else {
    const isGrok = execName(comm.split("\n")[0]) === "grok";
    const command = isGrok ? ps(["-p", String(n), "-o", "command="]) || comm : comm;
    out = { grok: isGrok, command: String(command).split("\n")[0] };
  }
  procCache.set(n, { at: now, grok: out.grok, command: out.command });
  if (procCache.size > 256) {
    for (const [k, v] of procCache) if (now - v.at > PROC_TTL_MS) procCache.delete(k);
  }
  return { grok: out.grok, command: out.command };
}

/**
 * Headless runs (`grok -p …`) never write ~/.grok/active_sessions.json — that
 * registry is maintained by the interactive TUI only. A headless run that
 * RESUMES an existing session does name it on its own command line
 * (`--resume <id>`), so one cached `ps` sweep attributes those.
 *
 * What this cannot see: a headless run that created its own brand-new session
 * id, because nothing on disk or in argv ties that pid to the id. Desk says so
 * out loud rather than implying full coverage — see `ownerCoverage()`.
 *
 * @returns {Map<string, {pid:number, command:string}>}
 */
function scanResumeOwners() {
  const now = Date.now();
  if (now - resumeScan.at < SCAN_TTL_MS) return resumeScan.byId;
  const byId = new Map();
  const out = ps(["-eo", "pid=,command="]);
  if (out) {
    for (const line of out.split("\n")) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (!m) continue;
      const argv = m[2];
      if (execName(argv.split(/\s+/)[0]) !== "grok") continue;
      if (isAcpWorker(argv)) continue; // Desk's own worker
      const res = /(?:^|\s)--resume[=\s]+(\S+)/.exec(argv);
      if (!res) continue;
      const id = res[1].replace(/^["']|["']$/g, "");
      if (!id || byId.has(id)) continue;
      byId.set(id, { pid: Number(m[1]), command: argv.trim() });
    }
  }
  resumeScan = { at: now, byId };
  return byId;
}

/** What ownership detection can and cannot see — the UI must not overstate it. */
export function ownerCoverage() {
  return {
    registry: true, // interactive TUI sessions (~/.grok/active_sessions.json)
    resumedHeadless: true, // `grok … --resume <id>` seen in the process table
    // A headless `grok -p` that opened a NEW session is not attributable to a
    // session id by any means available here.
    newHeadless: false,
  };
}

/**
 * Desk's OWN ACP worker (`grok agent … stdio`), which is not a competing owner.
 *
 * The registry is written by the interactive TUI and has never been observed to
 * contain an agent-mode pid — but if that ever changed, Desk would refuse to
 * load the very session its own worker holds and lock itself out of every chat.
 * A terminal `grok` is never launched as `agent … stdio`, so excluding it costs
 * the guard nothing.
 */
function isAcpWorker(command) {
  if (!command) return false;
  const argv = String(command).split(/\s+/);
  return argv.includes("agent") && argv.includes("stdio");
}

/** Resolve a cwd through symlinks; `/tmp` vs `/private/tmp` is the macOS case. */
function realCwd(cwd) {
  if (!cwd) return null;
  try {
    return fs.realpathSync(String(cwd));
  } catch {
    return String(cwd);
  }
}

/** Raw ~/.grok/active_sessions.json rows (never throws). */
export function readActiveSessions() {
  try {
    const raw = fs.readFileSync(activeSessionsPath(), "utf8");
    const rows = JSON.parse(raw);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

/**
 * The live `grok` CLI process that owns this session, or null.
 *
 * Three gates, all of which must pass — a row on its own means nothing:
 *   1. the row names this session id;
 *   2. its pid is alive;
 *   3. that pid really is a `grok` CLI (`ps`), so a recycled pid cannot
 *      impersonate an owner.
 *
 * `cwd` comes back realpath'd, because the registry has been seen recording
 * `/private/tmp/...` for a process whose argv said `/tmp/...` and the session
 * directory key is `encodeURIComponent(cwd)`.
 *
 * @returns {{sessionId:string,pid:number,cwd:string|null,openedAt:string|null,
 *            kind:"tui"|"headless",source:"registry"|"process",
 *            command:string|null}|null}
 */
export function sessionOwner(sessionId) {
  if (!sessionId) return null;
  const want = String(sessionId);
  for (const row of readActiveSessions()) {
    if (!row || String(row.session_id ?? row.sessionId) !== want) continue;
    const pid = Number(row.pid);
    if (!pidAlive(pid)) continue;
    const proc = grokProcess(pid);
    if (!proc.grok) continue; // recycled / unrelated pid — not an owner
    if (isAcpWorker(proc.command)) continue; // Desk's own worker, not a rival
    return {
      sessionId: want,
      pid,
      cwd: realCwd(row.cwd) || null,
      openedAt: row.opened_at || row.openedAt || null,
      kind: "tui",
      source: "registry",
      command: proc.command,
    };
  }
  const headless = scanResumeOwners().get(want);
  if (headless && pidAlive(headless.pid)) {
    const cwd = /(?:^|\s)--cwd[=\s]+(\S+)/.exec(headless.command)?.[1] || null;
    return {
      sessionId: want,
      pid: headless.pid,
      cwd: realCwd(cwd),
      openedAt: null,
      kind: "headless",
      source: "process",
      command: headless.command,
    };
  }
  return null;
}

/** Cheap change-detector for "who owns this session" (drives auto-takeover). */
export function ownerSignature(sessionId) {
  const o = sessionOwner(sessionId);
  return o ? `${o.pid}:${o.kind}` : "";
}

/** Test seam — drop the ps caches so a probe re-reads the process table. */
export function resetOwnerCache() {
  procCache.clear();
  resumeScan = { at: 0, byId: new Map() };
}

/** Context window usage from signals.json. */
export function readContext(dir) {
  let s;
  try {
    s = JSON.parse(fs.readFileSync(path.join(dir, "signals.json"), "utf8"));
  } catch {
    return null;
  }
  if (!s || typeof s !== "object") return null;
  return {
    usagePct: num(s.contextWindowUsage) ?? null,
    tokensUsed: num(s.contextTokensUsed) ?? null,
    windowTokens: num(s.contextWindowTokens) ?? null,
    turnCount: num(s.turnCount) ?? null,
    toolCallCount: num(s.toolCallCount) ?? null,
    errorCount: num(s.errorCount) ?? null,
    toolFailureCount: num(s.toolFailureCount) ?? null,
    toolsUsed: Array.isArray(s.toolsUsed) ? s.toolsUsed : [],
    primaryModelId: s.primaryModelId || null,
  };
}

/** subagents/<childId>/{meta.json,output.json} — cached on the dir mtime. */
function readSubagentDir(st) {
  const dir = path.join(st.dir, "subagents");
  let mtime = -1;
  try {
    const s = fs.statSync(dir);
    if (!s.isDirectory()) return [];
    mtime = s.mtimeMs;
  } catch {
    return [];
  }
  if (st.subagentsCache && st.subagentsCache.mtime === mtime) {
    return st.subagentsCache.rows;
  }
  const rows = [];
  let names = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const ent of names) {
    if (!ent.isDirectory()) continue;
    const child = path.join(dir, ent.name);
    let meta = null;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(child, "meta.json"), "utf8"));
    } catch {
      meta = null;
    }
    if (!meta || typeof meta !== "object") continue;
    const row = {
      id: meta.child_session_id || meta.subagent_id || ent.name,
      subagentId: meta.subagent_id || ent.name,
      childSessionId: meta.child_session_id || ent.name,
      parentSessionId: meta.parent_session_id || st.sessionId,
      type: meta.subagent_type || null,
      description: meta.description || null,
      status: meta.status ? String(meta.status) : null,
      startedAt: meta.started_at || null,
      completedAt: meta.completed_at || null,
      durationMs: num(meta.duration_ms) ?? null,
      toolCalls: num(meta.tool_calls) ?? null,
      turns: num(meta.turns) ?? null,
      childCwd: meta.child_cwd || null,
      worktreePath: meta.worktree_path || null,
      model: meta.effective_model_id || null,
    };
    const outPath = path.join(child, "output.json");
    try {
      const os_ = fs.statSync(outPath);
      if (os_.size > MAX_OUTPUT_BYTES) {
        row.outputTooLarge = true;
        row.outputBytes = os_.size;
      } else {
        const o = JSON.parse(fs.readFileSync(outPath, "utf8"));
        if (typeof o?.output === "string") {
          row.output = o.output;
          row.outputBytes = o.output.length;
        }
      }
    } catch {
      /* no output yet */
    }
    rows.push(row);
  }
  st.subagentsCache = { mtime, rows };
  return rows;
}

/** Merge the on-disk subagent dirs with what the log said. */
function mergeSubagents(st) {
  const byId = new Map();
  for (const row of readSubagentDir(st)) byId.set(row.id, { ...row });
  for (const [id, row] of st.logSubagents) {
    const prev = byId.get(id);
    byId.set(id, prev ? { ...row, ...prune(prev), output: prev.output ?? row.output } : row);
  }
  return [...byId.values()].sort((a, b) => String(a.startedAt || "").localeCompare(String(b.startedAt || "")));
}

/** Drop null/undefined so disk values do not blank out log values. */
function prune(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v != null) out[k] = v;
  return out;
}

function summaryOf(dir) {
  const s = readSummary(dir);
  if (!s) return null;
  return {
    id: s.info?.id || null,
    cwd: s.info?.cwd || null,
    title: s.generated_title || s.session_summary || null,
    summary: s.session_summary || null,
    createdAt: s.created_at || null,
    updatedAt: s.updated_at || null,
    lastActiveAt: s.last_active_at || null,
    numMessages: num(s.num_messages) ?? null,
    numChatMessages: num(s.num_chat_messages) ?? null,
    modelId: s.current_model_id || null,
    agentName: s.agent_name || null,
    parentSessionId: s.parent_session_id || null,
    sessionKind: s.session_kind || null,
    isSubagent: isSubagentKind(s),
  };
}

/* -------------------------------------------------------------------- API */

function getState(sessionId, cwd) {
  const sid = String(sessionId);
  let st = states.get(sid);
  if (st && fs.existsSync(st.dir)) return st;
  const dir = findSessionDir(sid, cwd || undefined);
  if (!dir) return null;
  st = newState(sid, dir, cwd || findSessionCwd(sid));
  states.set(sid, st);
  return st;
}

function emptyPayload(sessionId, from, error) {
  return {
    ok: false,
    error: error || "session not found",
    sessionId: String(sessionId),
    cwd: null,
    dir: null,
    from,
    events: [],
    seq: 0,
    live: false,
    phase: null,
    phaseAt: null,
    turn: null,
    // P4: `owner` used to be filled in here even though ok:false. A caller that
    // gated a read-only composer on `owner` alone then locked a session whose
    // directory does not even exist. Ownership is only ever reported alongside
    // a real projection, so callers CANNOT get this wrong: no ok, no owner.
    owner: null,
    working: false,
    context: null,
    subagents: [],
    summary: null,
    truncated: false,
    hasMore: false,
    cursor: { updatesBytes: 0, eventsBytes: 0, seq: 0 },
    bytesRead: 0,
  };
}

/**
 * Project a session's on-disk logs into an ordered FeedEvent[].
 *
 * @param {string} sessionId
 * @param {{from?:number, limit?:number, cwd?:string}} [opts]
 *   from  — return events with `seq > from`
 *   limit — how many events to hand back
 *
 * Two paging modes, because opening a chat and resuming one want opposite ends:
 *   from === 0  → the TAIL window: the newest `limit` events.
 *                 `truncated:true` means older history exists ("load earlier").
 *   from > 0    → RESUME: the oldest `limit` events after `from`, so a client
 *                 can page forward without a hole. `hasMore:true` means call
 *                 again with `from` = the last seq you got.
 *
 * @returns {{
 *   ok:boolean, sessionId:string, cwd:string|null, dir:string|null,
 *   from:number, events:object[], seq:number,
 *   live:boolean, phase:string|null, phaseAt:number|null, turn:object|null,
 *   owner:object|null, working:boolean, context:object|null, subagents:object[],
 *   summary:object|null, truncated:boolean, hasMore:boolean,
 *   cursor:{updatesBytes:number,eventsBytes:number,seq:number}, bytesRead:number
 * }}
 */
export function read(sessionId, { from = 0, limit = DEFAULT_LIMIT, cwd } = {}) {
  if (!sessionId) return emptyPayload(sessionId, 0, "sessionId required");
  const fromSeq = Number.isFinite(Number(from)) && Number(from) > 0 ? Number(from) : 0;
  const cap =
    Number.isFinite(Number(limit)) && Number(limit) > 0
      ? Math.floor(Number(limit))
      : DEFAULT_LIMIT;

  const st = getState(sessionId, cwd);
  if (!st) return emptyPayload(sessionId, fromSeq, "session not found");

  const bytesRead = advance(st);

  // Fast path: everything the caller asked for is still in the ring.
  // from=0 means "the tail window" — serve the ring and flag `truncated`
  // rather than re-reading a 500 MB log on every poll.
  const oldest = st.buf.length ? st.buf[0].seq : Infinity;
  const servable = fromSeq === 0 || st.dropped === 0 || fromSeq >= oldest - 1;

  let matched;
  let dropped;
  if (servable) {
    matched = fromSeq > 0 ? st.buf.filter((e) => e.seq > fromSeq) : st.buf.slice();
    dropped = fromSeq > 0 ? 0 : st.dropped;
  } else {
    // Paging into evicted history — one bounded rescan from byte 0.
    const scratch = newState(st.sessionId, st.dir, st.cwd);
    scratch.maxBuffer = Math.max(cap, MAX_BUFFER);
    advance(scratch, { filterSeq: fromSeq });
    matched = scratch.buf;
    dropped = scratch.dropped;
  }

  let events = matched;
  let hasMore = false;
  if (events.length > cap) {
    if (fromSeq > 0) {
      // resume: oldest first, so the caller can page forward without a hole
      events = events.slice(0, cap);
      hasMore = true;
    } else {
      // tail window: newest, and say that earlier history exists
      dropped += events.length - cap;
      events = events.slice(events.length - cap);
    }
  }

  const owner = sessionOwner(st.sessionId);
  return {
    ok: true,
    sessionId: st.sessionId,
    cwd: st.cwd,
    dir: st.dir,
    from: fromSeq,
    events,
    seq: st.cursor.seq,
    live: st.live,
    phase: st.phase,
    phaseAt: st.phaseAt,
    turn: st.turn,
    owner,
    // 56 of 958 sessions carry a turn_started with no turn_ended (a CLI that
    // died mid-turn), so `live` alone over-reports. Computed HERE so the WS
    // frame and GET /api/sessions/:id/feed cannot drift apart.
    working: st.live && Boolean(owner),
    context: readContext(st.dir),
    subagents: mergeSubagents(st),
    summary: summaryOf(st.dir),
    truncated: dropped > 0,
    hasMore,
    cursor: { ...st.cursor },
    bytesRead,
  };
}

/* -------------------------------------------------------- subscribe seam */
/*
 * P2 owns the fs watchers. The contract here is deliberately dumb:
 *   const h = subscribe(id, lastSeq, (payload) => ws.send(...));
 *   ...on an fs change for that session: poll(id);
 *   unsubscribe(h);
 * Nothing in this module installs a watcher or a timer.
 */

const subs = new Map(); // sessionId → Set<handle>
let subSeq = 0;

/**
 * @param {string} sessionId
 * @param {number} fromSeq  deliver everything after this seq, then live deltas
 * @param {(payload:object)=>void} cb
 * @returns {{id:number,sessionId:string,lastSeq:number}} handle for unsubscribe
 */
export function subscribe(sessionId, fromSeq = 0, cb) {
  if (typeof cb !== "function") throw new TypeError("subscribe requires a callback");
  const sid = String(sessionId);
  const handle = { id: ++subSeq, sessionId: sid, lastSeq: Number(fromSeq) || 0, cb };
  let set = subs.get(sid);
  if (!set) {
    set = new Set();
    subs.set(sid, set);
  }
  set.add(handle);
  const first = read(sid, { from: handle.lastSeq });
  handle.lastSeq = first.seq;
  try {
    cb(first);
  } catch {
    /* a bad consumer must not break the projector */
  }
  return handle;
}

export function unsubscribe(handle) {
  if (!handle) return false;
  const set = subs.get(handle.sessionId);
  if (!set) return false;
  const gone = set.delete(handle);
  if (!set.size) subs.delete(handle.sessionId);
  return gone;
}

/**
 * Advance one session and push deltas to its subscribers. Call from a watcher.
 *
 * `force` pushes a frame even when no new events landed. Ownership lives in
 * ~/.grok/active_sessions.json and in the process table — neither of which
 * touches the session directory — so the owner exiting produces no fs event and
 * no new seq. Without a forced push the composer would stay locked until the
 * user reloaded, which is exactly the auto-takeover this phase owes.
 */
export function poll(sessionId, { force = false } = {}) {
  const sid = String(sessionId);
  const set = subs.get(sid);
  if (!set || !set.size) return 0;
  let sent = 0;
  for (const handle of [...set]) {
    const payload = read(sid, { from: handle.lastSeq });
    if (!payload.ok) continue;
    if (!force && payload.seq <= handle.lastSeq && !payload.events.length) continue;
    handle.lastSeq = payload.seq;
    try {
      handle.cb(payload);
      sent += 1;
    } catch {
      /* */
    }
  }
  return sent;
}

/** Session ids with at least one subscriber (P2 decides what to watch). */
export function subscribedSessions() {
  return [...subs.keys()];
}

/** Drop cached tail state (session deleted, or tests). */
export function forget(sessionId) {
  if (sessionId == null) {
    states.clear();
    return;
  }
  states.delete(String(sessionId));
}

/** Test/diagnostic hook — the live cursor for a session, or null. */
export function cursorOf(sessionId) {
  const st = states.get(String(sessionId));
  return st ? { ...st.cursor } : null;
}

export const __internals = {
  lineIterator,
  parseUpdatesLine,
  parseEventsLine,
  pidAlive,
  grokProcess,
  scanResumeOwners,
  execName,
  realCwd,
  isAcpWorker,
};
