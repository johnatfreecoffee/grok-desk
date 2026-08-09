export type AgentStatus = {
  agentAlive: boolean;
  ready: boolean;
  sessionId: string | null;
  cwd: string;
  grokBin: string;
};

export type AttachmentPreview = {
  id: string;
  name: string;
  mime: string;
  previewUrl?: string;
  dataBase64?: string;
  size?: number;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  streaming?: boolean;
  attachments?: AttachmentPreview[];
  queued?: boolean;
  /** Snapshot of live turn for finished assistant messages */
  thought?: string;
  tools?: import("./turnState").ToolCallView[];
  plan?: import("./turnState").PlanEntry[];
  phase?: string;
};

export type SessionLoadedPayload = {
  sessionId: string;
  cwd: string;
  messages: ChatMessage[];
  summary?: unknown;
  truncated?: boolean;
};

export type SessionStatusState =
  | "creating"
  | "loading"
  | "ready"
  | "history_only"
  | "error";

/** Server turn truth (hello / status / GET /api/turn) */
export type PoolWorker = {
  workerId: string;
  sessionId: string | null;
  cwd: string | null;
  busy: boolean;
  agentAlive: boolean;
  ready: boolean;
  isDefault?: boolean;
};

export type TurnSnapshot = {
  turnActive?: boolean;
  turnEpoch?: number;
  activeSessionId?: string | null;
  bridgeSessionId?: string | null;
  phase?: string | null;
  turnStartedAt?: string | null;
  lastActivityAt?: string | null;
  partialDraft?: {
    id?: string;
    sessionId?: string;
    content?: string;
    thought?: string;
    tools?: unknown[];
    plan?: unknown[];
    phase?: string;
  } | null;
  parallelDrafts?: {
    sessionId: string;
    workerId?: string;
    content?: string;
    thought?: string;
    tools?: unknown[];
    plan?: unknown[];
    phase?: string;
  }[];
  liveSessionIds?: string[];
  queueRemaining?: number;
  queueSessionIds?: string[];
  agentAlive?: boolean;
  agents?: PoolWorker[];
  pool?: { maxWorkers: number; workerCount: number; busyCount: number };
};

type Handlers = {
  onHello?: (
    info: {
      agent: AgentStatus;
      voiceConfigured: boolean;
    } & TurnSnapshot,
  ) => void;
  onStatus?: (
    info: {
      agent: AgentStatus;
      voiceConfigured: boolean;
    } & TurnSnapshot,
  ) => void;
  onReady?: (info: { agent: AgentStatus } & TurnSnapshot) => void;
  onTurnStart?: (info?: {
    sessionId?: string;
    resume?: boolean;
    turnEpoch?: number;
    draftId?: string;
  }) => void;
  onPartialDraft?: (info: {
    sessionId?: string;
    turnEpoch?: number;
    draft?: {
      id?: string;
      content?: string;
      thought?: string;
      tools?: import("./turnState").ToolCallView[];
      plan?: import("./turnState").PlanEntry[];
      phase?: string;
    } | null;
  }) => void;
  onTurnEnd?: (info: {
    result?: unknown;
    error?: boolean;
    abandoned?: boolean;
    deduped?: boolean;
    reason?: string;
    sessionId?: string;
    turnEpoch?: number;
  }) => void;
  onUpdate?: (
    update: Record<string, unknown>,
    meta?: { sessionId?: string; turnEpoch?: number },
  ) => void;
  onError?: (error: string) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onSessionLoaded?: (
    info: SessionLoadedPayload & {
      loadError?: string;
      agentResumed?: boolean;
      viewOnly?: boolean;
      turnActive?: boolean;
      backgroundTurnSessionId?: string | null;
    },
  ) => void;
  onSession?: (info: {
    sessionId: string;
    cwd: string;
    mode?: string;
    title?: string;
  }) => void;
  onSessionStatus?: (info: {
    state: SessionStatusState;
    sessionId?: string;
    cwd?: string;
    error?: string;
  }) => void;
  onSessionTitle?: (info: { sessionId: string; title: string }) => void;
  onQueued?: (info: {
    position: number;
    remaining: number;
    text: string;
    sessionId?: string;
  }) => void;
  onQueueUpdate?: (info: { remaining: number; starting?: boolean }) => void;
  /** Sidebar should re-fetch projects (CLI/fs or desk turn). */
  onProjectsTick?: (info: { reason?: string; at?: number }) => void;
  /** Live session status for sidebar dots (working/planning/waiting/done/error). */
  onSessionActivity?: (info: { sessionId?: string; status: string }) => void;
  onAgentExit?: (info: { code?: number | null; signal?: string | null }) => void;
  onAgentsRoster?: (info: {
    agents?: PoolWorker[];
    liveSessionIds?: string[];
    pool?: { maxWorkers: number; workerCount: number; busyCount: number };
  }) => void;
  onPermissionRequest?: (info: {
    requestId: string;
    workerId?: string;
    sessionId?: string | null;
    title: string;
    detail?: string;
    options?: { optionId: string; name: string; kind?: string | null }[];
  }) => void;
  onPermissionMode?: (info: { mode: string; alwaysApprove?: boolean; note?: string }) => void;
  onQuestionRequest?: (info: {
    requestId: string;
    workerId?: string;
    sessionId?: string | null;
    questions: {
      id: string;
      question: string;
      multiSelect?: boolean;
      options: { id: string; label: string; description?: string; preview?: string | null }[];
    }[];
  }) => void;
  onPlanApprovalRequest?: (info: {
    requestId: string;
    workerId?: string;
    sessionId?: string | null;
    plan: string;
  }) => void;
  onExtRequestCancelled?: (info: { requestId: string; kind?: string }) => void;
};

function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}

const OUTBOX_TYPES = new Set(["prompt", "new_session", "load_session", "ensure", "dispatch"]);

const PING_MS = 10000;
/** No pong within this many missed intervals → force reconnect (half-open socket). */
const PONG_MISS_LIMIT = 3;

export class DeskClient {
  private ws: WebSocket | null = null;
  private handlers: Handlers = {};
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongWatchTimer: ReturnType<typeof setInterval> | null = null;
  private lastPongAt = 0;
  private lastInboundAt = 0;
  private reconnectAttempt = 0;
  /** Buffer critical msgs while WS is down (phone flaps). */
  private outbox: Record<string, unknown>[] = [];
  private static readonly OUTBOX_MAX = 40;

  connect(handlers: Handlers) {
    this.handlers = handlers;
    this.intentionalClose = false;
    this.open();
  }

  /** Force a new socket (phone Retry when Mac was offline). */
  reconnect() {
    this.intentionalClose = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      this.ws?.close();
    } catch {
      /* */
    }
    this.ws = null;
    this.open();
  }

  getReadyState(): number {
    return this.ws?.readyState ?? WebSocket.CLOSED;
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** ms since last pong; Infinity if never */
  lastPongAge(): number {
    if (!this.lastPongAt) return Number.POSITIVE_INFINITY;
    return Date.now() - this.lastPongAt;
  }

  /** ms since any inbound WS message */
  lastInboundAge(): number {
    if (!this.lastInboundAt) return Number.POSITIVE_INFINITY;
    return Date.now() - this.lastInboundAt;
  }

  private clearPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.pongWatchTimer) {
      clearInterval(this.pongWatchTimer);
      this.pongWatchTimer = null;
    }
  }

  private flushOutbox() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const batch = this.outbox.splice(0, this.outbox.length);
    for (const obj of batch) {
      try {
        this.ws.send(JSON.stringify(obj));
      } catch {
        this.outbox.unshift(obj);
        break;
      }
    }
  }

  private scheduleReconnect() {
    if (this.intentionalClose) return;
    if (this.reconnectTimer) return;
    // Exponential backoff with jitter: 0.8s → ~5s cap
    const base = Math.min(5000, 800 * Math.pow(1.6, this.reconnectAttempt));
    const jitter = Math.random() * 200;
    const delay = Math.round(base + jitter);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private forceReconnect(reason: string) {
    console.warn("[desk-ws] force reconnect:", reason);
    this.clearPing();
    try {
      this.ws?.close();
    } catch {
      /* */
    }
    this.ws = null;
    this.scheduleReconnect();
  }

  private open() {
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    const ws = new WebSocket(wsUrl());
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.lastPongAt = Date.now();
      this.lastInboundAt = Date.now();
      this.handlers.onOpen?.();
      // ensure first, then flush queued prompts
      try {
        ws.send(JSON.stringify({ type: "ensure" }));
      } catch {
        /* */
      }
      this.flushOutbox();
      // Keepalive — iOS Safari kills idle WS mid-turn; also detects half-open
      this.clearPing();
      this.pingTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          try {
            this.ws.send(JSON.stringify({ type: "ping" }));
          } catch {
            /* */
          }
        }
      }, PING_MS);
      this.pongWatchTimer = setInterval(() => {
        if (this.intentionalClose) return;
        if (this.ws?.readyState !== WebSocket.OPEN) return;
        const missMs = PING_MS * PONG_MISS_LIMIT;
        if (this.lastPongAge() > missMs) {
          this.forceReconnect(`no pong ${Math.round(this.lastPongAge())}ms`);
        }
      }, PING_MS);
    };

    ws.onclose = () => {
      this.clearPing();
      this.handlers.onClose?.();
      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    };

    ws.onerror = () => {};

    ws.onmessage = (ev) => {
      this.lastInboundAt = Date.now();
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      const type = msg.type as string;
      switch (type) {
        case "hello":
          this.handlers.onHello?.(msg as never);
          break;
        case "status":
          this.handlers.onStatus?.(msg as never);
          break;
        case "ready":
          this.handlers.onReady?.(msg as never);
          break;
        case "turn_start":
          this.handlers.onTurnStart?.({
            sessionId: msg.sessionId ? String(msg.sessionId) : undefined,
            resume: Boolean(msg.resume),
            turnEpoch:
              typeof msg.turnEpoch === "number" ? msg.turnEpoch : undefined,
            draftId: msg.draftId ? String(msg.draftId) : undefined,
          });
          break;
        case "turn_end":
          this.handlers.onTurnEnd?.(msg as never);
          break;
        case "partial_draft":
          this.handlers.onPartialDraft?.(msg as never);
          break;
        case "update":
          this.handlers.onUpdate?.(msg.update as Record<string, unknown>, {
            sessionId: msg.sessionId ? String(msg.sessionId) : undefined,
            turnEpoch:
              typeof msg.turnEpoch === "number" ? msg.turnEpoch : undefined,
          });
          break;
        case "error":
          this.handlers.onError?.(String(msg.error || "error"));
          break;
        case "queued":
          this.handlers.onQueued?.(msg as never);
          break;
        case "queue_update":
          this.handlers.onQueueUpdate?.(msg as never);
          break;
        case "session":
          this.handlers.onSession?.({
            sessionId: String(msg.sessionId || ""),
            cwd: String(msg.cwd || ""),
            mode: msg.mode ? String(msg.mode) : "new",
            title: msg.title ? String(msg.title) : undefined,
          });
          this.handlers.onReady?.({
            agent: {
              agentAlive: true,
              ready: true,
              sessionId: String(msg.sessionId || ""),
              cwd: String(msg.cwd || ""),
              grokBin: "",
            },
          });
          break;
        case "session_loaded":
          this.handlers.onSessionLoaded?.(msg as never);
          this.handlers.onReady?.({
            agent: {
              agentAlive: true,
              ready: true,
              sessionId: String(msg.sessionId || ""),
              cwd: String(msg.cwd || ""),
              grokBin: "",
            },
          });
          break;
        case "session_status":
          this.handlers.onSessionStatus?.({
            state: String(msg.state || "ready") as SessionStatusState,
            sessionId: msg.sessionId ? String(msg.sessionId) : undefined,
            cwd: msg.cwd ? String(msg.cwd) : undefined,
            error: msg.error ? String(msg.error) : undefined,
          });
          break;
        case "session_title":
          this.handlers.onSessionTitle?.({
            sessionId: String(msg.sessionId || ""),
            title: String(msg.title || ""),
          });
          break;
        case "projects_tick":
          this.handlers.onProjectsTick?.(msg as never);
          break;
        case "session_activity":
          this.handlers.onSessionActivity?.({
            sessionId: msg.sessionId ? String(msg.sessionId) : undefined,
            status: String(msg.status || ""),
          });
          break;
        case "agent_exit":
          this.handlers.onAgentExit?.(msg as never);
          break;
        case "agents_roster":
          this.handlers.onAgentsRoster?.(msg as never);
          break;
        case "permission_request":
          this.handlers.onPermissionRequest?.(msg as never);
          break;
        case "permission_mode":
          this.handlers.onPermissionMode?.(msg as never);
          break;
        case "permission_resolved":
          break;
        case "question_request":
          this.handlers.onQuestionRequest?.(msg as never);
          break;
        case "plan_approval_request":
          this.handlers.onPlanApprovalRequest?.(msg as never);
          break;
        case "ext_request_cancelled":
        case "ext_request_resolved":
        case "question_resolved":
        case "plan_approval_resolved":
          this.handlers.onExtRequestCancelled?.(msg as never);
          break;
        case "terminal_output":
        case "terminal_exit":
          // Optional: UI can subscribe via custom event for ArtifactPane
          try {
            window.dispatchEvent(new CustomEvent("desk-terminal", { detail: msg }));
          } catch {
            /* */
          }
          break;
        case "pong":
          this.lastPongAt = Date.now();
          break;
        default:
          break;
      }
    };
  }

  send(obj: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(obj));
        return;
      } catch {
        /* queue below */
      }
    }
    const t = String(obj.type || "");
    // Don't buffer pings / pure ensure spam; buffer prompts & session ops
    if (OUTBOX_TYPES.has(t) && t !== "ensure") {
      this.outbox.push(obj);
      if (this.outbox.length > DeskClient.OUTBOX_MAX) {
        this.outbox.splice(0, this.outbox.length - DeskClient.OUTBOX_MAX);
      }
    }
  }

  prompt(
    text: string,
    attachments?: Array<{
      name: string;
      mime?: string;
      dataBase64?: string;
      path?: string;
    }>,
    opts?: { sessionId?: string | null; clientMsgId?: string },
  ) {
    this.send({
      type: "prompt",
      text,
      attachments: attachments || [],
      sessionId: opts?.sessionId || undefined,
      clientMsgId: opts?.clientMsgId || undefined,
    });
  }

  newSession(cwd?: string) {
    this.send({ type: "new_session", cwd });
  }

  /** Phase 2: spawn parallel agent (or primary if idle) + optional first prompt */
  dispatch(opts?: { cwd?: string; text?: string; clientMsgId?: string }) {
    this.send({
      type: "dispatch",
      cwd: opts?.cwd,
      text: opts?.text,
      clientMsgId: opts?.clientMsgId,
    });
  }

  respondPermission(
    requestId: string,
    decision: "allow" | "allow_always" | "deny",
    optionId?: string,
    pattern?: string,
  ) {
    this.send({
      type: "permission_response",
      requestId,
      decision,
      optionId,
      pattern,
    });
  }

  respondQuestion(
    requestId: string,
    payload: { action: "accept" | "skip" | "chat"; answers?: (string | string[])[] },
  ) {
    this.send({
      type: "question_response",
      requestId,
      action: payload.action,
      answers: payload.answers,
    });
  }

  respondPlanApproval(
    requestId: string,
    payload: { action: "approve" | "reject"; reason?: string; planContent?: string },
  ) {
    this.send({
      type: "plan_approval_response",
      requestId,
      action: payload.action,
      reason: payload.reason,
      planContent: payload.planContent,
    });
  }

  clientInfo(info: { isMobile?: boolean }) {
    this.send({ type: "client_info", ...info });
  }

  setPermissionMode(mode: string) {
    this.send({ type: "set_permission_mode", mode });
  }

  loadSession(sessionId: string, cwd?: string, opts?: { viewOnly?: boolean }) {
    this.send({
      type: "load_session",
      sessionId,
      cwd,
      viewOnly: Boolean(opts?.viewOnly),
    });
  }

  stop() {
    this.send({ type: "stop" });
  }

  requestStatus() {
    this.send({ type: "status" });
  }

  disconnect() {
    this.intentionalClose = true;
    this.clearPing();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }
}

/** HTTP truth poll — works when WS is half-dead. */
export async function fetchTurnTruth(): Promise<TurnSnapshot | null> {
  try {
    const resp = await fetch("/api/turn", { cache: "no-store" });
    if (!resp.ok) return null;
    return (await resp.json()) as TurnSnapshot;
  } catch {
    return null;
  }
}
