/**
 * Per-session chat state. Isolation rules:
 *  - Every mutation is keyed by sessionId.
 *  - Events without a sessionId are dropped.
 *  - New chat never copies another session's transcript.
 *  - Composer writability is per-record (mail: only), never "another chat is live".
 */
import type { ChatMessage } from "./acpClient.ts";
import { applyTurnUpdate, createTurnDraft, type TurnDraft } from "./turnState.ts";

export type SessionPhase =
  | "idle"
  | "creating"
  | "loading"
  | "ready"
  | "working"
  | "history_only"
  | "error";

export type SessionRecord = {
  id: string;
  cwd: string | null;
  title: string;
  messages: ChatMessage[];
  draft: TurnDraft | null;
  phase: SessionPhase;
  queueLen: number;
  writable: boolean;
  lastError?: string;
};

const PENDING_PREFIX = "pending:";

export function createPendingId(): string {
  return `${PENDING_PREFIX}${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function isPendingId(id: string | null | undefined): boolean {
  return Boolean(id && String(id).startsWith(PENDING_PREFIX));
}

export function isMailSession(id: string | null | undefined): boolean {
  return Boolean(id && String(id).startsWith("mail:"));
}

/** Paint only when both ids are known and equal. Never fall back to "current view". */
export function shouldPaint(
  viewingId: string | null | undefined,
  eventSessionId: string | null | undefined,
): boolean {
  if (!viewingId || !eventSessionId) return false;
  return String(viewingId) === String(eventSessionId);
}

export function emptyRecord(id: string, cwd: string | null = null): SessionRecord {
  return {
    id,
    cwd,
    title: "New chat",
    messages: [],
    draft: null,
    phase: isPendingId(id) ? "creating" : "idle",
    queueLen: 0,
    writable: !isMailSession(id),
  };
}

function cleanUserContent(content: string): string {
  return String(content || "")
    .replace(/^\s*\[GROK DESK — PROJECT CONTEXT\][\s\S]*?(?:\n\n|\r\n\r\n)/i, "")
    .replace(/\n*\s*\[ATTACHED FILES[\s\S]*?\]\s*$/i, "")
    .replace(/<image_files>[\s\S]*?<\/image_files>/gi, "")
    .replace(/\[Image #\d+\]/gi, "")
    .trim();
}

function cleanMessage(m: ChatMessage): ChatMessage {
  if (m.role !== "user") return m;
  const c = cleanUserContent(m.content);
  return c === m.content ? m : { ...m, content: c };
}

function enrichSameId(base: ChatMessage, extra: ChatMessage): ChatMessage {
  if (base.role !== "assistant" && extra.role !== "assistant") {
    if (extra.attachments?.length && !base.attachments?.length) {
      return { ...base, attachments: extra.attachments };
    }
    const extraLen = (extra.content || "").length;
    const baseLen = (base.content || "").length;
    return extraLen > baseLen ? { ...base, content: extra.content } : base;
  }
  const baseLen = (base.content || "").length;
  const extraLen = (extra.content || "").length;
  const richer = extraLen > baseLen ? extra : base;
  const poorer = richer === extra ? base : extra;
  return {
    ...richer,
    id: richer.id || poorer.id,
    thought: richer.thought || poorer.thought,
    tools: richer.tools?.length ? richer.tools : poorer.tools,
    plan: richer.plan?.length ? richer.plan : poorer.plan,
    phase: richer.phase || poorer.phase,
    streaming: Boolean(base.streaming && extra.streaming),
    attachments: base.attachments?.length ? base.attachments : extra.attachments,
  };
}

function contentKey(role: string, content: string): string {
  return `${role}:${cleanUserContent(content).slice(0, 160).toLowerCase()}`;
}

/**
 * Reconstruct one session's transcript.
 * Merge by message id first. Content fingerprint only drops exact dupes
 * (ACP history uses ch_u_N while Desk uses desk_u_*).
 * Never pull rows from another session — caller must pass only this id's sources.
 */
export function hydrateMessages(
  disk: ChatMessage[],
  cached: ChatMessage[] = [],
  draft: TurnDraft | null = null,
): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  const order: string[] = [];

  const add = (raw: ChatMessage) => {
    if (!raw) return;
    const m = cleanMessage(raw);
    const id = m.id || `noid:${contentKey(m.role, m.content)}`;
    const row = m.id ? m : { ...m, id };
    if (!byId.has(id)) {
      order.push(id);
      byId.set(id, row);
      return;
    }
    byId.set(id, enrichSameId(byId.get(id)!, row));
  };

  for (const m of disk) add(m);
  for (const m of cached) add(m);

  if (draft && (draft.content || draft.thought || draft.tools?.length)) {
    const existing = order.find((id) => {
      const m = byId.get(id);
      return m && (m.id === draft.id || (m.streaming && m.role === "assistant"));
    });
    if (existing) {
      const prev = byId.get(existing)!;
      byId.set(existing, {
        ...prev,
        id: draft.id || prev.id,
        content: draft.content || prev.content,
        thought: draft.thought || prev.thought,
        tools: draft.tools?.length ? draft.tools : prev.tools,
        plan: draft.plan?.length ? draft.plan : prev.plan,
        phase: draft.phase,
        streaming: true,
        role: "assistant",
      });
    } else {
      const id = draft.id || `draft_${order.length}`;
      order.push(id);
      byId.set(id, {
        id,
        role: "assistant",
        content: draft.content || "",
        thought: draft.thought || undefined,
        tools: draft.tools,
        plan: draft.plan,
        phase: draft.phase,
        streaming: true,
      });
    }
  }

  const out: ChatMessage[] = [];
  const seenContent = new Set<string>();
  for (const id of order) {
    const m = byId.get(id);
    if (!m) continue;
    const k = contentKey(m.role, m.content);
    if (k.endsWith(":") || !cleanUserContent(m.content)) {
      out.push(m);
      continue;
    }
    if (seenContent.has(k)) continue;
    seenContent.add(k);
    out.push(m);
  }
  return out.length > 200 ? out.slice(-200) : out;
}

export class SessionStore {
  records = new Map<string, SessionRecord>();
  viewingId: string | null = null;
  liveIds = new Set<string>();
  droppedUntagged = 0;

  ensure(id: string, cwd: string | null = null): SessionRecord {
    let rec = this.records.get(id);
    if (!rec) {
      rec = emptyRecord(id, cwd);
      this.records.set(id, rec);
    } else if (cwd && !rec.cwd) {
      rec.cwd = cwd;
    }
    return rec;
  }

  view(id: string, cwd: string | null = null): SessionRecord {
    const rec = this.ensure(id, cwd);
    this.viewingId = id;
    return rec;
  }

  createPending(cwd: string | null = null): SessionRecord {
    const id = createPendingId();
    const rec = emptyRecord(id, cwd);
    rec.phase = "creating";
    rec.writable = true;
    this.records.set(id, rec);
    this.viewingId = id;
    return rec;
  }

  /** Move pending record onto the real ACP id. Never copies a different live session. */
  rebase(pendingId: string, realId: string): SessionRecord {
    const pending = this.records.get(pendingId);
    const dest = this.ensure(realId, pending?.cwd || null);
    if (pending && pendingId !== realId) {
      if (!dest.messages.length && pending.messages.length) {
        dest.messages = pending.messages.map((m) => ({ ...m }));
      }
      if (!dest.draft && pending.draft) dest.draft = pending.draft;
      dest.phase = dest.phase === "idle" ? "ready" : dest.phase;
      dest.writable = !isMailSession(realId);
      dest.cwd = dest.cwd || pending.cwd;
      this.records.delete(pendingId);
    }
    if (this.viewingId === pendingId) this.viewingId = realId;
    if (this.liveIds.has(pendingId)) {
      this.liveIds.delete(pendingId);
      this.liveIds.add(realId);
    }
    return dest;
  }

  setMessages(id: string, messages: ChatMessage[]): SessionRecord {
    const rec = this.ensure(id);
    rec.messages = messages;
    return rec;
  }

  stash(id: string | null | undefined, messages: ChatMessage[]): void {
    if (!id) return;
    const snap = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ ...m, streaming: false, queued: false }));
    if (snap.length) this.setMessages(id, snap);
  }

  markLive(id: string | null | undefined): void {
    if (!id || isPendingId(id)) return;
    this.liveIds.add(id);
    const rec = this.ensure(id);
    rec.phase = "working";
  }

  markIdle(id: string | null | undefined): void {
    if (!id) return;
    this.liveIds.delete(id);
    const rec = this.records.get(id);
    if (rec && rec.phase === "working") rec.phase = "ready";
  }

  isLive(id: string | null | undefined): boolean {
    return Boolean(id && this.liveIds.has(id));
  }

  isViewing(id: string | null | undefined): boolean {
    return shouldPaint(this.viewingId, id);
  }

  viewingBusy(): boolean {
    return this.isLive(this.viewingId);
  }

  otherLiveId(): string | null {
    if (!this.viewingId) return this.liveIds.values().next().value || null;
    for (const id of this.liveIds) {
      if (id !== this.viewingId) return id;
    }
    return null;
  }

  applyUpdate(
    sessionId: string | null | undefined,
    update: Record<string, unknown>,
  ): { record: SessionRecord; viewing: boolean } | null {
    if (!sessionId) {
      this.droppedUntagged += 1;
      return null;
    }
    const rec = this.ensure(sessionId);
    let draft = rec.draft;
    if (!draft) {
      draft = createTurnDraft(`d_${Date.now().toString(36)}`);
      rec.draft = draft;
    }
    applyTurnUpdate(draft, update);
    rec.draft = {
      ...draft,
      tools: draft.tools.map((t) => ({ ...t })),
      plan: draft.plan.map((p) => ({ ...p })),
    };
    rec.phase = "working";
    this.liveIds.add(sessionId);

    const patch = (m: ChatMessage): ChatMessage => {
      const isTarget =
        m.id === rec.draft!.id ||
        (m.role === "assistant" && m.streaming) ||
        (m.role === "assistant" && !m.content && rec.draft!.content);
      if (!isTarget) return m;
      return {
        ...m,
        id: rec.draft!.id || m.id,
        content: rec.draft!.content,
        thought: rec.draft!.thought || undefined,
        tools: rec.draft!.tools,
        plan: rec.draft!.plan,
        phase: rec.draft!.phase,
        streaming: true,
      };
    };
    let next = rec.messages.map(patch);
    if (!next.some((m) => m.id === rec.draft!.id || (m.streaming && m.role === "assistant"))) {
      next = [
        ...next,
        {
          id: rec.draft!.id,
          role: "assistant",
          content: rec.draft!.content,
          thought: rec.draft!.thought || undefined,
          tools: rec.draft!.tools,
          plan: rec.draft!.plan,
          phase: rec.draft!.phase,
          streaming: true,
        },
      ];
    }
    rec.messages = next;
    return { record: rec, viewing: this.isViewing(sessionId) };
  }

  applyTurnEnd(
    sessionId: string | null | undefined,
    opts?: { abandoned?: boolean; error?: boolean },
  ): { record: SessionRecord | null; viewing: boolean } {
    if (!sessionId) {
      this.droppedUntagged += 1;
      return { record: null, viewing: false };
    }
    const rec = this.records.get(sessionId) || this.ensure(sessionId);
    const draft = rec.draft;
    this.liveIds.delete(sessionId);
    rec.phase = opts?.error ? "error" : "ready";
    rec.draft = null;
    if (draft) {
      rec.messages = rec.messages.map((m) =>
        m.id === draft.id || m.streaming
          ? {
              ...m,
              streaming: false,
              content: draft.content || m.content || (draft.tools.length ? "" : "✓"),
              thought: draft.thought || undefined,
              tools: draft.tools,
              plan: draft.plan,
              phase: "idle",
            }
          : m,
      );
      if (!rec.messages.some((m) => m.id === draft.id)) {
        rec.messages.push({
          id: draft.id,
          role: "assistant",
          content: draft.content || (draft.tools.length ? "" : "✓"),
          thought: draft.thought || undefined,
          tools: draft.tools,
          plan: draft.plan,
          phase: "idle",
          streaming: false,
        });
      }
    } else {
      rec.messages = rec.messages.map((m) =>
        m.streaming ? { ...m, streaming: false, phase: "idle" } : m,
      );
    }
    return { record: rec, viewing: this.isViewing(sessionId) };
  }
}
