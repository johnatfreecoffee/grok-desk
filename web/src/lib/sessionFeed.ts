/**
 * Client projection of the daemon's session feed (P3).
 *
 * The daemon (`daemon/session-feed.js`) turns `~/.grok/sessions/<cwd>/<id>/`
 * into an ordered, cursor-based `FeedEvent[]`. This module folds those events
 * into the `ChatMessage[]` the chat pane renders — nothing else in the client
 * is allowed to invent transcript state any more.
 *
 * Rules that make "leave / return / reload / reopen" one operation:
 *   - Everything is keyed by sessionId. A frame never touches another session.
 *   - `seq` is the only identity. An event with `seq <= state.seq` is already
 *     folded, so applying the same frame twice is a no-op.
 *   - `frame.fromSeq > state.seq` is a GAP: the caller must resubscribe from
 *     `state.seq` instead of concatenating over a hole.
 *   - Nothing is mutated across sessions. Rows are rebuilt into fresh objects
 *     on every apply, so React sees new identities and no draft is shared.
 *
 * `working === live && owner` — the daemon computes it. 56 of 958 sessions on
 * disk carry an orphan `turn_started`, so `live` alone over-reports. Never
 * render "Working…" from bare `live`.
 */
import type { ChatMessage } from "./acpClient.ts";
import type { LivePhase, PlanEntry, ToolCallView, TurnDraft } from "./turnState.ts";

/* ------------------------------------------------------------------ types */

export type FeedOwner = {
  sessionId: string;
  pid: number;
  cwd: string | null;
  openedAt: string | null;
};

export type FeedContext = {
  usagePct: number | null;
  tokensUsed: number | null;
  windowTokens: number | null;
  turnCount: number | null;
  toolCallCount: number | null;
  errorCount: number | null;
  toolFailureCount: number | null;
  toolsUsed: string[];
  primaryModelId: string | null;
};

export type FeedSubagent = {
  id: string;
  subagentId?: string;
  childSessionId?: string;
  parentSessionId?: string;
  type?: string | null;
  description?: string | null;
  status?: string | null;
  startedAt?: string | number | null;
  completedAt?: string | number | null;
  durationMs?: number | null;
  toolCalls?: number | null;
  turns?: number | null;
  output?: string;
  [k: string]: unknown;
};

export type FeedTurn = {
  number?: number | null;
  modelId?: string | null;
  startedAt?: number;
  endedAt?: number;
  outcome?: string | null;
  [k: string]: unknown;
};

/** One normalized row from `daemon/session-feed.js`. */
export type FeedEvent = {
  seq: number;
  at: number;
  sessionId: string;
  kind: string;
  src: string;
  text?: string;
  image?: { mimeType: string | null; data: string | null } | null;
  toolCallId?: string | null;
  title?: string;
  toolKind?: string;
  status?: string | null;
  output?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  locations?: unknown[];
  entries?: PlanEntry[];
  phase?: string | null;
  taskId?: string | null;
  command?: string | null;
  description?: string | null;
  exitCode?: number | null;
  outcome?: string | null;
  [k: string]: unknown;
};

/** The `feed` frame the daemon puts on the wire. */
export type FeedFrame = {
  type?: string;
  sessionId: string;
  fromSeq: number;
  seq: number;
  events?: FeedEvent[];
  live?: boolean;
  phase?: string | null;
  owner?: FeedOwner | null;
  working?: boolean;
  context?: FeedContext | null;
  subagents?: FeedSubagent[];
  turn?: FeedTurn | null;
  truncated?: boolean;
  hasMore?: boolean;
  catchUp?: boolean;
  error?: string | null;
  ok?: boolean;
};

export type SessionFeedState = {
  id: string;
  /** Cursor: the last seq folded into `messages`. */
  seq: number;
  messages: ChatMessage[];
  live: boolean;
  owner: FeedOwner | null;
  /** live && owner — the ONLY thing that may drive "Working…". */
  working: boolean;
  /** false when the daemon could not read the session dir. */
  ok: boolean;
  /** owner && ok — a terminal `grok` owns this chat, so Desk is read-only. */
  readOnly: boolean;
  phase: string | null;
  subagents: FeedSubagent[];
  context: FeedContext | null;
  turn: FeedTurn | null;
  /** Older history exists behind the tail window ("load earlier"). */
  truncated: boolean;
  /** The daemon capped this batch — page forward from `seq`. */
  hasMore: boolean;
  /** seq of the newest `turn_end` / `turn_completed` folded in. */
  turnEndSeq: number;
  error: string | null;
  updatedAt: number;
};

export type ApplyResult = {
  state: SessionFeedState;
  /** `messages` (or any rendered field) changed. */
  changed: boolean;
  /** frame.fromSeq ran ahead of our cursor — resubscribe from `state.seq`. */
  gap: boolean;
  /** The frame named a different session; nothing was touched. */
  ignored: boolean;
  /** How many events were folded. */
  applied: number;
};

/* ---------------------------------------------------------------- shaping */

/** Internal row builder. One row = one rendered chat bubble. */
type Row = {
  key: string;
  id: string;
  role: "user" | "assistant";
  content: string;
  thought: string;
  tools: ToolCallView[];
  plan: PlanEntry[];
  phase: LivePhase;
  /** seq of the event that opened the row — stable identity across rebuilds. */
  seq: number;
  images: { mimeType: string | null; data: string | null }[];
};

const OUTPUT_CAP = 256_000;

function cap(s: string, n = OUTPUT_CAP): string {
  return s.length <= n ? s : `${s.slice(0, n)}\n…[truncated]`;
}

/**
 * Strip the scaffolding Desk / the CLI injects around a user turn.
 * Mirrors `daemon/session-store.js:extractUserFacingText`, but keeps newlines —
 * the daemon collapses whitespace for its dedupe fingerprint; we render.
 */
export function userFacingText(raw: string): string | null {
  let text = String(raw || "");
  const q = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
  if (q) text = q[1];
  else if (
    /<system-reminder>|<user_info>|<agent_skills>|<mcp_servers>/i.test(text) &&
    !/<user_query>/i.test(text)
  ) {
    return null;
  } else if (/^\s*You are Grok/.test(text)) {
    return null;
  }
  text = text
    .replace(/^\s*\[GROK DESK — PROJECT CONTEXT\][\s\S]*?(?:\n\n|\r\n\r\n)/i, "")
    .replace(/\n*\s*\[ATTACHED FILES[\s\S]*?\]\s*$/i, "")
    .replace(/<image_files>[\s\S]*?<\/image_files>/gi, "")
    .replace(/\[Image #\d+\]/gi, "")
    .trim();
  if (!text || text === "[" || text === "]") return null;
  return text;
}

function isAgentTool(title: string, kind?: string): boolean {
  const t = `${title} ${kind || ""}`.toLowerCase();
  return (
    t.includes("agent") ||
    t.includes("subagent") ||
    t.includes("spawn") ||
    t.includes("task(")
  );
}

function toolDetail(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.description === "string" && r.description) return r.description;
  if (typeof r.command === "string") {
    const c = r.command.replace(/\s+/g, " ").trim();
    return c.length > 120 ? `${c.slice(0, 117)}…` : c;
  }
  for (const k of ["path", "target_file", "file_path", "file", "filename"]) {
    if (typeof r[k] === "string" && r[k]) return String(r[k]);
  }
  if (typeof r.prompt === "string") {
    const p = r.prompt.replace(/\s+/g, " ").trim();
    return p.length > 100 ? `${p.slice(0, 97)}…` : p;
  }
  return undefined;
}

function toolPath(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  for (const k of ["path", "target_file", "file_path", "file", "filename"]) {
    if (typeof r[k] === "string" && r[k]) return String(r[k]);
  }
  return undefined;
}

function toolDiff(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.new_string === "string" && typeof r.old_string === "string") {
    return `--- old\n+++ new\n@@\n-${String(r.old_string).slice(0, 4000)}\n+${String(
      r.new_string,
    ).slice(0, 4000)}`;
  }
  if (typeof r.contents === "string") return r.contents.slice(0, OUTPUT_CAP);
  return undefined;
}

function phaseFromFeed(phase: string | null | undefined): LivePhase | null {
  switch (phase) {
    case "thinking":
      return "thinking";
    case "tooling":
    case "tool":
      return "tooling";
    case "writing":
    case "responding":
      return "writing";
    case "queued":
      return "queued";
    case "idle":
      return "idle";
    default:
      return null;
  }
}

/* ----------------------------------------------------------- reducer core */

type Reducer = {
  rows: Row[];
  cur: Row | null;
  /** toolCallId → the tool object inside whichever row owns it. */
  tools: Map<string, ToolCallView>;
  n: number;
  /** seq of the newest turn_end / turn_completed folded in. */
  turnEndSeq: number;
};

function newReducer(): Reducer {
  return { rows: [], cur: null, tools: new Map(), n: 0, turnEndSeq: 0 };
}

function flush(r: Reducer): void {
  const cur = r.cur;
  r.cur = null;
  if (!cur) return;
  const empty =
    !cur.content.trim() &&
    !cur.thought.trim() &&
    !cur.tools.length &&
    !cur.plan.length &&
    !cur.images.length;
  if (empty) return;
  if (cur.role === "user") {
    const face = userFacingText(cur.content);
    if (!face) return;
    cur.content = face;
  }
  r.rows.push(cur);
}

function openRow(r: Reducer, role: "user" | "assistant", seq: number): Row {
  flush(r);
  const row: Row = {
    key: `${role}_${seq}`,
    id: `${role === "user" ? "u" : "a"}_${seq}`,
    role,
    content: "",
    thought: "",
    tools: [],
    plan: [],
    phase: "thinking",
    seq,
    images: [],
  };
  r.cur = row;
  r.n += 1;
  return row;
}

function assistantRow(r: Reducer, seq: number): Row {
  if (r.cur && r.cur.role === "assistant") return r.cur;
  return openRow(r, "assistant", seq);
}

function ensureTool(r: Reducer, row: Row, id: string, seq: number): ToolCallView {
  const existing = r.tools.get(id);
  if (existing) return existing;
  const tool: ToolCallView = { id: id || `t_${seq}`, title: "tool", status: "pending" };
  row.tools.push(tool);
  r.tools.set(tool.id, tool);
  return tool;
}

/** Fold one FeedEvent into the reducer. Returns true when it changed a row. */
function reduceEvent(r: Reducer, ev: FeedEvent): boolean {
  switch (ev.kind) {
    case "turn_start": {
      // Deliberately does NOT flush. turn_start comes from events.jsonl while
      // the chunks come from updates.jsonl, and the merge breaks equal
      // timestamps toward updates — so a turn_start can land AFTER the first
      // chunks of its own turn and would cut the reply in half. A turn is
      // already closed by its turn_end, and a new user_message flushes on the
      // role change, so nothing needs this.
      return false;
    }
    case "turn_end":
    case "turn_completed": {
      flush(r);
      // The feed's turn_end is the ONE finalize. Everything downstream keys
      // off this seq instead of running its own idle heuristic.
      if (ev.seq > r.turnEndSeq) r.turnEndSeq = ev.seq;
      return true;
    }
    case "user_message": {
      const text = typeof ev.text === "string" ? ev.text : "";
      const img = ev.image && ev.image.data ? ev.image : null;
      if (!text && !img) return false;
      const row = r.cur && r.cur.role === "user" ? r.cur : openRow(r, "user", ev.seq);
      if (text) row.content += text;
      if (img) row.images.push(img);
      return true;
    }
    case "agent_message": {
      const text = typeof ev.text === "string" ? ev.text : "";
      if (!text) return false;
      const row = assistantRow(r, ev.seq);
      row.content += text;
      row.phase = "writing";
      return true;
    }
    case "agent_thought": {
      const text = typeof ev.text === "string" ? ev.text : "";
      if (!text) return false;
      const row = assistantRow(r, ev.seq);
      row.thought += text;
      if (row.phase !== "writing" && row.phase !== "tooling") row.phase = "thinking";
      return true;
    }
    case "tool_call":
    case "tool_call_update": {
      const id = String(ev.toolCallId || "");
      const known = id ? r.tools.get(id) : undefined;
      // A tool_call_update for a tool from an earlier bubble updates it in place.
      const row = known ? null : assistantRow(r, ev.seq);
      const tool = known || ensureTool(r, row!, id, ev.seq);
      if (ev.title != null) tool.title = String(ev.title);
      if (ev.toolKind != null) tool.kind = String(ev.toolKind);
      if (ev.status != null) tool.status = String(ev.status);
      if (ev.rawInput !== undefined) {
        tool.rawInput =
          ev.rawInput && typeof ev.rawInput === "object"
            ? (ev.rawInput as Record<string, unknown>)
            : tool.rawInput;
        const d = toolDetail(ev.rawInput);
        if (d) tool.detail = d;
        const p = toolPath(ev.rawInput);
        if (p) tool.path = p;
        const diff = toolDiff(ev.rawInput);
        if (diff) tool.diff = cap(diff);
        const desc = (ev.rawInput as { description?: string } | null)?.description;
        if (typeof desc === "string" && desc) tool.description = desc;
      }
      if (typeof ev.output === "string" && ev.output) {
        tool.output = cap((tool.output || "") + ev.output);
      } else if (ev.rawOutput !== undefined && !tool.output) {
        try {
          tool.output = cap(
            typeof ev.rawOutput === "string"
              ? ev.rawOutput
              : JSON.stringify(ev.rawOutput, null, 2),
          );
        } catch {
          /* unserializable rawOutput — the text output above is the real one */
        }
      }
      if (!tool.path && Array.isArray(ev.locations) && ev.locations.length) {
        const loc = ev.locations[0] as { path?: string } | undefined;
        if (loc && typeof loc.path === "string") tool.path = loc.path;
      }
      tool.isAgent = isAgentTool(tool.title, tool.kind);
      if (r.cur && r.cur.role === "assistant") r.cur.phase = "tooling";
      return true;
    }
    case "plan": {
      if (!Array.isArray(ev.entries)) return false;
      const row = assistantRow(r, ev.seq);
      row.plan = ev.entries.map((e) => ({
        content: String(e?.content ?? ""),
        status: String(e?.status ?? "pending"),
        priority: e?.priority ? String(e.priority) : undefined,
      }));
      return true;
    }
    case "task_backgrounded": {
      const id = String(ev.toolCallId || ev.taskId || `bg_${ev.seq}`);
      const row = r.tools.get(id) ? null : assistantRow(r, ev.seq);
      const tool = r.tools.get(id) || ensureTool(r, row!, id, ev.seq);
      const cmd = String(ev.command || "").replace(/\s+/g, " ").trim();
      tool.isBackground = true;
      tool.status = "in_progress";
      if (tool.title === "tool") tool.title = "background";
      tool.detail = cmd.length > 80 ? `${cmd.slice(0, 77)}…` : cmd || tool.detail;
      return true;
    }
    case "task_completed": {
      const id = String(ev.toolCallId || ev.taskId || "");
      const tool = id ? r.tools.get(id) : undefined;
      if (!tool) return false;
      tool.isBackground = true;
      tool.status = ev.status ? String(ev.status) : ev.exitCode ? "failed" : "completed";
      return true;
    }
    default:
      // phase / tool_status / permission_* / subagent_* / other — derived state
      // only. They never build a chat row.
      return false;
  }
}

function rowToMessage(row: Row, streaming: boolean): ChatMessage {
  const m: ChatMessage = {
    id: row.id,
    role: row.role,
    content: row.role === "user" ? row.content : row.content.trim(),
    streaming,
  };
  if (row.thought.trim()) m.thought = row.thought.trim();
  if (row.tools.length) m.tools = row.tools.map((t) => ({ ...t }));
  if (row.plan.length) m.plan = row.plan.map((p) => ({ ...p }));
  if (streaming) m.phase = row.phase;
  else if (row.phase !== "thinking") m.phase = "idle";
  return m;
}

/**
 * Project the reducer's rows into rendered messages.
 * Only the trailing assistant row streams, and only while `working`.
 */
function project(r: Reducer, working: boolean, phase: LivePhase | null): ChatMessage[] {
  const rows = r.cur ? [...r.rows, r.cur] : r.rows;
  const out: ChatMessage[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (row.role === "user") {
      const face = userFacingText(row.content);
      if (!face && !row.images.length) continue;
      out.push({ id: row.id, role: "user", content: face || "", streaming: false });
      continue;
    }
    const last = i === rows.length - 1;
    const streaming = last && working;
    if (streaming && phase) row.phase = phase;
    const m = rowToMessage(row, streaming);
    if (
      !m.content &&
      !m.thought &&
      !m.tools?.length &&
      !m.plan?.length &&
      !streaming
    ) {
      continue;
    }
    out.push(m);
  }
  return out;
}

/* ------------------------------------------------------------------ store */

function emptyState(id: string): SessionFeedState {
  return {
    id,
    seq: 0,
    messages: [],
    live: false,
    owner: null,
    working: false,
    ok: true,
    readOnly: false,
    phase: null,
    subagents: [],
    context: null,
    turn: null,
    truncated: false,
    hasMore: false,
    turnEndSeq: 0,
    error: null,
    updatedAt: 0,
  };
}

/**
 * Per-session projection of the daemon feed.
 *
 * No React, no timers, no fetch — `applyFeed` is a pure fold you can drive from
 * a unit test with hand-written frames (see `scripts/session-store-unit.mjs`).
 */
export class SessionFeedStore {
  private states = new Map<string, SessionFeedState>();
  private reducers = new Map<string, Reducer>();

  get(sessionId: string | null | undefined): SessionFeedState | null {
    if (!sessionId) return null;
    return this.states.get(String(sessionId)) || null;
  }

  ensure(sessionId: string): SessionFeedState {
    const id = String(sessionId);
    let st = this.states.get(id);
    if (!st) {
      st = emptyState(id);
      this.states.set(id, st);
      this.reducers.set(id, newReducer());
    }
    return st;
  }

  /** Raw cursor, even when nothing has been rendered yet. */
  seqOf(sessionId: string | null | undefined): number {
    return this.get(sessionId)?.seq || 0;
  }

  /** Cursor to resubscribe at. 0 means "give me the tail window". */
  cursor(sessionId: string | null | undefined): number {
    const st = this.get(sessionId);
    if (!st) return 0;
    // No rows yet → a cursor would resume into a blank transcript.
    return st.messages.length ? st.seq : 0;
  }

  has(sessionId: string | null | undefined): boolean {
    return Boolean(sessionId && this.states.has(String(sessionId)));
  }

  ids(): string[] {
    return [...this.states.keys()];
  }

  isWorking(sessionId: string | null | undefined): boolean {
    return Boolean(this.get(sessionId)?.working);
  }

  workingIds(): string[] {
    const out: string[] = [];
    for (const [id, st] of this.states) if (st.working) out.push(id);
    return out;
  }

  /** A session other than `exceptId` that is mid-turn (background banner). */
  otherWorkingId(exceptId: string | null | undefined): string | null {
    for (const [id, st] of this.states) {
      if (!st.working) continue;
      if (exceptId && id === String(exceptId)) continue;
      return id;
    }
    return null;
  }

  /** Drop one session's projection (deleted session, or a forced re-read). */
  forget(sessionId: string | null | undefined): void {
    if (!sessionId) return;
    const id = String(sessionId);
    this.states.delete(id);
    this.reducers.delete(id);
  }

  /** Clear rows + cursor but keep the entry (log rotated under us). */
  reset(sessionId: string): SessionFeedState {
    const id = String(sessionId);
    const st = emptyState(id);
    this.states.set(id, st);
    this.reducers.set(id, newReducer());
    return st;
  }

  /**
   * Seed a session from persisted state (reload / PWA resume) so the very
   * first `subscribe` can resume at a cursor instead of repainting from 0.
   */
  hydrate(sessionId: string, seq: number, messages: ChatMessage[]): SessionFeedState {
    const id = String(sessionId);
    const st = this.reset(id);
    const n = Number(seq);
    if (!Number.isFinite(n) || n <= 0 || !messages.length) return st;
    st.seq = Math.floor(n);
    st.messages = messages.map((m) => ({ ...m, streaming: false }));
    // Rebuild a reducer that can keep appending after the restored rows.
    const r = this.reducers.get(id)!;
    const rows: Row[] = [];
    for (const m of st.messages) {
      if (m.role !== "user" && m.role !== "assistant") continue;
      const row: Row = {
        key: `${m.role}_${m.id}`,
        id: m.id,
        role: m.role,
        content: m.content || "",
        thought: m.thought || "",
        tools: (m.tools || []).map((t) => ({ ...t })),
        plan: (m.plan || []).map((p) => ({ ...p })),
        phase: "idle",
        seq: st.seq,
        images: [],
      };
      rows.push(row);
      for (const t of row.tools) r.tools.set(t.id, t);
    }
    // A trailing assistant row may be mid-turn: leave it OPEN so the feed's
    // next chunk continues that bubble instead of splitting the reply in two.
    const last = rows[rows.length - 1];
    if (last && last.role === "assistant") {
      r.rows = rows.slice(0, -1);
      r.cur = last;
    } else {
      r.rows = rows;
      r.cur = null;
    }
    st.updatedAt = Date.now();
    return st;
  }

  /**
   * Fold one `feed` frame into a session.
   *
   * Idempotent: events at or below the stored cursor are skipped, so replaying
   * a frame changes nothing. Gap-aware: a frame that starts past our cursor is
   * refused (`gap:true`) instead of being concatenated over a hole.
   */
  applyFeed(sessionId: string, frame: FeedFrame): ApplyResult {
    const id = String(sessionId || frame?.sessionId || "");
    if (!id) {
      return { state: emptyState(""), changed: false, gap: false, ignored: true, applied: 0 };
    }
    // A frame that names a different chat must never touch this one.
    if (frame?.sessionId && String(frame.sessionId) !== id) {
      return { state: this.ensure(id), changed: false, gap: false, ignored: true, applied: 0 };
    }

    let st = this.ensure(id);

    if (frame?.error || frame?.ok === false) {
      const next: SessionFeedState = {
        ...st,
        ok: false,
        error: String(frame.error || "session unavailable"),
        live: false,
        working: false,
        // owner without ok is the P2 QC trap — never let it lock the composer.
        owner: frame.owner ?? st.owner,
        readOnly: false,
        updatedAt: Date.now(),
      };
      this.states.set(id, next);
      return { state: next, changed: true, gap: false, ignored: false, applied: 0 };
    }

    const events = Array.isArray(frame.events) ? frame.events : [];
    const fromSeq = Number(frame.fromSeq) || 0;
    const frameSeq = Number(frame.seq) || 0;
    let truncated = Boolean(frame.truncated);

    // Both resets below are gated on `catchUp` — a catch-up is the daemon's
    // deliberate full re-read at subscribe time, so it is authoritative about
    // how much history exists. A plain delta that looks stale is just a
    // duplicate in flight; the seq guard below already makes it a no-op, and
    // resetting on one would throw away a transcript that is perfectly correct.
    if (frame.catchUp) {
      // The CLI truncated / rotated the log: the daemon now has LESS than us.
      if (frameSeq > 0 && frameSeq < st.seq) {
        st = this.reset(id);
      }
      // A tail window that starts past our cursor has a hole in the middle.
      // The window IS the newest truth, so rebuild from it and say history
      // was cut.
      else if (fromSeq === 0 && st.seq > 0 && events.length && events[0].seq > st.seq + 1) {
        st = this.reset(id);
        truncated = true;
      }
    }
    // A real hole, judged on evidence rather than on the label.
    //
    // `frame.fromSeq` is the daemon's `handle.lastSeq` AT SEND TIME, which can
    // legitimately run ahead of the events the frame carries (a concurrent poll
    // advances the handle between the read and the send). So a label ahead of
    // our cursor is not proof of loss. It is only a hole when the frame ALSO
    // starts after that baseline — meaning a whole region was never shipped.
    // Events at or below our cursor are skipped below, so an overlapping frame
    // is simply idempotent.
    if (fromSeq > st.seq && events.length > 0 && Number(events[0].seq) > fromSeq) {
      return { state: st, changed: false, gap: true, ignored: false, applied: 0 };
    }

    const r = this.reducers.get(id)!;
    let applied = 0;
    let touched = false;
    let maxSeq = st.seq;
    for (const ev of events) {
      if (!ev || typeof ev !== "object") continue;
      const seq = Number(ev.seq);
      if (!Number.isFinite(seq) || seq <= st.seq) continue; // already folded
      if (ev.sessionId && String(ev.sessionId) !== id) continue;
      if (reduceEvent(r, ev)) touched = true;
      applied += 1;
      if (seq > maxSeq) maxSeq = seq;
    }

    const live = Boolean(frame.live);
    const owner = frame.owner ?? null;
    const ok = true; // the ok === false branch returned above
    const working = frame.working != null ? Boolean(frame.working) : live && Boolean(owner);
    const phase = frame.phase ?? null;

    const changedShape =
      touched ||
      working !== st.working ||
      live !== st.live ||
      phase !== st.phase ||
      (owner?.pid ?? null) !== (st.owner?.pid ?? null);

    const next: SessionFeedState = {
      id,
      seq: Math.max(maxSeq, frameSeq, st.seq),
      messages: changedShape ? project(r, working, phaseFromFeed(phase)) : st.messages,
      live,
      owner,
      working,
      ok,
      // P2 QC: `owner` is populated even when the session dir is gone.
      readOnly: Boolean(owner) && ok,
      phase,
      subagents: Array.isArray(frame.subagents) ? frame.subagents : st.subagents,
      context: frame.context ?? st.context,
      turn: frame.turn ?? st.turn,
      truncated: truncated || st.truncated,
      hasMore: Boolean(frame.hasMore),
      turnEndSeq: r.turnEndSeq,
      error: null,
      updatedAt: Date.now(),
    };
    this.states.set(id, next);
    return {
      state: next,
      changed: changedShape || next.seq !== st.seq,
      gap: false,
      ignored: false,
      applied,
    };
  }
}

/**
 * The seq a projected row was opened at, parsed back out of its id.
 * Row ids are `u_<seq>` / `a_<seq>`; this is the one place that knows it.
 */
export function feedRowSeq(id: string | null | undefined): number | null {
  const m = /^[ua]_(\d+)$/.exec(String(id || ""));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/* ------------------------------------------------------- live turn adapter */

/**
 * The trailing streaming row as a `TurnDraft`, for `LiveTurn` / the artifact
 * pane. Null when the session is not working.
 */
export function draftFromState(st: SessionFeedState | null): TurnDraft | null {
  if (!st || !st.working) return null;
  const last = st.messages[st.messages.length - 1];
  if (!last || last.role !== "assistant" || !last.streaming) return null;
  const phase = (last.phase as TurnDraft["phase"]) || "thinking";
  const tools = last.tools || [];
  const running = tools.find((t) => t.status === "in_progress" || t.status === "pending");
  let lastActivity = "Thinking…";
  if (running) lastActivity = running.isAgent ? `Agent working · ${running.title}` : `Running · ${running.title}`;
  else if (phase === "writing") lastActivity = "Writing…";
  else if (phase === "tooling" && tools.length) lastActivity = `Done · ${tools[tools.length - 1].title}`;
  return {
    id: last.id,
    content: last.content || "",
    thought: last.thought || "",
    tools: tools.map((t) => ({ ...t })),
    plan: (last.plan || []).map((p) => ({ ...p })),
    phase,
    lastActivity,
  };
}

/* ----------------------------------------------------------- localStorage */

const CURSOR_KEY = "grok-desk-feed-cursors";
/** Sessions kept in the resume cache (LRU). */
const MAX_PERSISTED = 8;
/** Rows kept per session — enough to repaint a chat, small enough for quota. */
const MAX_PERSISTED_ROWS = 60;
const MAX_PERSISTED_CHARS = 20_000;
const MAX_PERSISTED_TOOL_OUTPUT = 2_000;

type PersistedSession = { seq: number; at: number; messages: ChatMessage[] };
type PersistedBag = Record<string, PersistedSession>;

function readBag(): PersistedBag {
  try {
    const raw = localStorage.getItem(CURSOR_KEY);
    if (!raw) return {};
    const j = JSON.parse(raw);
    return j && typeof j === "object" ? (j as PersistedBag) : {};
  } catch {
    return {};
  }
}

function writeBag(bag: PersistedBag): void {
  try {
    localStorage.setItem(CURSOR_KEY, JSON.stringify(bag));
  } catch {
    // Quota / private mode — the cursor is an optimization, never a truth.
    try {
      localStorage.removeItem(CURSOR_KEY);
    } catch {
      /* nothing else to do */
    }
  }
}

/** Trim a row for the resume cache: no tool output, no diffs, bounded text. */
function slimMessage(m: ChatMessage): ChatMessage {
  const out: ChatMessage = {
    id: m.id,
    role: m.role,
    content: String(m.content || "").slice(0, MAX_PERSISTED_CHARS),
    streaming: false,
  };
  if (m.thought) out.thought = m.thought.slice(0, MAX_PERSISTED_CHARS);
  if (m.tools?.length) {
    out.tools = m.tools.slice(-40).map((t) => ({
      id: t.id,
      title: t.title,
      kind: t.kind,
      status: t.status,
      detail: t.detail,
      path: t.path,
      isAgent: t.isAgent,
      isBackground: t.isBackground,
      // Bounded slice: enough to show what a tool returned without eating quota.
      output: t.output ? t.output.slice(0, MAX_PERSISTED_TOOL_OUTPUT) : undefined,
    }));
  }
  if (m.plan?.length) out.plan = m.plan.slice(-40).map((p) => ({ ...p }));
  return out;
}

/** Save a session's cursor + a slim transcript so a reload resumes in place. */
export function persistFeed(state: SessionFeedState | null | undefined): void {
  if (!state?.id || !state.seq) return;
  const bag = readBag();
  bag[state.id] = {
    seq: state.seq,
    at: Date.now(),
    messages: state.messages.slice(-MAX_PERSISTED_ROWS).map(slimMessage),
  };
  const ids = Object.keys(bag);
  if (ids.length > MAX_PERSISTED) {
    ids
      .sort((a, b) => (bag[a].at || 0) - (bag[b].at || 0))
      .slice(0, ids.length - MAX_PERSISTED)
      .forEach((id) => delete bag[id]);
  }
  writeBag(bag);
}

export function loadPersistedFeed(sessionId: string | null | undefined): PersistedSession | null {
  if (!sessionId) return null;
  const row = readBag()[String(sessionId)];
  if (!row || !Number.isFinite(Number(row.seq))) return null;
  return { seq: Number(row.seq), at: Number(row.at) || 0, messages: row.messages || [] };
}

export function forgetPersistedFeed(sessionId: string | null | undefined): void {
  if (!sessionId) return;
  const bag = readBag();
  if (!(String(sessionId) in bag)) return;
  delete bag[String(sessionId)];
  writeBag(bag);
}
