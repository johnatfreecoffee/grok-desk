import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DeskClient,
  type AgentStatus,
  type AttachmentPreview,
  type ChatMessage,
  type TurnSnapshot,
} from "./lib/acpClient";
import { Sidebar, SettingsModal, type SessionMeta } from "./components/Sidebar";
import { AuthGate } from "./components/AuthGate";
import { DictateButton } from "./components/DictateButton";
import { LiveTurn, WorkingStrip } from "./components/LiveTurn";
import { MediaLightbox, guessMediaKind, type MediaItem } from "./components/MediaLightbox";
import { extractAutomationFence } from "./lib/automations";
import { ArtifactPane } from "./components/ArtifactPane";
import { ContextMeter } from "./components/ContextMeter";
import { SubagentStrip } from "./components/SubagentStrip";
import { applyTurnUpdate, createTurnDraft, type TurnDraft } from "./lib/turnState";
import { createPendingId, isPendingId, shouldPaint } from "./lib/sessionStore";
import {
  SessionFeedStore,
  draftFromState,
  feedRowSeq,
  loadPersistedFeed,
  persistFeed,
  type FeedContext,
  type FeedFrame,
  type FeedOwner,
  type FeedSubagent,
} from "./lib/sessionFeed";
import {
  artifactsFromDraft,
  shouldAutoOpenArtifacts,
  type Artifact,
} from "./lib/artifacts";
import { copyTextToClipboard } from "./lib/clipboard";
import { SpeakBar } from "./components/SpeakBar";
import {
  ArrowUp,
  ChevronDown,
  Copy,
  Download,
  FolderOpen,
  Gauge,
  GitBranch,
  History,
  Info,
  ListOrdered,
  MoreHorizontal,
  PanelLeft,
  PanelRight,
  Paperclip,
  Plus,
  RotateCcw,
  Undo2,
  X,
} from "lucide-react";
import { NavRail } from "./shell/NavRail";
import { CommandPalette } from "./shell/CommandPalette";
import {
  AgentsPersonasView,
  ArchMap,
  DoctorView,
  HomeDashboard,
  HooksManager,
  MarketplaceView,
  McpStudio,
  MediaStudio,
  MemoryBrowser,
  PlanBoard,
  RadarView,
  SkillsStudio,
  TasksMapView,
  UsageView,
  WorkflowsView,
  WorktreesView,
  AutomationsView,
} from "./views/BuildViews";
import { ModelPicker } from "./components/ModelPicker";
import { PermissionCard, type PermissionRequest } from "./components/PermissionCard";
import {
  PlanApprovalCard,
  QuestionCard,
  type PlanApprovalRequest,
  type QuestionRequest,
} from "./components/QuestionCard";
import { ModuleInfo } from "./components/ModuleInfo";
import { SessionDrawers, type SessionDrawerKind } from "./components/SessionDrawers";
import { QueuePanel, type QueueItem } from "./components/QueuePanel";
import { ForkDialog } from "./components/ForkDialog";
import { buildApi } from "./lib/buildClient";
import type { DeskView } from "./lib/buildClient";

declare global {
  interface Window {
    deskApp?: {
      isApp: boolean;
      restart: () => Promise<{ ok: boolean; mode?: string }>;
      getInfo: () => Promise<{ root: string; port: number; url: string }>;
      pickFolder: () => Promise<string | null>;
      onDaemonDied: (cb: () => void) => () => void;
    };
  }
}

function uid() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Sidebar session dots:
 * - working  amber pulse — turn in flight
 * - planning sky pulse   — plan active
 * - waiting  orange      — approval / pending tool
 * - question yellow      — agent asked something / needs you
 * - done     green       — finished, not yet read
 * - error    red         — turn failed
 * - unread   blue        — manually marked unread
 * (absent)   none        — read / idle
 */
export type SessionListStatus =
  | "working"
  | "planning"
  | "waiting"
  | "question"
  | "done"
  | "error"
  | "unread";

const SESSION_STATUS_KEY = "grok-desk-session-status";
/** legacy key — still read once */
const SESSION_DONE_KEY = "grok-desk-session-done";
const LAST_SESSION_KEY = "grok-desk-last-session";
const SIDEBAR_OPEN_KEY = "grok-desk-sidebar-open";

type LastSession = { id: string; cwd: string };

const STATUS_SET = new Set<SessionListStatus>([
  "working",
  "planning",
  "waiting",
  "question",
  "done",
  "error",
  "unread",
]);

function loadLastSession(): LastSession | null {
  try {
    const raw = localStorage.getItem(LAST_SESSION_KEY);
    if (!raw) return null;
    const j = JSON.parse(raw) as LastSession;
    if (j && typeof j.id === "string" && typeof j.cwd === "string") return j;
  } catch {
    /* */
  }
  return null;
}

function saveLastSession(id: string | null | undefined, cwd: string | null | undefined) {
  try {
    if (!id || !cwd || String(id).startsWith("mail:")) return;
    localStorage.setItem(LAST_SESSION_KEY, JSON.stringify({ id, cwd }));
  } catch {
    /* */
  }
}

function isMobileViewport(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(max-width: 720px)").matches;
}

function loadSidebarOpenDefault(): boolean {
  try {
    const raw = localStorage.getItem(SIDEBAR_OPEN_KEY);
    if (raw === "0") return false;
    if (raw === "1") return true;
  } catch {
    /* */
  }
  // Phone: start collapsed so chat + keyboard own the screen
  if (isMobileViewport()) return false;
  return true;
}

function loadSessionStatuses(): Record<string, SessionListStatus> {
  try {
    const raw = localStorage.getItem(SESSION_STATUS_KEY);
    if (raw) {
      const j = JSON.parse(raw) as Record<string, string>;
      const out: Record<string, SessionListStatus> = {};
      for (const [id, s] of Object.entries(j || {})) {
        if (id && STATUS_SET.has(s as SessionListStatus)) out[id] = s as SessionListStatus;
      }
      return out;
    }
    // migrate legacy done-only list
    const legacy = localStorage.getItem(SESSION_DONE_KEY);
    if (legacy) {
      const ids = JSON.parse(legacy) as string[];
      const out: Record<string, SessionListStatus> = {};
      if (Array.isArray(ids)) {
        for (const id of ids.slice(-120)) {
          if (typeof id === "string" && id) out[id] = "done";
        }
      }
      return out;
    }
  } catch {
    /* */
  }
  return {};
}

function persistSessionStatuses(map: Record<string, SessionListStatus>) {
  try {
    // Never persist ephemeral live dots — hello rehydrates from server truth
    const LIVE = new Set(["working", "planning", "waiting"]);
    const entries = Object.entries(map)
      .filter(([, s]) => s && !LIVE.has(s))
      .slice(-200);
    const obj: Record<string, string> = {};
    for (const [id, s] of entries) obj[id] = s;
    localStorage.setItem(SESSION_STATUS_KEY, JSON.stringify(obj));
  } catch {
    /* */
  }
}

export default function App() {
  const [authPhase, setAuthPhase] = useState<"loading" | "gate" | "ready">("loading");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/auth/status", { credentials: "include" });
        const d = await r.json().catch(() => ({}));
        if (cancelled) return;
        if (d.configured && !d.authenticated) setAuthPhase("gate");
        else setAuthPhase("ready");
      } catch {
        if (!cancelled) setAuthPhase("ready");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (authPhase === "loading") {
    return (
      <div className="auth-gate">
        <div className="auth-gate-card">
          <p className="auth-gate-sub">Checking lock…</p>
        </div>
      </div>
    );
  }
  if (authPhase === "gate") {
    return <AuthGate onAuthed={() => setAuthPhase("ready")} />;
  }
  return <DeskApp />;
}

function DeskApp() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [agent, setAgent] = useState<AgentStatus | null>(null);
  const [speakReady, setSpeakReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(loadSidebarOpenDefault);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [compactMode, setCompactMode] = useState(() => {
    try {
      return localStorage.getItem("grok-desk-compact") === "1";
    } catch {
      return false;
    }
  });
  const [showTimestamps, setShowTimestamps] = useState(() => {
    try {
      return localStorage.getItem("grok-desk-timestamps") === "1";
    } catch {
      return false;
    }
  });
  const [btwOpen, setBtwOpen] = useState(false);
  const [btwText, setBtwText] = useState("");
  const [btwReply, setBtwReply] = useState<string | null>(null);
  const [sidebarTick, setSidebarTick] = useState(0);
  const [loadingSession, setLoadingSession] = useState(false);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [overflowMenuOpen, setOverflowMenuOpen] = useState(false);
  const [chatHelpOpen, setChatHelpOpen] = useState(false);
  const [attachments, setAttachments] = useState<AttachmentPreview[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [queueLen, setQueueLen] = useState(0);
  const [liveDraft, setLiveDraft] = useState<TurnDraft | null>(null);
  /** creating | loading | ready | history_only | error | idle */
  const [sessionPhase, setSessionPhase] = useState<string>("idle");
  const [historyOnly, setHistoryOnly] = useState(false);
  /** A terminal `grok` owns this session (feed `owner && ok`) — no sending. */
  const [readOnly, setReadOnly] = useState(false);
  /** The owning CLI process, so the banner can name it instead of guessing. */
  const [owner, setOwner] = useState<FeedOwner | null>(null);
  /** P6 — every child agent for the viewed session (feed `subagents`). */
  const [subagents, setSubagents] = useState<FeedSubagent[]>([]);
  /** P6 — context window usage from the session's signals.json. */
  const [feedContext, setFeedContext] = useState<FeedContext | null>(null);
  /** P6 — `session_kind`: "headless" / "subagent" chats say what they are. */
  const [sessionKind, setSessionKind] = useState<string | null>(null);
  /** Where a subagent was opened from, so there is a way back to the parent. */
  const [childOrigin, setChildOrigin] = useState<
    { childId: string; parentId: string; parentCwd: string | null; parentTitle: string } | null
  >(null);
  /** UI flag: browsing another chat while a turn runs elsewhere */
  const [viewOnlyBrowse, setViewOnlyBrowse] = useState(false);
  const [sessionTitles, setSessionTitles] = useState<Record<string, string>>({});
  /** Per-session sidebar status dots (absent = idle/read). */
  const [sessionStatuses, setSessionStatuses] = useState<Record<string, SessionListStatus>>(loadSessionStatuses);
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  const [artifactsPinned, setArtifactsPinned] = useState(false);
  const [artifactFocus, setArtifactFocus] = useState<string | null>(null);
  const [sessionArtifacts, setSessionArtifacts] = useState<Artifact[]>([]);
  const [copyFlash, setCopyFlash] = useState(false);
  const [deskView, setDeskView] = useState<DeskView>("chat");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [modeChip, setModeChip] = useState<"agent" | "auto" | "plan" | "yolo">("agent");
  const [permRequest, setPermRequest] = useState<PermissionRequest | null>(null);
  const [questionRequest, setQuestionRequest] = useState<QuestionRequest | null>(null);
  const [planApproval, setPlanApproval] = useState<PlanApprovalRequest | null>(null);
  const [sessionDrawer, setSessionDrawer] = useState<SessionDrawerKind>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const [queueItems, setQueueItems] = useState<QueueItem[]>([]);
  const [forkOpen, setForkOpen] = useState(false);
  const [pinBottom, setPinBottom] = useState(true);
  const [mediaItem, setMediaItem] = useState<MediaItem | null>(null);
  const [liveAgents, setLiveAgents] = useState<
    { workerId: string; sessionId: string | null; cwd: string | null; busy: boolean; isDefault?: boolean }[]
  >([]);
  const [liveSessionIds, setLiveSessionIds] = useState<string[]>([]);
  const [poolInfo, setPoolInfo] = useState<{
    maxWorkers?: number;
    workerCount?: number;
    busyCount?: number;
  } | null>(null);
  const isDesktop = Boolean(window.deskApp?.isApp);
  const isMailSession = Boolean(agent?.sessionId?.startsWith("mail:"));

  const clientRef = useRef<DeskClient | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** P3 — the projection of ~/.grok/sessions. The ONLY transcript truth. */
  const feedRef = useRef(new SessionFeedStore());
  /** sessionId → cwd for every tail this socket is subscribed to. */
  const subsRef = useRef<Map<string, string | null>>(new Map());
  /** Sessions the daemon says have a live Desk (ACP) turn. */
  const deskLiveRef = useRef<Set<string>>(new Set());
  /**
   * Low-latency overlay for a Desk turn: `grok agent stdio` only flushes
   * agent_message_chunk into updates.jsonl at turn end, so the ACP stream is
   * the same content arriving earlier. Display-only, one per session, retired
   * by the feed's own turn_end.
   */
  const overlayRef = useRef<Map<string, { draft: TurnDraft; startSeq: number }>>(new Map());
  /** Optimistic user bubbles waiting for the feed to write the real row. */
  const pendingUserRef = useRef<Map<string, { rows: ChatMessage[]; base: number }>>(new Map());
  const appliedAutoRef = useRef<Set<string>>(new Set());
  const messagesRef = useRef<ChatMessage[]>([]);
  const agentRef = useRef<AgentStatus | null>(null);
  /** Session that owns the in-flight turn (survives navigate-away). */
  const turnSessionRef = useRef<string | null>(null);
  const pendingPromptRef = useRef<{
    text: string;
    atts: Array<{ name: string; mime: string; dataBase64?: string }>;
    label: string;
  } | null>(null);
  /** Stop current turn then force-send this prompt when busy clears. */
  const pendingForceSendRef = useRef<{
    text: string;
    atts: Array<{ name: string; mime: string; dataBase64?: string }>;
    label: string;
  } | null>(null);
  const historyOnlyRef = useRef(false);
  /** Viewing another chat while a different session is still working (do not kill it). */
  const viewOnlyRef = useRef(false);
  const restoredSessionRef = useRef(false);
  /** Preferred project cwd (folder you opened / session you selected). */
  const preferredCwdRef = useRef<string | null>(null);
  /** After + new project on phone: focus composer so keyboard opens. */
  const focusComposerRef = useRef(false);
  /** While true, never paint turn stream into the main pane (New mid-turn). */
  const suppressPaintRef = useRef(false);
  const [prevStoppedBanner, setPrevStoppedBanner] = useState(false);
  const [bgWorkingBanner, setBgWorkingBanner] = useState(false);
  const busyRef = useRef(false);


  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  useEffect(() => {
    agentRef.current = agent;
  }, [agent]);

  // Close + / overflow menus on outside click or Escape
  useEffect(() => {
    if (!newMenuOpen && !overflowMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (t.closest(".new-menu-wrap")) return;
      setNewMenuOpen(false);
      setOverflowMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setNewMenuOpen(false);
        setOverflowMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [newMenuOpen, overflowMenuOpen]);
  useEffect(() => {
    historyOnlyRef.current = historyOnly;
  }, [historyOnly]);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_OPEN_KEY, sidebarOpen ? "1" : "0");
    } catch {
      /* */
    }
  }, [sidebarOpen]);

  const focusComposer = useCallback((opts?: { sync?: boolean }) => {
    const tryFocus = () => {
      const el = taRef.current;
      if (!el || el.disabled) return false;
      el.focus({ preventScroll: false });
      try {
        const len = el.value.length;
        el.setSelectionRange(len, len);
      } catch {
        /* */
      }
      return document.activeElement === el;
    };
    // iOS keyboard: must focus in the same user-gesture stack when possible
    if (opts?.sync) {
      tryFocus();
      return;
    }
    // iOS often needs a second tick after layout / session ready
    requestAnimationFrame(() => {
      if (tryFocus()) return;
      window.setTimeout(() => tryFocus(), 80);
      window.setTimeout(() => tryFocus(), 280);
    });
  }, []);

  // Keep composer above iOS keyboard
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onResize = () => {
      const footer = document.querySelector(".app-footer") as HTMLElement | null;
      if (!footer) return;
      const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      footer.style.paddingBottom = inset > 0 ? `${inset}px` : "";
    };
    vv.addEventListener("resize", onResize);
    vv.addEventListener("scroll", onResize);
    onResize();
    return () => {
      vv.removeEventListener("resize", onResize);
      vv.removeEventListener("scroll", onResize);
    };
  }, []);

  const closeMobileSidebar = useCallback(() => {
    if (isMobileViewport()) setSidebarOpen(false);
  }, []);

  useEffect(() => {
    if (agent?.sessionId && agent?.cwd) {
      saveLastSession(agent.sessionId, agent.cwd);
    }
  }, [agent?.sessionId, agent?.cwd]);

  // Read inside the connect effect, which is created once per mount.
  const artifactsPinnedRef = useRef(false);
  useEffect(() => {
    artifactsPinnedRef.current = artifactsPinned;
  }, [artifactsPinned]);

  const mergeArtifacts = useCallback((fromDraft: Artifact[]) => {
    if (!fromDraft.length) return;
    setSessionArtifacts((prev) => {
      const map = new Map(prev.map((a) => [a.id, a]));
      for (const a of fromDraft) map.set(a.id, a);
      return Array.from(map.values()).slice(-80);
    });
    // Phone: never auto-open artifacts/sidebar on tool/task — user force-closed for this
    if (
      !artifactsPinned &&
      shouldAutoOpenArtifacts(fromDraft) &&
      !isMobileViewport()
    ) {
      setArtifactsOpen(true);
    }
  }, [artifactsPinned]);

  // mergeArtifacts changes identity on every artifactsPinned flip. The socket
  // handlers go through this ref so toggling Artifacts never re-runs the connect
  // effect (that tore down the WebSocket and dropped every event in the gap).
  const mergeArtifactsRef = useRef(mergeArtifacts);
  useEffect(() => {
    mergeArtifactsRef.current = mergeArtifacts;
  }, [mergeArtifacts]);

  /** Set sidebar status for a session. Pass null to clear (read/idle). */
  const setSessionListStatus = useCallback((id: string | null | undefined, status: SessionListStatus | null) => {
    if (!id) return;
    setSessionStatuses((prev) => {
      const cur = prev[id];
      if (!status && !cur) return prev;
      if (status && cur === status) return prev;
      const next = { ...prev };
      if (!status) delete next[id];
      else next[id] = status;
      persistSessionStatuses(next);
      return next;
    });
  }, []);

  const toggleSessionUnread = useCallback((id: string) => {
    setSessionStatuses((prev) => {
      const cur = prev[id];
      const next = { ...prev };
      if (cur === "unread" || cur === "done") {
        delete next[id]; // mark read
      } else if (!cur || cur === "error") {
        next[id] = "unread";
      } else {
        // working/planning/waiting — don't clobber live status
        return prev;
      }
      persistSessionStatuses(next);
      return next;
    });
  }, []);

  /* ------------------------------------------------------------ P3 feed */

  const countUserRows = (list: ChatMessage[]): number =>
    list.reduce((n, m) => (m.role === "user" ? n + 1 : n), 0);

  /** Any session other than `except` that is mid-turn (background banner). */
  const otherWorkingId = useCallback((except: string | null | undefined): string | null => {
    const skip = except ? String(except) : null;
    for (const id of deskLiveRef.current) if (id !== skip) return id;
    return feedRef.current.otherWorkingId(skip);
  }, []);

  /**
   * Repaint the viewed chat from the feed.
   *
   * messages = feed projection
   *          + optimistic user echo not yet on disk
   *          + the live overlay row while a Desk turn is in flight
   * Nothing else may call setMessages.
   */
  const repaintViewed = useCallback(() => {
    const sid = agentRef.current?.sessionId || null;
    if (!sid) {
      setMessages([]);
      setLiveDraft(null);
      setReadOnly(false);
      setSubagents([]);
      setFeedContext(null);
      setSessionKind(null);
      busyRef.current = false;
      setBusy(false);
      return;
    }
    const st = feedRef.current.get(sid);
    const overlay = overlayRef.current.get(sid) || null;
    // The feed's turn_end is the one finalize: past it, the overlay is gone.
    const showOverlay = Boolean(overlay && (!st || st.turnEndSeq <= overlay.startSeq));
    const rows: ChatMessage[] = st ? [...st.messages] : [];
    const pending = pendingUserRef.current.get(sid);
    if (pending?.rows.length) rows.push(...pending.rows);
    if (showOverlay && overlay) {
      // The feed is part-way through flushing this same turn (the CLI writes
      // agent_message_chunk to updates.jsonl in bursts). Its partial assistant
      // row and the overlay are the SAME reply — render one, not two. The
      // turn's user row is kept; only assistant rows opened after the turn
      // started are the overlay's own content.
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        const m = rows[i];
        if (m.role !== "assistant") continue;
        const rowSeq = feedRowSeq(m.id);
        if (rowSeq != null && rowSeq > overlay.startSeq) rows.splice(i, 1);
      }
      const d = overlay.draft;
      rows.push({
        id: d.id,
        role: "assistant",
        content: d.content,
        thought: d.thought || undefined,
        tools: d.tools,
        plan: d.plan,
        phase: d.phase,
        streaming: true,
      });
    }
    setMessages(rows);
    setLiveDraft(showOverlay && overlay ? overlay.draft : draftFromState(st));
    const working = Boolean(st?.working) || deskLiveRef.current.has(sid);
    busyRef.current = working;
    setBusy(working);
    // owner && ok — `owner` alone is populated even when the dir is gone (P2 QC).
    // The daemon now refuses to report an owner without a real projection, and
    // pushes a frame the moment that owner exits, so this unlocks by itself.
    setReadOnly(Boolean(st?.readOnly));
    setOwner(st?.readOnly ? st.owner : null);
    // P6 — terminal fidelity: the strip, the context meter and the "this is a
    // headless run" label all read the same projection as the transcript.
    setSubagents(st?.subagents || []);
    setFeedContext(st?.context || null);
    setSessionKind(st?.sessionKind || null);
    setBgWorkingBanner(otherWorkingId(sid) !== null);
  }, [otherWorkingId]);

  /** Subscribe one session at its stored cursor (0 = newest tail window). */
  const feedSubscribeTo = useCallback((sessionId: string | null | undefined, cwd?: string | null) => {
    const sid = sessionId ? String(sessionId) : "";
    if (!sid || isPendingId(sid) || sid.startsWith("mail:")) return;
    const store = feedRef.current;
    if (!store.has(sid)) {
      // Reload / PWA resume: paint the persisted rows, then resume at that seq
      // instead of starting blank.
      const saved = loadPersistedFeed(sid);
      if (saved?.messages.length) store.hydrate(sid, saved.seq, saved.messages);
    }
    subsRef.current.set(sid, cwd ?? subsRef.current.get(sid) ?? null);
    clientRef.current?.subscribeFeed(sid, store.cursor(sid), subsRef.current.get(sid));
  }, []);

  /**
   * The viewed chat plus everything still working stay subscribed — that is how
   * leaving A mid-turn keeps A's stream complete while you read B.
   */
  const reconcileFeedSubs = useCallback(() => {
    const viewed = agentRef.current?.sessionId || null;
    const keep = new Set<string>();
    if (viewed && !isPendingId(viewed)) keep.add(String(viewed));
    for (const id of deskLiveRef.current) keep.add(id);
    for (const id of feedRef.current.workingIds()) keep.add(id);
    for (const id of [...subsRef.current.keys()]) {
      if (keep.has(id)) continue;
      subsRef.current.delete(id);
      clientRef.current?.unsubscribeFeed(id);
    }
    for (const id of keep) {
      if (subsRef.current.has(id)) continue;
      feedSubscribeTo(id, id === viewed ? agentRef.current?.cwd || null : null);
    }
  }, [feedSubscribeTo]);

  /** After a reconnect / visibility change: resume every tail at its cursor. */
  const resubscribeAll = useCallback(() => {
    const viewed = agentRef.current?.sessionId || null;
    const ids = new Set<string>([...subsRef.current.keys()]);
    if (viewed && !isPendingId(viewed)) ids.add(String(viewed));
    for (const id of deskLiveRef.current) ids.add(id);
    for (const id of ids) {
      feedSubscribeTo(id, subsRef.current.get(id) ?? (id === viewed ? agentRef.current?.cwd || null : null));
    }
  }, [feedSubscribeTo]);

  /** Point the view at a session: bind, subscribe, repaint. */
  const bindSession = useCallback(
    (sessionId: string, cwd: string | null) => {
      const prev = agentRef.current?.sessionId || null;
      setAgent((a) => {
        const next = a
          ? { ...a, sessionId, cwd: cwd || a.cwd, ready: true }
          : { agentAlive: true, ready: true, sessionId, cwd: cwd || "", grokBin: "" };
        agentRef.current = next as AgentStatus;
        return next as AgentStatus;
      });
      if (prev && prev !== sessionId) {
        // Leaving: drop the tail unless that chat is still working.
        const keepPrev =
          deskLiveRef.current.has(prev) || feedRef.current.isWorking(prev);
        if (!keepPrev && subsRef.current.has(prev)) {
          subsRef.current.delete(prev);
          clientRef.current?.unsubscribeFeed(prev);
        }
      }
      feedSubscribeTo(sessionId, cwd);
      repaintViewed();
    },
    [feedSubscribeTo, repaintViewed],
  );

  /** Optimistic user bubble until the feed writes the real one. */
  const pushPendingUser = useCallback(
    (sessionId: string | null | undefined, row: ChatMessage) => {
      const sid = sessionId ? String(sessionId) : "";
      if (!sid) return;
      const cur = pendingUserRef.current.get(sid);
      if (cur) cur.rows.push(row);
      else {
        pendingUserRef.current.set(sid, {
          rows: [row],
          base: countUserRows(feedRef.current.get(sid)?.messages || []),
        });
      }
      repaintViewed();
    },
    [repaintViewed],
  );

  /** Mark a Desk turn live for this session (send / queue). */
  const markDeskTurn = useCallback(
    (sessionId: string | null | undefined) => {
      const sid = sessionId ? String(sessionId) : "";
      if (!sid) return;
      deskLiveRef.current.add(sid);
      if (!turnSessionRef.current) turnSessionRef.current = sid;
      setSessionListStatus(sid, "working");
      reconcileFeedSubs();
      repaintViewed();
    },
    [reconcileFeedSubs, repaintViewed, setSessionListStatus],
  );

  const pinBottomRef = useRef(true);
  const scrollToBottom = useCallback((force = false) => {
    requestAnimationFrame(() => {
      const el = scrollerRef.current;
      if (!el) return;
      if (force || pinBottomRef.current) el.scrollTop = el.scrollHeight;
    });
  }, []);

  const onMessagesScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    pinBottomRef.current = near;
    setPinBottom(near);
  }, []);

  const openMedia = useCallback((url: string, name?: string) => {
    setMediaItem({ url, name, kind: guessMediaKind(url, name) });
  }, []);

  const restart = useCallback(async () => {
    setRestarting(true);
    setError(null);
    try {
      if (window.deskApp?.restart) {
        await window.deskApp.restart();
        setTimeout(() => clientRef.current?.send({ type: "ensure" }), 400);
      } else if (!connected) {
        clientRef.current?.reconnect();
      } else {
        const resp = await fetch("/api/restart", { method: "POST" });
        const body = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(body.error || "Restart failed");
        setTimeout(() => clientRef.current?.send({ type: "ensure" }), 400);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Restart failed");
    } finally {
      setRestarting(false);
    }
  }, [connected]);

  useEffect(() => {
    const unsub = window.deskApp?.onDaemonDied?.(() => {
      setConnected(false);
      setError("Local engine stopped. Hit Restart.");
    });
    return () => unsub?.();
  }, []);

  useEffect(() => {
    const client = new DeskClient();
    clientRef.current = client;

    /**
     * P3 — the daemon's own turn truth for a Desk-driven turn.
     *
     * The feed's `working` is `live && owner`, and `owner` only exists for a
     * session a terminal `grok` registered in active_sessions.json. A turn Desk
     * itself started has no owner row, so the daemon's session-scoped
     * turn_start / turn_end / liveSessionIds is what marks it live. Both are
     * daemon truth; neither is client guesswork.
     */
    const applyDeskTurnTruth = (snap: TurnSnapshot) => {
      const live = new Set<string>(
        (snap.liveSessionIds || []).filter(Boolean).map((s) => String(s)),
      );
      if (snap.turnActive && snap.activeSessionId) live.add(String(snap.activeSessionId));
      for (const id of [...deskLiveRef.current]) {
        if (!live.has(id)) deskLiveRef.current.delete(id);
      }
      for (const id of live) {
        deskLiveRef.current.add(id);
        setSessionListStatus(id, "working");
      }
      if (!turnSessionRef.current || !live.has(turnSessionRef.current)) {
        turnSessionRef.current = otherWorkingId(null);
      }
      reconcileFeedSubs();
      repaintViewed();
    };

    client.connect({
      onOpen: () => {
        setConnected(true);
        setError(null);
        // Phone defaults: always-approve when phoneAlwaysApprove setting is on
        try {
          const mobile =
            window.matchMedia("(pointer: coarse)").matches ||
            /iPhone|iPad|Android/i.test(navigator.userAgent) ||
            window.innerWidth < 720;
          client.clientInfo({ isMobile: mobile });
        } catch {
          /* */
        }
        // Every socket is a fresh subscription surface — resume at the cursor.
        resubscribeAll();
      },
      onClose: () => {
        setConnected(false);
        // Do NOT fake-finalize. The agent keeps working on the Mac while the
        // phone's socket flaps; the feed replays from our cursor on reconnect.
        subsRef.current.clear();
        if (!busyRef.current) restoredSessionRef.current = false;
      },
      onStatus: (info) => {
        if (info.agent) setAgent(info.agent);
        if (typeof (info as { speakReady?: boolean }).speakReady === "boolean") {
          setSpeakReady(Boolean((info as { speakReady?: boolean }).speakReady));
        }
        const snap = info as TurnSnapshot;
        if (snap.agents) setLiveAgents(snap.agents);
        if (snap.liveSessionIds) setLiveSessionIds(snap.liveSessionIds);
        if (snap.pool) setPoolInfo(snap.pool);
        applyDeskTurnTruth(snap);
      },
      onAgentsRoster: (info) => {
        if (info.agents) setLiveAgents(info.agents);
        if (info.liveSessionIds) setLiveSessionIds(info.liveSessionIds);
        if (info.pool) setPoolInfo(info.pool);
      },
      onPermissionRequest: (info) => {
        setPermRequest({
          requestId: info.requestId,
          workerId: info.workerId,
          sessionId: info.sessionId,
          title: info.title || "Tool permission",
          detail: info.detail,
          options: info.options,
        });
        setArtifactsOpen(true);
      },
      onQuestionRequest: (info) => {
        setQuestionRequest({
          requestId: info.requestId,
          workerId: info.workerId,
          sessionId: info.sessionId,
          questions: info.questions || [],
        });
        if (info.sessionId) setSessionListStatus(info.sessionId, "question");
        setDeskView("chat");
      },
      onPlanApprovalRequest: (info) => {
        setPlanApproval({
          requestId: info.requestId,
          workerId: info.workerId,
          sessionId: info.sessionId,
          plan: info.plan || "",
        });
        setDeskView("plan");
      },
      onExtRequestCancelled: (info) => {
        if (info.requestId) {
          setQuestionRequest((q) => (q?.requestId === info.requestId ? null : q));
          setPlanApproval((p) => (p?.requestId === info.requestId ? null : p));
        }
      },
      onPermissionMode: (info) => {
        const m = info.mode;
        if (m === "always-approve" || m === "yolo") setModeChip("yolo");
        else if (m === "auto") setModeChip("auto");
        else if (m === "plan") setModeChip("plan");
        else setModeChip("agent");
      },

      /* ------------------------------------------------------- the feed */
      /**
       * One session's on-disk truth. This is the ONLY writer of transcript
       * state. The feed's own `turn_end` is the ONLY finalize.
       */
      onFeed: (frame) => {
        const sid = frame?.sessionId ? String(frame.sessionId) : "";
        if (!sid) return;
        const store = feedRef.current;
        const prevTurnEndSeq = store.get(sid)?.turnEndSeq || 0;
        const res = store.applyFeed(sid, frame as FeedFrame);
        if (res.ignored) return;
        if (res.gap) {
          // Frame started past our cursor — refetch instead of concatenating
          // over a hole.
          client.subscribeFeed(sid, res.state.seq, subsRef.current.get(sid) || undefined);
          return;
        }
        const st = res.state;

        // Optimistic user echo retires as the feed produces the real rows.
        // Counted, never content-matched — sending "ok" twice keeps both.
        const pending = pendingUserRef.current.get(sid);
        if (pending) {
          const n = countUserRows(st.messages);
          while (pending.rows.length && n > pending.base) {
            pending.rows.shift();
            pending.base += 1;
          }
          if (!pending.rows.length) pendingUserRef.current.delete(sid);
        }

        // THE finalize. A catch-up frame replays old turn_ends, so it may never
        // close a turn that is running right now.
        const overlay = overlayRef.current.get(sid);
        if (
          overlay &&
          !frame.catchUp &&
          st.turnEndSeq > prevTurnEndSeq &&
          st.turnEndSeq > overlay.startSeq
        ) {
          overlayRef.current.delete(sid);
          deskLiveRef.current.delete(sid);
          if (turnSessionRef.current === sid) turnSessionRef.current = otherWorkingId(sid);
          setSessionListStatus(
            sid,
            shouldPaint(agentRef.current?.sessionId, sid) ? null : "done",
          );
          setSidebarTick((n) => n + 1);
        }

        if (st.working) setSessionListStatus(sid, "working");
        if (st.error && frame.catchUp) {
          // The session dir is not there (yet). Never lock the composer on it.
          console.warn("[feed]", sid.slice(0, 8), st.error);
        }
        persistFeed(st);

        if (shouldPaint(agentRef.current?.sessionId, sid)) {
          repaintViewed();
          if (res.changed) scrollToBottom();
          if (st.messages.length) {
            setLoadingSession(false);
            setSessionPhase((p) => (p === "loading" ? "ready" : p));
          }
        } else {
          setBgWorkingBanner(otherWorkingId(agentRef.current?.sessionId) !== null);
        }
      },
      onUnsubscribed: (info) => {
        if (info.sessionId) subsRef.current.delete(String(info.sessionId));
      },
      onStopped: (info) => {
        if (!info.sessionId) return;
        deskLiveRef.current.delete(info.sessionId);
        overlayRef.current.delete(info.sessionId);
        setSessionListStatus(info.sessionId, null);
        if (turnSessionRef.current === info.sessionId) {
          turnSessionRef.current = otherWorkingId(info.sessionId);
        }
        repaintViewed();
      },

      onHello: (info) => {
        setAgent(info.agent);
        if (typeof (info as { speakReady?: boolean }).speakReady === "boolean") {
          setSpeakReady(Boolean((info as { speakReady?: boolean }).speakReady));
        }
        const hello = info as {
          agent: AgentStatus;
          speakReady?: boolean;
          turnActive?: boolean;
          activeSessionId?: string;
          bridgeSessionId?: string;
          queueSessionIds?: string[];
          agents?: typeof liveAgents;
          liveSessionIds?: string[];
          pool?: { maxWorkers: number; workerCount: number; busyCount: number };
        };
        if (hello.agents) setLiveAgents(hello.agents);
        if (hello.liveSessionIds) setLiveSessionIds(hello.liveSessionIds);
        if (hello.pool) setPoolInfo(hello.pool);
        const queued = Array.isArray(hello.queueSessionIds) ? hello.queueSessionIds : [];
        // Rehydrate dots from server; strip stale working/* from localStorage
        setSessionStatuses((prev) => {
          const LIVE = new Set(["working", "planning", "waiting"]);
          const next: Record<string, SessionListStatus> = {};
          for (const [id, s] of Object.entries(prev)) {
            if (s && !LIVE.has(s)) next[id] = s;
          }
          for (const id of hello.liveSessionIds || []) if (id) next[id] = "working";
          for (const q of queued) if (q) next[q] = next[q] || "working";
          persistSessionStatuses(next);
          return next;
        });
        applyDeskTurnTruth(hello as TurnSnapshot);

        // PWA cold start only. `turnActive` is daemon-global, so it must NOT
        // skip the restore — that lands you on the bridge session instead of
        // the chat you were reading.
        if (!restoredSessionRef.current) {
          restoredSessionRef.current = true;
          const last = loadLastSession();
          const curId = info.agent?.sessionId || null;
          if (last?.id) {
            preferredCwdRef.current = last.cwd;
            // Bind and paint from the persisted cursor FIRST — the daemon may
            // already be attached to this session, in which case there is no
            // load_session round trip to wait for and the chat would otherwise
            // come back blank.
            bindSession(last.id, last.cwd);
            if (last.id !== curId) {
              setSessionPhase("loading");
              setLoadingSession(true);
              client.loadSession(last.id, last.cwd);
            }
          } else if (curId) {
            bindSession(curId, info.agent?.cwd || null);
          } else if (info.agent?.cwd) {
            preferredCwdRef.current = info.agent.cwd;
          }
        }
        resubscribeAll();
      },
      onReady: (info) => setAgent(info.agent),

      onSession: (info) => {
        const prevSid = agentRef.current?.sessionId || null;
        if (info.cwd) preferredCwdRef.current = info.cwd;
        saveLastSession(info.sessionId, info.cwd);
        setSessionTitles((prev) =>
          prev[info.sessionId] ? prev : { ...prev, [info.sessionId]: info.title || "New chat" },
        );

        // Rebase a pending new-chat onto the real ACP id. Never copy A → B:
        // only the optimistic echo the user typed into the pending view moves.
        if (isPendingId(prevSid)) {
          const held = pendingUserRef.current.get(prevSid!);
          pendingUserRef.current.delete(prevSid!);
          if (held?.rows.length) {
            pendingUserRef.current.set(info.sessionId, { rows: held.rows, base: 0 });
          }
        }

        bindSession(info.sessionId, info.cwd || null);
        setSessionListStatus(info.sessionId, null);
        suppressPaintRef.current = false;
        setQueueLen(0);
        setLoadingSession(false);
        setSessionPhase("ready");
        setHistoryOnly(false);
        setSessionArtifacts([]);
        setArtifactFocus(null);
        if (!artifactsPinnedRef.current) setArtifactsOpen(false);
        setSidebarTick((n) => n + 1);
        if (focusComposerRef.current) {
          focusComposerRef.current = false;
          window.setTimeout(() => focusComposer(), 50);
        }

        const pending = pendingPromptRef.current;
        if (pending) {
          pendingPromptRef.current = null;
          const t = (pending.label || pending.text).trim().replace(/\s+/g, " ");
          setSessionTitles((prev) => ({
            ...prev,
            [info.sessionId]: (t.length > 72 ? `${t.slice(0, 72)}…` : t) || "New chat",
          }));
          deskLiveRef.current.add(info.sessionId);
          setSessionListStatus(info.sessionId, "working");
          repaintViewed();
          setTimeout(() => {
            clientRef.current?.prompt(pending.text, pending.atts, {
              sessionId: info.sessionId,
              clientMsgId: uid(),
            });
          }, 80);
        }
      },

      onSessionLoaded: (info) => {
        // The transcript is NOT taken from this frame any more — the feed owns
        // it. This only binds the session and reports whether the agent
        // attached.
        bindSession(info.sessionId, info.cwd || null);
        if (info.cwd) preferredCwdRef.current = info.cwd;
        saveLastSession(info.sessionId, info.cwd);
        suppressPaintRef.current = false;
        setQueueLen(0);
        setLoadingSession(false);
        setSessionArtifacts([]);
        setArtifactFocus(null);
        if (!artifactsPinnedRef.current) setArtifactsOpen(false);
        setSessionPhase(info.agentResumed === false ? "history_only" : "ready");
        setHistoryOnly(info.agentResumed === false);
        if (info.loadError && !String(info.sessionId || "").startsWith("mail:")) {
          setError(`Opened this chat. Send stays here — attaching agent (${info.loadError})`);
        }
        setSidebarTick((n) => n + 1);
        scrollToBottom();
      },
      onSessionStatus: (info) => {
        setSessionPhase(info.state);
        if (info.state === "creating" || info.state === "loading") setLoadingSession(true);
        if (info.state === "ready") {
          setLoadingSession(false);
          setHistoryOnly(false);
        }
        if (info.state === "history_only") {
          setLoadingSession(false);
          setHistoryOnly(true);
        }
        if (info.state === "error") {
          setLoadingSession(false);
          if (info.error) setError(info.error);
        }
      },
      onSessionTitle: (info) => {
        if (!info.sessionId || !info.title) return;
        setSessionTitles((prev) => ({ ...prev, [info.sessionId]: info.title }));
        setSidebarTick((n) => n + 1);
      },
      onProjectsTick: () => setSidebarTick((n) => n + 1),
      onSessionActivity: (info) => {
        const sid = info.sessionId;
        if (!sid || !info.status) return;
        const s = info.status as SessionListStatus;
        if (!STATUS_SET.has(s)) return;
        setSessionListStatus(sid, s);
      },

      /**
       * Desk's own turn started. This opens the low-latency overlay row:
       * `grok agent stdio` only flushes agent_message_chunk into updates.jsonl
       * when the turn completes, so the ACP stream is the same content arriving
       * earlier. It is display-only — the feed replaces it at turn_end.
       */
      onTurnStart: (info) => {
        const sid = info?.sessionId ? String(info.sessionId) : null;
        if (!sid) return;
        deskLiveRef.current.add(sid);
        if (!turnSessionRef.current || turnSessionRef.current === sid) {
          turnSessionRef.current = sid;
        }
        setSessionListStatus(sid, "working");
        if (!overlayRef.current.has(sid)) {
          overlayRef.current.set(sid, {
            draft: createTurnDraft(info?.draftId || uid()),
            startSeq: feedRef.current.seqOf(sid),
          });
        }
        if (shouldPaint(agentRef.current?.sessionId, sid)) {
          setHistoryOnly(false);
          setSessionPhase("ready");
        }
        reconcileFeedSubs();
        repaintViewed();
      },

      onUpdate: (update, meta) => {
        const sid = meta?.sessionId ? String(meta.sessionId) : null;
        if (!sid) return; // untagged stream events are dropped, never guessed
        let entry = overlayRef.current.get(sid);
        if (!entry) {
          if (!deskLiveRef.current.has(sid)) return; // stale update after the turn
          entry = { draft: createTurnDraft(uid()), startSeq: feedRef.current.seqOf(sid) };
          overlayRef.current.set(sid, entry);
        }
        // applyTurnUpdate mutates; the draft belongs to exactly one session, so
        // it can never leak into the chat on screen (the P0 bug).
        applyTurnUpdate(entry.draft, update);
        entry.draft = {
          ...entry.draft,
          tools: entry.draft.tools.map((t) => ({ ...t })),
          plan: entry.draft.plan.map((p) => ({ ...p })),
        };
        overlayRef.current.set(sid, entry);
        setSessionListStatus(sid, entry.draft.plan.length ? "planning" : "working");
        if (shouldPaint(agentRef.current?.sessionId, sid)) {
          mergeArtifactsRef.current(artifactsFromDraft(entry.draft));
          repaintViewed();
          scrollToBottom();
        }
      },

      onPartialDraft: (info) => {
        const partial = info?.draft;
        const sid = info.sessionId ? String(info.sessionId) : null;
        if (!partial || !sid) return;
        const draft = createTurnDraft(partial.id || uid());
        draft.content = partial.content || "";
        draft.thought = partial.thought || "";
        draft.tools = (partial.tools as TurnDraft["tools"]) || [];
        draft.plan = (partial.plan as TurnDraft["plan"]) || [];
        draft.phase = (partial.phase as TurnDraft["phase"]) || "thinking";
        const prev = overlayRef.current.get(sid);
        overlayRef.current.set(sid, {
          draft,
          startSeq: prev?.startSeq ?? feedRef.current.seqOf(sid),
        });
        deskLiveRef.current.add(sid);
        setSessionListStatus(sid, "working");
        if (shouldPaint(agentRef.current?.sessionId, sid)) {
          repaintViewed();
          scrollToBottom();
        }
      },

      /**
       * The daemon's ACP turn ended. It unlocks the composer; the OVERLAY is
       * left standing until the feed's own turn_end lands, so the reply never
       * flickers out and back while updates.jsonl is being flushed.
       */
      onTurnEnd: (info) => {
        const sid = info?.sessionId ? String(info.sessionId) : null;
        if (!sid) return;
        deskLiveRef.current.delete(sid);
        if (turnSessionRef.current === sid) turnSessionRef.current = otherWorkingId(sid);
        const st = feedRef.current.get(sid);
        // No feed behind this session (dir missing / not readable): nothing will
        // ever finalize the overlay, so retire it here.
        if (!st || !st.ok) overlayRef.current.delete(sid);
        const overlay = overlayRef.current.get(sid);
        if (overlay) mergeArtifactsRef.current(artifactsFromDraft(overlay.draft));
        if (info?.abandoned) setSessionListStatus(sid, null);
        else if (info?.error) setSessionListStatus(sid, "error");
        else if (shouldPaint(agentRef.current?.sessionId, sid)) setSessionListStatus(sid, null);
        else setSessionListStatus(sid, "done");
        if (shouldPaint(agentRef.current?.sessionId, sid)) {
          viewOnlyRef.current = false;
          setViewOnlyBrowse(false);
          setHistoryOnly(false);
          setSessionPhase("ready");
        }
        reconcileFeedSubs();
        repaintViewed();
        setSidebarTick((n) => n + 1);
      },

      onQueued: (info) => {
        setQueueLen(info.remaining);
        if (Array.isArray((info as { items?: QueueItem[] }).items)) {
          setQueueItems((info as { items: QueueItem[] }).items);
        }
      },
      onQueueUpdate: (info) => {
        setQueueLen(info.remaining);
        if (Array.isArray((info as { items?: QueueItem[] }).items)) {
          setQueueItems((info as { items: QueueItem[] }).items);
        } else if (info.remaining === 0) {
          setQueueItems([]);
        }
      },
      onError: (err) => {
        setLoadingSession(false);
        if (/already working/i.test(err)) return;
        setError(err);
      },
      onAgentExit: (info) => {
        const sid = (info as { sessionId?: string })?.sessionId;
        if (sid) {
          deskLiveRef.current.delete(String(sid));
          repaintViewed();
        }
      },
    });
    return () => {
      client.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- connect once per mount
  }, [
    scrollToBottom,
    focusComposer,
    setSessionListStatus,
    repaintViewed,
    reconcileFeedSubs,
    resubscribeAll,
    bindSession,
    otherWorkingId,
  ]);


  /**
   * Phone / PWA resume. One operation: reconnect if the socket died, then
   * resubscribe every tail at its cursor. No force-unlock, no HTTP finalize —
   * the feed replays whatever happened while we were away.
   */
  useEffect(() => {
    const onVis = (ev?: Event) => {
      if (document.visibilityState !== "visible" && !(ev as PageTransitionEvent)?.persisted) {
        if (ev?.type !== "pageshow") return;
      }
      const client = clientRef.current;
      if (!client?.isConnected()) {
        client?.reconnect(); // onOpen resubscribes
        return;
      }
      client.requestStatus();
      client.send({ type: "ping" });
      resubscribeAll();
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pageshow", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pageshow", onVis);
    };
  }, [resubscribeAll]);

  useEffect(() => {
    scrollToBottom();
  }, [messages.length, liveDraft?.content, scrollToBottom]);

  useEffect(() => {
    const last = [...messages].reverse().find((m) => m.role === "assistant" && !m.streaming);
    if (!last || appliedAutoRef.current.has(last.id)) return;
    const { cleaned, payload } = extractAutomationFence(last.content || "");
    if (!payload) return;
    appliedAutoRef.current.add(last.id);
    if (cleaned !== last.content) {
      setMessages((prev) => prev.map((m) => (m.id === last.id ? { ...m, content: cleaned } : m)));
    }
    void buildApi
      .automationCreate({
        title: payload.title,
        prompt: payload.prompt,
        frequency: payload.frequency,
        time: payload.time,
        weekdays: payload.weekdays,
        enabled: payload.enabled,
        cwd: payload.cwd || agentRef.current?.cwd || "",
      })
      .catch(() => {});
  }, [messages]);



  const fileToAttachment = useCallback(async (file: File): Promise<AttachmentPreview> => {
    const dataBase64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const r = String(reader.result || "");
        const b64 = r.includes(",") ? r.split(",")[1] : r;
        resolve(b64 || "");
      };
      reader.onerror = () => reject(new Error("read failed"));
      reader.readAsDataURL(file);
    });
    const mime = file.type || "application/octet-stream";
    const previewUrl = mime.startsWith("image/") ? URL.createObjectURL(file) : undefined;
    return {
      id: uid(),
      name: file.name || "attachment",
      mime,
      dataBase64,
      previewUrl,
      size: file.size,
    };
  }, []);

  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files);
      if (!list.length) return;
      try {
        const next: AttachmentPreview[] = [];
        for (const f of list) {
          if (f.size > 40 * 1024 * 1024) {
            setError(`"${f.name}" is over 40MB`);
            continue;
          }
          next.push(await fileToAttachment(f));
        }
        if (next.length) setAttachments((prev) => [...prev, ...next].slice(0, 12));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not attach file");
      }
    },
    [fileToAttachment],
  );

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const hit = prev.find((a) => a.id === id);
      if (hit?.previewUrl) URL.revokeObjectURL(hit.previewUrl);
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  /** Send explicit text (palette / model / plan board) — same path as composer send */
  const sendText = useCallback(
    (raw: string) => {
      const text = raw.trim();
      if (!text) return;
      pinBottomRef.current = true;
      setPinBottom(true);
      const sid = agentRef.current?.sessionId;
      if (sid?.startsWith("mail:")) {
        setError("Email agent threads are read-only here — reply by email to continue.");
        return;
      }
      if (feedRef.current.get(sid)?.readOnly) {
        setError("This chat is running in a terminal — read-only until that grok exits.");
        return;
      }
      setInput("");
      setError(null);
      const label = text;
      const atts: { name: string; mime: string; dataBase64: string }[] = [];
      pushPendingUser(sid, {
        id: uid(),
        role: "user",
        content: label,
        queued: busyRef.current && !historyOnlyRef.current,
      });
      if (isPendingId(sid) || (historyOnlyRef.current && !sid)) {
        pendingPromptRef.current = { text, atts, label };
        setHistoryOnly(false);
        viewOnlyRef.current = false;
        setViewOnlyBrowse(false);
        setSessionPhase("creating");
        setLoadingSession(true);
        const cwd =
          preferredCwdRef.current ||
          agentRef.current?.cwd ||
          loadLastSession()?.cwd ||
          undefined;
        if (cwd) preferredCwdRef.current = cwd;
        if (!isPendingId(sid)) clientRef.current?.newSession(cwd);
        setSidebarTick((n) => n + 1);
        scrollToBottom();
        return;
      }
      const clientMsgId = uid();
      if (busyRef.current) setQueueLen((n) => n + 1);
      markDeskTurn(sid);
      clientRef.current?.prompt(text, atts, { sessionId: sid, clientMsgId });
      setSidebarTick((n) => n + 1);
      scrollToBottom();
    },
    [scrollToBottom, markDeskTurn, pushPendingUser],
  );

  const send = useCallback(() => {
    const text = input.trim();
    if (!text && attachments.length === 0) return;
    pinBottomRef.current = true;
    setPinBottom(true);
    const sid = agentRef.current?.sessionId;
    // Mail sessions are read-only in Desk
    if (sid?.startsWith("mail:")) {
      setError("Email agent threads are read-only here — reply by email to continue.");
      return;
    }
    if (feedRef.current.get(sid)?.readOnly) {
      setError("This chat is running in a terminal — read-only until that grok exits.");
      return;
    }
    setInput("");
    setError(null);
    const atts = attachments.map((a) => ({
      name: a.name,
      mime: a.mime,
      dataBase64: a.dataBase64,
    }));
    const label =
      text ||
      (attachments.length
        ? `Attached ${attachments.map((a) => a.name).join(", ")}`
        : "");
    // Type-ahead while new session is still creating — send when session arrives
    if (loadingSession && sessionPhase === "creating") {
      pendingPromptRef.current = { text, atts, label };
      pushPendingUser(sid, {
        id: uid(),
        role: "user",
        content: label,
        queued: true,
        attachments: attachments.map((a) => ({
          id: a.id,
          name: a.name,
          mime: a.mime,
          previewUrl: a.previewUrl,
        })),
      });
      setAttachments([]);
      scrollToBottom();
      return;
    }
    const hadUser = messagesRef.current.some((m) => m.role === "user");
    pushPendingUser(sid, {
      id: uid(),
      role: "user",
      content: label,
      queued: busy && !historyOnlyRef.current,
      attachments: attachments.map((a) => ({
        id: a.id,
        name: a.name,
        mime: a.mime,
        previewUrl: a.previewUrl,
      })),
    });
    if (sid && !hadUser && label.trim()) {
      const t = label.trim().replace(/\s+/g, " ");
      const title = t.length > 72 ? `${t.slice(0, 72)}…` : t;
      setSessionTitles((prev) => ({ ...prev, [sid]: title }));
    }
    // Pending new-chat (ACP id not back yet) — hold and create
    if (isPendingId(sid) || (!sid && historyOnlyRef.current)) {
      pendingPromptRef.current = { text, atts, label };
      setHistoryOnly(false);
      viewOnlyRef.current = false;
      setViewOnlyBrowse(false);
      setSessionPhase("creating");
      setLoadingSession(true);
      const cwd =
        preferredCwdRef.current ||
        agentRef.current?.cwd ||
        loadLastSession()?.cwd ||
        undefined;
      if (cwd) preferredCwdRef.current = cwd;
      if (!isPendingId(sid)) clientRef.current?.newSession(cwd);
      setAttachments([]);
      setSidebarTick((n) => n + 1);
      scrollToBottom();
      return;
    }
    // Real session id (CLI or Desk): always prompt that id. Daemon loads it.
    // Never session/new — that forked the chat John was already in.
    if (historyOnlyRef.current && sid) {
      setHistoryOnly(false);
      historyOnlyRef.current = false;
      viewOnlyRef.current = false;
      setViewOnlyBrowse(false);
      setSessionPhase("ready");
    }
    const clientMsgId = uid();
    if (busyRef.current) setQueueLen((n) => n + 1);
    markDeskTurn(sid);
    clientRef.current?.prompt(text, atts, { sessionId: sid, clientMsgId });
    setAttachments([]);
    setSidebarTick((n) => n + 1);
    if (taRef.current) taRef.current.style.height = "auto";
    scrollToBottom();
  }, [
    input,
    busy,
    attachments,
    loadingSession,
    sessionPhase,
    scrollToBottom,
    markDeskTurn,
    pushPendingUser,
  ]);

  /** Drop mid-turn UI so New / Open folder / switch session always work. */
  const resetTurnUi = useCallback(() => {
    busyRef.current = false;
    setBusy(false);
    setLiveDraft(null);
    setQueueLen(0);
  }, []);

  /**
   * Stop ONE session. The daemon answers with `stopped {sessionId}` and the
   * feed writes the finished rows — nothing is patched into the transcript here.
   */
  const stopTurn = useCallback(() => {
    const sid = agentRef.current?.sessionId || turnSessionRef.current;
    if (!sid) return;
    if (!busy && !deskLiveRef.current.has(String(sid))) return;
    clientRef.current?.stop(String(sid));
    deskLiveRef.current.delete(String(sid));
    overlayRef.current.delete(String(sid));
    if (turnSessionRef.current === sid) turnSessionRef.current = otherWorkingId(sid);
    viewOnlyRef.current = false;
    setViewOnlyBrowse(false);
    resetTurnUi();
    repaintViewed();
  }, [busy, resetTurnUi, repaintViewed, otherWorkingId]);

  const flushForceSend = useCallback(() => {
    const p = pendingForceSendRef.current;
    if (!p) return;
    pendingForceSendRef.current = null;
    const sid = agentRef.current?.sessionId;
    if (sid?.startsWith("mail:")) return;
    if (isPendingId(sid) || (!sid && historyOnlyRef.current)) {
      pendingPromptRef.current = p;
      setHistoryOnly(false);
      viewOnlyRef.current = false;
      setViewOnlyBrowse(false);
      setSessionPhase("creating");
      setLoadingSession(true);
      const cwd =
        preferredCwdRef.current ||
        agentRef.current?.cwd ||
        loadLastSession()?.cwd ||
        undefined;
      if (cwd) preferredCwdRef.current = cwd;
      if (!isPendingId(sid)) clientRef.current?.newSession(cwd);
      setSidebarTick((n) => n + 1);
      scrollToBottom();
      return;
    }
    if (historyOnlyRef.current && sid) {
      setHistoryOnly(false);
      historyOnlyRef.current = false;
      viewOnlyRef.current = false;
      setViewOnlyBrowse(false);
      setSessionPhase("ready");
    }
    const clientMsgId = uid();
    markDeskTurn(sid);
    clientRef.current?.prompt(p.text, p.atts, { sessionId: sid, clientMsgId });
    setSidebarTick((n) => n + 1);
    scrollToBottom();
  }, [scrollToBottom, markDeskTurn]);

  useEffect(() => {
    if (busy || !pendingForceSendRef.current) return;
    const t = window.setTimeout(() => flushForceSend(), 50);
    return () => window.clearTimeout(t);
  }, [busy, flushForceSend]);

  /** Stop the active turn (if any) then send the current draft immediately. */
  const sendNow = useCallback(() => {
    const text = input.trim();
    if (!text && attachments.length === 0) return;
    const sid = agentRef.current?.sessionId;
    if (sid?.startsWith("mail:")) {
      setError("Email agent threads are read-only here — reply by email to continue.");
      return;
    }
    if (isMailSession) return;
    if (!busy) {
      send();
      return;
    }
    const atts = attachments.map((a) => ({
      name: a.name,
      mime: a.mime,
      dataBase64: a.dataBase64,
    }));
    const label =
      text ||
      (attachments.length
        ? `Attached ${attachments.map((a) => a.name).join(", ")}`
        : "");
    const attViews = attachments.map((a) => ({
      id: a.id,
      name: a.name,
      mime: a.mime,
      previewUrl: a.previewUrl,
    }));
    pendingForceSendRef.current = { text, atts, label };
    setInput("");
    setError(null);
    setAttachments([]);
    pushPendingUser(sid, {
      id: uid(),
      role: "user",
      content: label,
      queued: false,
      attachments: attViews,
    });
    if (taRef.current) taRef.current.style.height = "auto";
    stopTurn();
  }, [input, attachments, busy, isMailSession, send, stopTurn, pushPendingUser]);

  const setPermissionModeChip = useCallback((id: "agent" | "auto" | "plan" | "yolo") => {
    setModeChip(id);
    if (id === "plan") {
      setDeskView("plan");
      clientRef.current?.setPermissionMode("ask");
    } else if (id === "yolo") {
      clientRef.current?.setPermissionMode("always-approve");
    } else if (id === "auto") {
      clientRef.current?.setPermissionMode("auto");
    } else {
      clientRef.current?.setPermissionMode("ask");
    }
  }, []);

  const newChat = useCallback(
    (cwd?: string) => {
      // Leaving mid-turn A: the daemon continues A on a parallel worker and A
      // stays subscribed, so its stream never remaps onto blank B.
      const stillWorking = otherWorkingId(null);
      setError(null);
      setNewMenuOpen(false);
      setOverflowMenuOpen(false);
      setQueueLen(0);
      const target = cwd || preferredCwdRef.current || agent?.cwd;
      if (target) preferredCwdRef.current = target;
      const pendingId = createPendingId();
      suppressPaintRef.current = false;
      setBgWorkingBanner(Boolean(stillWorking));
      turnSessionRef.current = stillWorking;
      setAgent((a) => {
        const next = a
          ? { ...a, sessionId: pendingId, cwd: target || a.cwd, ready: false }
          : {
              agentAlive: true,
              ready: false,
              sessionId: pendingId,
              cwd: target || "",
              grokBin: "",
            };
        agentRef.current = next as AgentStatus;
        return next as AgentStatus;
      });
      // Pending ids have no feed — the pane is empty until the real id lands.
      reconcileFeedSubs();
      repaintViewed();
      setSessionPhase("creating");
      setLoadingSession(false);
      setHistoryOnly(false);
      setViewOnlyBrowse(false);
      viewOnlyRef.current = false;
      closeMobileSidebar();
      focusComposerRef.current = true;
      clientRef.current?.newSession(target);
      setSidebarTick((n) => n + 1);
      focusComposer({ sync: true });
    },
    [
      agent?.cwd,
      closeMobileSidebar,
      focusComposer,
      otherWorkingId,
      reconcileFeedSubs,
      repaintViewed,
    ],
  );

  const openFolder = useCallback(async () => {
    setNewMenuOpen(false);
    try {
      let folder: string | null = null;
      if (window.deskApp?.pickFolder) {
        folder = await window.deskApp.pickFolder();
      } else {
        // Browser fallback — prompt for path (Electron is the real path)
        folder = window.prompt("Folder path to open as project:", agent?.cwd || "") || null;
      }
      if (!folder) return;
      const stillWorking = otherWorkingId(null);
      setError(null);
      // View unlock only — a session that is still working keeps its tail.
      busyRef.current = false;
      setBusy(false);
      setLiveDraft(null);
      setQueueLen(0);
      setMessages([]);
      turnSessionRef.current = stillWorking;
      setSessionPhase("creating");
      setLoadingSession(true);
      setHistoryOnly(false);
      preferredCwdRef.current = folder;
      suppressPaintRef.current = true;
      setBgWorkingBanner(Boolean(stillWorking));
      setAgent((a) => {
        const next = a ? { ...a, sessionId: null as unknown as string, ready: false } : a;
        agentRef.current = next as AgentStatus;
        return next as AgentStatus;
      });
      reconcileFeedSubs();
      closeMobileSidebar();
      focusComposerRef.current = true;
      clientRef.current?.newSession(folder);
      setSidebarTick((n) => n + 1);
      focusComposer({ sync: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open folder");
      setLoadingSession(false);
      setSessionPhase("error");
    }
  }, [agent?.cwd, closeMobileSidebar, focusComposer, otherWorkingId, reconcileFeedSubs]);

  /**
   * Open a chat. One operation: bind the view, subscribe to that session's feed
   * from its cursor, and let the feed paint. Nothing is copied out of a cache
   * and the session you left keeps streaming if it is still working.
   */
  const openSession = useCallback(
    (s: SessionMeta) => {
      // Allow re-click if stuck loading the same session
      if (s.id === agent?.sessionId && !loadingSession && sessionPhase !== "loading") {
        setSessionListStatus(s.id, null);
        closeMobileSidebar();
        return;
      }
      const stillWorking = deskLiveRef.current.has(s.id) || feedRef.current.isWorking(s.id);
      if (!stillWorking) setSessionListStatus(s.id, null);
      setError(null);
      suppressPaintRef.current = false;
      viewOnlyRef.current = false;
      setViewOnlyBrowse(false);
      // Any deliberate navigation ends the "came from a subagent chip" trail.
      setChildOrigin(null);
      // Another chat working is NOT a reason to lock this composer — but it must
      // not have its turn stolen either, so the daemon is told viewOnly.
      const viewOnly = Boolean(otherWorkingId(s.id));
      setQueueLen(0);
      setSessionPhase("loading");
      setLoadingSession(true);
      setHistoryOnly(false);
      if (s.cwd) preferredCwdRef.current = s.cwd;
      saveLastSession(s.id, s.cwd);
      bindSession(s.id, s.cwd || null);
      closeMobileSidebar();
      clientRef.current?.loadSession(s.id, s.cwd, { viewOnly });
      window.setTimeout(() => {
        setLoadingSession((v) => {
          if (v) setSessionPhase((p) => (p === "loading" ? "history_only" : p));
          return false;
        });
      }, 45000);
    },
    [
      agent?.sessionId,
      loadingSession,
      sessionPhase,
      setSessionListStatus,
      closeMobileSidebar,
      bindSession,
      otherWorkingId,
    ],
  );

  /**
   * P6 — open a subagent's child session from the strip.
   *
   * The sidebar hides subagent sessions (`showSubagentSessions` is off by
   * default and `trackDeskSession` refuses to index them), so this cannot go
   * through the session list. It does not have to: a child session is a real
   * directory under `~/.grok/sessions/`, and `session/load` + the feed take an
   * id, not a sidebar row. The one thing the list would have given us is a way
   * back, so we remember the parent ourselves.
   */
  const openChildSession = useCallback(
    (childSessionId: string, childCwd: string | null, title: string) => {
      const parentId = agentRef.current?.sessionId || null;
      const parentCwd = agentRef.current?.cwd || null;
      const parentTitle =
        (parentId ? sessionTitles[parentId] : null) || folderName(parentCwd) || "parent chat";
      openSession({
        id: childSessionId,
        cwd: childCwd || parentCwd || "",
        title: title || "Subagent",
        updatedAt: null,
        createdAt: null,
        numMessages: 0,
        model: null,
        agentName: null,
      });
      if (parentId && parentId !== childSessionId) {
        setChildOrigin({ childId: childSessionId, parentId, parentCwd, parentTitle });
      }
    },
    [openSession, sessionTitles],
  );

  const copyWholeChat = useCallback(async () => {
    const lines = messagesRef.current
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => {
        const who = m.role === "user" ? "You" : "Grok";
        const body = String(m.content || "").trim();
        const thought = m.thought?.trim()
          ? `\n[thought]\n${m.thought.trim()}`
          : "";
        const tools =
          m.tools && m.tools.length
            ? `\n[tools]\n${m.tools.map((t) => `- ${t.title} (${t.status})`).join("\n")}`
            : "";
        return `${who}:\n${body || "(empty)"}${thought}${tools}`;
      });
    const text = lines.join("\n\n---\n\n") || "(empty chat)";
    const ok = await copyTextToClipboard(text);
    if (ok) {
      setCopyFlash(true);
      setError(null);
      window.setTimeout(() => setCopyFlash(false), 1600);
    } else {
      setError("Could not copy — long-press the chat text and Copy, or use HTTPS/Tailscale Serve");
    }
  }, []);

  const statusPill = useMemo(() => {
    if (!connected) return { cls: "err", label: "Daemon offline" };
    if (busy) return { cls: "warn", label: "Working…" };
    if (sessionPhase === "creating") return { cls: "warn", label: "Starting chat…" };
    if (sessionPhase === "loading") return { cls: "warn", label: "Opening…" };
    if (isMailSession) return { cls: "warn", label: "Mail · read-only" };
    if (readOnly) return { cls: "warn", label: "Terminal" };
    if (historyOnly) return { cls: "warn", label: "Same chat" };
    if (agent?.ready) return { cls: "ok", label: "Ready" };
    if (agent?.agentAlive) return { cls: "warn", label: "Agent starting…" };
    return { cls: "warn", label: "Connecting…" };
  }, [connected, agent, busy, sessionPhase, historyOnly, readOnly, isMailSession]);

  const projectName = useMemo(() => {
    const cwd = agent?.cwd || "";
    if (!cwd) return "";
    const parts = cwd.replace(/\/+$/, "").split("/");
    return parts[parts.length - 1] || cwd;
  }, [agent?.cwd]);

  const composerPlaceholder = useMemo(() => {
    if (readOnly) return "Running in Terminal — read-only";
    if (isMailSession) return "Reply by email to continue";
    if (busy) return "Queue a follow-up…";
    if (historyOnly) return "Continue this chat…";
    if (projectName && messages.length === 0) return `Ask anything about ${projectName}…`;
    return "Message Grok…";
  }, [isMailSession, readOnly, busy, historyOnly, projectName, messages.length]);

  const liveArtifacts = useMemo(() => {
    const fromLive = artifactsFromDraft(liveDraft);
    const map = new Map(sessionArtifacts.map((a) => [a.id, a]));
    for (const a of fromLive) map.set(a.id, a);
    return Array.from(map.values());
  }, [liveDraft, sessionArtifacts]);

  // Never leave composer locked on stuck creating/loading (mobile WS blips)
  useEffect(() => {
    if (sessionPhase !== "creating" && sessionPhase !== "loading") return;
    const t = window.setTimeout(() => {
      setLoadingSession((v) => {
        if (v) {
          setSessionPhase((p) =>
            p === "creating" || p === "loading" ? "history_only" : p,
          );
          setHistoryOnly(true);
        }
        return false;
      });
    }, 45000);
    return () => window.clearTimeout(t);
  }, [sessionPhase]);

  const handlePaletteAction = useCallback(
    (action: string) => {
      if (action.startsWith("view:")) {
        const v = action.slice(5) as DeskView;
        if (v === "settings") {
          setSettingsOpen(true);
          return;
        }
        setDeskView(v);
        return;
      }
      if (action === "new_chat") {
        setDeskView("chat");
        newChat();
        return;
      }
      if (action === "open_sessions") {
        setDeskView("chat");
        setSidebarOpen(true);
        return;
      }
      if (action === "export_chat" || action === "copy_chat") {
        setDeskView("chat");
        void copyWholeChat();
        return;
      }
      if (action === "toggle:compact-mode") {
        setCompactMode((v) => {
          const next = !v;
          try {
            localStorage.setItem("grok-desk-compact", next ? "1" : "0");
          } catch {
            /* */
          }
          return next;
        });
        return;
      }
      if (action === "toggle:timestamps") {
        setShowTimestamps((v) => {
          const next = !v;
          try {
            localStorage.setItem("grok-desk-timestamps", next ? "1" : "0");
          } catch {
            /* */
          }
          return next;
        });
        return;
      }
      if (action === "feedback") {
        setDeskView("chat");
        setInput("/feedback ");
        return;
      }
      if (action === "btw:" || action.startsWith("btw:")) {
        setBtwOpen(true);
        setBtwReply(null);
        const rest = action.startsWith("btw:") ? action.slice(4).trim() : "";
        if (rest) setBtwText(rest);
        return;
      }
      if (action.startsWith("prompt:")) {
        const cmd = action.slice(7);
        setDeskView("chat");
        setInput((prev) => (prev.trim() ? prev : cmd + " "));
        return;
      }
    },
    [newChat, copyWholeChat],
  );

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (permRequest) {
        if (e.key === "1") {
          e.preventDefault();
          clientRef.current?.respondPermission(permRequest.requestId, "allow");
          setPermRequest(null);
          return;
        }
        if (e.key === "2") {
          e.preventDefault();
          clientRef.current?.respondPermission(permRequest.requestId, "allow_always");
          setPermRequest(null);
          return;
        }
        if (e.key === "3" || e.key === "Escape") {
          e.preventDefault();
          clientRef.current?.respondPermission(permRequest.requestId, "deny");
          setPermRequest(null);
          return;
        }
      }
      if (questionRequest) {
        if (e.key === "Escape") {
          e.preventDefault();
          clientRef.current?.respondQuestion(questionRequest.requestId, { action: "skip" });
          setQuestionRequest(null);
          return;
        }
      }
      if (planApproval) {
        if (e.key === "Escape") {
          e.preventDefault();
          clientRef.current?.respondPlanApproval(planApproval.requestId, {
            action: "reject",
            reason: "dismissed",
          });
          setPlanApproval(null);
          return;
        }
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          clientRef.current?.respondPlanApproval(planApproval.requestId, {
            action: "approve",
            planContent: planApproval.plan,
          });
          setPlanApproval(null);
          return;
        }
      }
      if (mediaItem && e.key === "Escape") {
        e.preventDefault();
        setMediaItem(null);
        return;
      }
      if (btwOpen && e.key === "Escape") {
        e.preventDefault();
        setBtwOpen(false);
        return;
      }
      if (meta && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if (meta && e.key === "n") {
        e.preventDefault();
        setDeskView("chat");
        newChat();
      } else if (meta && e.key === "o") {
        e.preventDefault();
        void openFolder();
      } else if (meta && e.key === "b") {
        e.preventDefault();
        setSidebarOpen((v) => !v);
      } else if (meta && e.key === ".") {
        e.preventDefault();
        setArtifactsOpen((v) => {
          const next = !v;
          setArtifactsPinned(next);
          return next;
        });
      } else if (e.key === "Escape" && busy) {
        e.preventDefault();
        stopTurn();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newChat, openFolder, busy, stopTurn, permRequest, mediaItem]);

  const revealPath = useCallback((p: string) => {
    void copyTextToClipboard(p);
  }, []);

  const shellClass = [
    "shell",
    deskView === "chat" && sidebarOpen ? "with-sidebar" : "no-sidebar",
    deskView === "chat" && artifactsOpen ? "with-artifacts" : "",
    deskView !== "chat" ? "build-stage" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const liveTasks = useMemo(() => {
    const tools = liveDraft?.tools || [];
    return tools.map((t, i) => ({
      id: t.id || `t${i}`,
      title: t.title || "tool",
      status: t.status || (busy ? "working" : "done"),
      kind: t.isAgent
        ? "subagent"
        : t.isBackground
          ? "background"
          : t.kind || "tool",
    }));
  }, [liveDraft, busy]);

  const renderBuildView = () => {
    const common = {
      cwd: agent?.cwd || null,
      activeSessionId: agent?.sessionId || null,
      busy,
      onOpenSession: (id: string, cwd: string) => {
        setDeskView("chat");
        openSession({
          id,
          cwd,
          title: sessionTitles[id] || id.slice(0, 8),
          updatedAt: null,
          createdAt: null,
          numMessages: 0,
          model: null,
          agentName: null,
          source: "desk",
        });
      },
      onNewChat: () => {
        setDeskView("chat");
        newChat();
      },
      onDispatch: (text?: string) => {
        setDeskView("chat");
        const cwd = agent?.cwd || preferredCwdRef.current || undefined;
        clientRef.current?.dispatch({
          cwd: cwd || undefined,
          text: text || undefined,
          clientMsgId: `dispatch_${Date.now().toString(36)}`,
        });
        setSidebarTick((n) => n + 1);
      },
      onStopAgent: () => {
        const sid = agentRef.current?.sessionId || turnSessionRef.current;
        clientRef.current?.stop(sid || null);
      },
      onRenameSession: (sessionId, title) => {
        void buildApi.sessionRename(sessionId, title).then(() => setSidebarTick((n) => n + 1));
      },
      onDeleteSession: (sessionId, cwd) => {
        void buildApi.sessionDelete(sessionId, cwd).then((res) => {
          // Delete is refused while a live `grok` holds the session store. Say
          // so — silently doing nothing is worse than the refusal.
          if (res && res.ok === false) setError(res.error || "Could not delete this chat.");
          setSidebarTick((n) => n + 1);
        });
      },
      liveAgents,
      liveSessionIds,
      poolInfo,
      onOpenSettings: () => setSettingsOpen(true),
      onInvokeSkill: (name: string) => {
        setDeskView("chat");
        // Skills without args: fire immediately; with space suffix user fills args
        sendText(`Use the skill "${name}" now — follow its SKILL.md.`);
      },
      onPromptSlash: (cmd: string) => {
        setDeskView("chat");
        const t = cmd.trim();
        // Trailing space = needs user input
        if (cmd.endsWith(" ") || t === "/plan" || t.startsWith("Revise")) {
          setInput(cmd.endsWith(" ") ? cmd : `${cmd} `);
          return;
        }
        sendText(t);
      },
      liveTasks,
      livePlan: (liveDraft?.plan || []).map((p) => ({
        content: p.content,
        status: p.status,
      })),
      sessionStatuses: sessionStatuses as Record<string, string>,
    };
    switch (deskView) {
      case "home":
        return <HomeDashboard {...common} />;
      case "tasks":
        return <TasksMapView {...common} />;
      case "skills":
        return <SkillsStudio {...common} />;
      case "mcp":
        return <McpStudio />;
      case "plan":
        return <PlanBoard {...common} />;
      case "arch":
        return <ArchMap {...common} />;
      case "radar":
        return <RadarView />;
      case "marketplace":
        return <MarketplaceView {...common} />;
      case "personas":
        return <AgentsPersonasView {...common} />;
      case "hooks":
        return <HooksManager />;
      case "memory":
        return <MemoryBrowser {...common} />;
      case "doctor":
        return <DoctorView />;
      case "workflows":
        return <WorkflowsView {...common} />;
      case "worktrees":
        return <WorktreesView {...common} />;
      case "media":
        return <MediaStudio {...common} />;
      case "usage":
        return <UsageView {...common} />;
      case "automations":
        return <AutomationsView {...common} />;
      default:
        return null;
    }
  };

  return (
    <div className={`desk-root ${compactMode ? "compact-mode" : ""}`}>
      <NavRail
        view={deskView}
        onChange={(v) => {
          if (v === "settings") {
            setSettingsOpen(true);
            return;
          }
          setDeskView(v);
        }}
        onOpenPalette={() => setPaletteOpen(true)}
      />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onAction={handlePaletteAction}
      />
      <PermissionCard
        request={permRequest}
        onRespond={(decision, optionId, pattern) => {
          if (!permRequest) return;
          clientRef.current?.respondPermission(
            permRequest.requestId,
            decision,
            optionId,
            pattern,
          );
          setPermRequest(null);
        }}
      />
      <QuestionCard
        request={questionRequest}
        onRespond={(payload) => {
          if (!questionRequest) return;
          clientRef.current?.respondQuestion(questionRequest.requestId, payload);
          if (questionRequest.sessionId) {
            setSessionListStatus(questionRequest.sessionId, "working");
          }
          setQuestionRequest(null);
        }}
      />
      <PlanApprovalCard
        request={planApproval}
        onRespond={(payload) => {
          if (!planApproval) return;
          clientRef.current?.respondPlanApproval(planApproval.requestId, payload);
          setPlanApproval(null);
          if (payload.action === "approve") setDeskView("chat");
        }}
      />
      <SessionDrawers
        sessionId={agent?.sessionId}
        cwd={agent?.cwd}
        context={feedContext}
        open={sessionDrawer}
        onClose={() => setSessionDrawer(null)}
        onReusePrompt={(text) => setInput(text)}
        onRewind={(promptIndex) => {
          const sid = agent?.sessionId;
          if (!sid) return;
          void buildApi.rewindTo(sid, promptIndex, agent?.cwd).then(() => {
            // Soft rewind: keep messages up to roughly that user turn, then ask agent
            setMessages((prev) => {
              let userCount = 0;
              const kept: typeof prev = [];
              for (const m of prev) {
                kept.push(m);
                if (m.role === "user") {
                  if (userCount >= promptIndex) break;
                  userCount += 1;
                }
              }
              return kept;
            });
            setLiveDraft(null);
            sendText(`/rewind`);
            setSessionDrawer(null);
          });
        }}
      />
      <QueuePanel
        open={queueOpen}
        items={queueItems}
        remaining={queueLen}
        onClose={() => setQueueOpen(false)}
        onCancel={(id) => clientRef.current?.send({ type: "queue_cancel", clientMsgId: id })}
        onClear={() => clientRef.current?.send({ type: "queue_clear" })}
      />
      <ForkDialog
        open={forkOpen}
        cwd={agent?.cwd}
        onClose={() => setForkOpen(false)}
        onFork={({ worktree, name, prompt }) => {
          const run = async () => {
            let targetCwd = agent?.cwd || preferredCwdRef.current || undefined;
            if (worktree && targetCwd) {
              try {
                const r = await buildApi.worktreeAction({
                  action: "create",
                  sourceRepo: targetCwd,
                  name: name || `fork-${Date.now().toString(36)}`,
                });
                if (r.path) targetCwd = r.path;
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
                return;
              }
            }
            setDeskView("chat");
            clientRef.current?.dispatch({
              cwd: targetCwd,
              text: prompt || undefined,
              clientMsgId: `fork_${Date.now().toString(36)}`,
            });
            setSidebarTick((n) => n + 1);
          };
          void run();
        }}
      />
    <div className={shellClass}>
      {deskView === "chat" ? (
      <Sidebar
        open={sidebarOpen}
        activeSessionId={agent?.sessionId || null}
        activeCwd={agent?.cwd || null}
        activeBusy={
          busy &&
          Boolean(
            turnSessionRef.current &&
              agent?.sessionId &&
              turnSessionRef.current === agent.sessionId,
          )
        }
        sessionTitles={sessionTitles}
        sessionStatuses={sessionStatuses}
        onSelectSession={openSession}
        onNewInProject={(cwd) => newChat(cwd)}
        onToggleSidebar={() => setSidebarOpen(false)}
        onRefreshNeeded={sidebarTick}
        onOpenSettings={() => setSettingsOpen(true)}
        onToggleUnread={toggleSessionUnread}
      />
      ) : null}

      {deskView === "chat" && sidebarOpen ? (
        <button
          type="button"
          className="sidebar-backdrop"
          aria-label="Close sidebar"
          onClick={() => setSidebarOpen(false)}
        />
      ) : null}

      {deskView !== "chat" ? (
        <div className="app build-app">{renderBuildView()}</div>
      ) : (
      <>
      <div className="app">
        <header className="topbar mobile-topbar">
          <div className="brand">
            {!sidebarOpen && (
              <button
                type="button"
                className="icon-btn sm mobile-menu-btn"
                onClick={() => setSidebarOpen(true)}
                title="Show sidebar"
                aria-label="Show sidebar"
              >
                <PanelLeft size={18} strokeWidth={2} />
              </button>
            )}
            <img className="brand-mark" src="/icon.svg" alt="" />
            <span className="brand-text desktop-only-brand">Grok Desk</span>
            <span className="sub brand-sub desktop-only-brand">local</span>
            <ModuleInfo
              moduleId="chat"
              compact
              className="desktop-only-brand"
              open={chatHelpOpen}
              onOpenChange={setChatHelpOpen}
            />
            {projectName ? (
              <span className="project-chip" title={agent?.cwd || projectName}>
                {projectName}
              </span>
            ) : (
              <span className="brand-text mobile-only-brand">Grok Desk</span>
            )}
          </div>
          <div className="top-actions">
            {agent?.sessionId ? (
              <span
                className="chat-power-btns desktop-only-actions"
                role="toolbar"
                aria-label="Session tools"
              >
                <button
                  type="button"
                  className="icon-btn sm"
                  title="Session info"
                  aria-label="Session info"
                  onClick={() => setSessionDrawer("info")}
                >
                  <Info size={14} strokeWidth={2.25} />
                </button>
                <button
                  type="button"
                  className="icon-btn sm"
                  title="Context & usage"
                  aria-label="Context & usage"
                  onClick={() => setSessionDrawer("context")}
                >
                  <Gauge size={14} strokeWidth={2.25} />
                </button>
                <button
                  type="button"
                  className="icon-btn sm"
                  title="Rewind timeline"
                  aria-label="Rewind timeline"
                  onClick={() => setSessionDrawer("rewind")}
                >
                  <Undo2 size={14} strokeWidth={2.25} />
                </button>
                <button
                  type="button"
                  className="icon-btn sm"
                  title="Prompt history"
                  aria-label="Prompt history"
                  onClick={() => setSessionDrawer("history")}
                >
                  <History size={14} strokeWidth={2.25} />
                </button>
                <button
                  type="button"
                  className="icon-btn sm"
                  title="Fork / worktree"
                  aria-label="Fork / worktree"
                  onClick={() => setForkOpen(true)}
                >
                  <GitBranch size={14} strokeWidth={2.25} />
                </button>
                <button
                  type="button"
                  className={`icon-btn sm ${queueLen > 0 ? "primary-btn" : ""}`}
                  title="Prompt queue"
                  aria-label="Prompt queue"
                  onClick={() => {
                    clientRef.current?.send({ type: "queue_list" });
                    setQueueOpen(true);
                  }}
                >
                  <ListOrdered size={14} strokeWidth={2.25} />
                  {queueLen > 0 ? (
                    <span className="chat-power-q">{queueLen}</span>
                  ) : null}
                </button>
                <button
                  type="button"
                  className="icon-btn sm"
                  title="Export transcript"
                  aria-label="Export transcript"
                  onClick={() => {
                    const body = messages
                      .map((m) => `## ${m.role}\n\n${m.content}\n`)
                      .join("\n");
                    const blob = new Blob([body], { type: "text/markdown" });
                    const a = document.createElement("a");
                    a.href = URL.createObjectURL(blob);
                    a.download = `grok-desk-${(agent?.sessionId || "chat").slice(0, 8)}.md`;
                    a.click();
                    URL.revokeObjectURL(a.href);
                  }}
                >
                  <Download size={14} strokeWidth={2.25} />
                </button>
              </span>
            ) : null}
            <span className={`pill ${statusPill.cls} status-pill`}>
              <span className="dot" />
              <span className="pill-label">{statusPill.label}</span>
            </span>
            {/* P6 — /context parity: the number that says this chat is about
                to auto-compact, next to the rest of the session's status. */}
            <ContextMeter context={feedContext} onOpen={() => setSessionDrawer("context")} />
            <div className="mode-chip-row desktop-only-actions" title="Agent mode">
              {(
                [
                  { id: "agent" as const, label: "Ask" },
                  { id: "auto" as const, label: "Auto" },
                  { id: "plan" as const, label: "Plan" },
                  { id: "yolo" as const, label: "YOLO" },
                ] as const
              ).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={`mode-chip ${modeChip === m.id ? "active" : ""}`}
                  onClick={() => setPermissionModeChip(m.id)}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <span className="desktop-only-actions">
              <ModelPicker
                compact
                onSelect={(modelId, effort) => {
                  const cmd = effort
                    ? `/model ${modelId} ${effort}`
                    : `/model ${modelId}`;
                  sendText(cmd);
                }}
              />
              {speakReady ? (
                <span className="pill ok" title="Subscription TTS — no API key">
                  <span className="dot" />
                  speak ready
                </span>
              ) : (
                <button
                  type="button"
                  className="pill"
                  title="Grok login + grok-speak for reply voice"
                  onClick={() => setSettingsOpen(true)}
                  style={{ cursor: "pointer", border: "none" }}
                >
                  <span className="dot" />
                  speak off
                </button>
              )}
              <button
                className="icon-btn"
                type="button"
                onClick={() => void restart()}
                disabled={restarting}
                title="Restart local engine / agent"
              >
                <RotateCcw size={15} strokeWidth={2} />
                <span>{restarting ? "…" : "Restart"}</span>
              </button>
            </span>
            <button
              type="button"
              className={`icon-btn desktop-only-actions ${copyFlash ? "primary-btn" : ""}`}
              title="Copy whole chat (Termius paste)"
              aria-label="Copy whole chat"
              onClick={() => void copyWholeChat()}
              disabled={messages.length === 0}
            >
              <Copy size={15} strokeWidth={2} />
              <span className="copy-chat-label">{copyFlash ? "Copied" : "Copy"}</span>
            </button>
            <button
              type="button"
              className={`icon-btn desktop-artifacts-btn ${artifactsOpen ? "primary-btn" : ""}`}
              title="Artifacts (⌘.)"
              onClick={() => {
                setArtifactsOpen((v) => {
                  const next = !v;
                  setArtifactsPinned(next);
                  return next;
                });
              }}
            >
              <PanelRight size={15} strokeWidth={2} />
            </button>
            <div className="new-menu-wrap overflow-menu-wrap mobile-only-actions">
              <button
                type="button"
                className="icon-btn"
                title="More"
                aria-label="More actions"
                aria-expanded={overflowMenuOpen}
                onClick={() => {
                  setOverflowMenuOpen((v) => !v);
                  setNewMenuOpen(false);
                }}
              >
                <MoreHorizontal size={18} strokeWidth={2.25} />
              </button>
              {overflowMenuOpen ? (
                <div className="new-menu overflow-menu">
                  {agent?.sessionId ? (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          setOverflowMenuOpen(false);
                          setSessionDrawer("info");
                        }}
                      >
                        <Info size={15} /> Session info
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setOverflowMenuOpen(false);
                          setSessionDrawer("context");
                        }}
                      >
                        <Gauge size={15} /> Context
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setOverflowMenuOpen(false);
                          clientRef.current?.send({ type: "queue_list" });
                          setQueueOpen(true);
                        }}
                      >
                        <ListOrdered size={15} /> Queue{queueLen > 0 ? ` (${queueLen})` : ""}
                      </button>
                    </>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => {
                      setOverflowMenuOpen(false);
                      void copyWholeChat();
                    }}
                    disabled={messages.length === 0}
                  >
                    <Copy size={15} /> {copyFlash ? "Copied" : "Copy chat"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setOverflowMenuOpen(false);
                      setArtifactsOpen((v) => {
                        const next = !v;
                        setArtifactsPinned(next);
                        return next;
                      });
                    }}
                  >
                    <PanelRight size={15} /> Artifacts
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setOverflowMenuOpen(false);
                      setChatHelpOpen(true);
                    }}
                  >
                    <Info size={15} /> How chat works
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setOverflowMenuOpen(false);
                      void restart();
                    }}
                    disabled={restarting}
                  >
                    <RotateCcw size={15} /> Restart
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setOverflowMenuOpen(false);
                      void openFolder();
                    }}
                  >
                    <FolderOpen size={15} /> Open folder…
                  </button>
                </div>
              ) : null}
            </div>
            <div className="new-menu-wrap">
              <button
                className="icon-btn primary-btn"
                type="button"
                onClick={() => {
                  setOverflowMenuOpen(false);
                  if (isMobileViewport()) {
                    newChat();
                    return;
                  }
                  setNewMenuOpen((v) => !v);
                }}
                onContextMenu={(e) => {
                  if (!isMobileViewport()) return;
                  e.preventDefault();
                  void openFolder();
                }}
                disabled={restarting}
                title="New chat (⌘N)"
                aria-label="New chat"
              >
                <Plus size={16} strokeWidth={2.25} />
                <span className="new-btn-label">New</span>
                <ChevronDown size={14} strokeWidth={2} className="new-btn-chevron" />
              </button>
              {newMenuOpen ? (
                <div className="new-menu">
                  <button type="button" onClick={() => newChat()}>
                    <Plus size={15} /> New chat here
                  </button>
                  <button type="button" onClick={() => void openFolder()}>
                    <FolderOpen size={15} /> Open folder…
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </header>

        <div className="app-main">
        {!connected && (
          <div className="banner" role="status">
            {isDesktop ? (
              <>Mac engine offline.</>
            ) : (
              <>
                Mac desk offline — wake the Mac, keep Tailscale on, engine must be running.
              </>
            )}
            <button
              type="button"
              className="icon-btn"
              style={{ marginLeft: 10, padding: "2px 8px" }}
              onClick={() => void restart()}
              disabled={restarting}
            >
              {restarting ? "Starting…" : isDesktop ? "Restart" : "Retry"}
            </button>
          </div>
        )}

        {error && (
          <div className="banner" role="alert">
            {error}
            <button
              type="button"
              className="icon-btn"
              style={{ marginLeft: 10, padding: "2px 8px" }}
              onClick={() => setError(null)}
            >
              dismiss
            </button>
          </div>
        )}

        {prevStoppedBanner && (
          <div className="banner info" role="status">
            Previous chat stopped.
            <button
              type="button"
              className="icon-btn"
              style={{ marginLeft: 10, padding: "2px 8px" }}
              onClick={() => setPrevStoppedBanner(false)}
            >
              dismiss
            </button>
          </div>
        )}
        {bgWorkingBanner &&
          Boolean(turnSessionRef.current) &&
          agent?.sessionId === turnSessionRef.current &&
          busy && (
            <div className="banner info" role="status">
              Grok is still working…
            </div>
          )}
        {sessionPhase === "creating" && (
          <div className="banner info" role="status">
            Starting new chat… type below anytime.
          </div>
        )}
        {sessionPhase === "loading" && (
          <div className="banner info" role="status">
            Opening session…
          </div>
        )}
        {sessionPhase === "ready" && messages.length === 0 && !loadingSession && (
          <div className="banner info" role="status">
            New chat ready — type below to start.
          </div>
        )}
        {readOnly && (
          <div className="banner info" role="status">
            {owner?.kind === "headless" ? "Running headless" : "Running in Terminal"}
            {owner?.pid ? ` · pid ${owner.pid}` : ""} — this chat is read-only here so
            the two processes cannot overwrite each other's turns. It becomes
            sendable on its own when that <code>grok</code> exits.
          </div>
        )}
        {historyOnly && agent?.sessionId?.startsWith("mail:") && (
          <div className="banner info" role="status">
            Email agent thread (Agent Mail). Read-only here — reply by email to continue the thread.
          </div>
        )}
        {bgWorkingBanner &&
          turnSessionRef.current &&
          agent?.sessionId !== turnSessionRef.current && (
          <div className="banner info" role="status">
            Another chat is still working
            {turnSessionRef.current
              ? ` · ${(sessionTitles[turnSessionRef.current] || "live").slice(0, 40)}`
              : ""}
            <button
              type="button"
              className="icon-btn"
              style={{ marginLeft: 10, padding: "2px 10px" }}
              onClick={() => {
                const liveId = turnSessionRef.current;
                if (!liveId) return;
                const cwd =
                  preferredCwdRef.current ||
                  agentRef.current?.cwd ||
                  loadLastSession()?.cwd ||
                  undefined;
                openSession({
                  id: liveId,
                  cwd: cwd || "",
                  title: sessionTitles[liveId] || "Working…",
                  updatedAt: null,
                  createdAt: null,
                  numMessages: 0,
                  model: null,
                  agentName: null,
                });
              }}
            >
              Jump to live
            </button>
          </div>
        )}
        {historyOnly && !viewOnlyBrowse && !readOnly && !agent?.sessionId?.startsWith("mail:") && (
          <div className="banner" role="status">
            This is the same chat. Send continues it — attaching the agent if needed.
          </div>
        )}
        {/* P6 — say what this chat actually is. 80 headless `grok -p` runs on
            this machine listed as ordinary conversations; subagent children
            opened from the strip are not chats you started either. */}
        {sessionKind === "headless" && (
          <div className="banner info" role="status">
            Headless run — this session was started by <code>grok -p</code>, not a chat.
            Its transcript is here in full; sending continues it as a normal chat.
          </div>
        )}
        {childOrigin && agent?.sessionId === childOrigin.childId && (
          <div className="banner info" role="status">
            Subagent session — a child of {childOrigin.parentTitle}.
            <button
              type="button"
              className="icon-btn"
              style={{ marginLeft: 10, padding: "2px 10px" }}
              onClick={() => {
                const back = childOrigin;
                openSession({
                  id: back.parentId,
                  cwd: back.parentCwd || "",
                  title: back.parentTitle,
                  updatedAt: null,
                  createdAt: null,
                  numMessages: 0,
                  model: null,
                  agentName: null,
                });
              }}
            >
              Back to parent
            </button>
          </div>
        )}

        <SubagentStrip
          subagents={subagents}
          cwd={agent?.cwd || null}
          onOpenChild={openChildSession}
        />

        <div className="messages" ref={scrollerRef} onScroll={onMessagesScroll}>
          <div className="messages-inner">
          {messages.length === 0 && sessionPhase !== "loading" && (
            <div className="empty">
              <h1>{isDesktop ? "Grok Desk" : "Local Grok"}</h1>
              <p>
                {sessionPhase === "creating"
                  ? "New chat starting — caret is ready below."
                  : projectName
                    ? `Working in ${projectName}. Start typing below.`
                    : isDesktop
                      ? "Start typing below — or open a project with New."
                      : "Tap + for a new chat, or open the sidebar for projects."}
              </p>
              {!speakReady && isDesktop && (
                <p className="empty-note">
                  Speak uses your Grok login.{" "}
                  <button type="button" className="linkish" onClick={() => setSettingsOpen(true)}>
                    Settings
                  </button>{" "}
                  for voice.
                </p>
              )}
            </div>
          )}
          {messages.map((m) => (
            <div key={m.id} className={`msg ${m.role}${m.queued ? " queued" : ""}`}>
              <div className="role sr-only">
                {m.role === "user" ? "you" : m.role === "assistant" ? "grok" : m.role}
                {m.streaming ? " · live" : ""}
              </div>
              {(m.queued || (showTimestamps && (m as { createdAt?: string }).createdAt)) && (
                <div className="msg-meta">
                  {m.queued ? <span className="queued-badge">queued</span> : null}
                  {showTimestamps && (m as { createdAt?: string }).createdAt ? (
                    <span className="msg-ts">
                      {new Date(String((m as { createdAt?: string }).createdAt)).toLocaleTimeString()}
                    </span>
                  ) : null}
                </div>
              )}
              {m.attachments && m.attachments.length > 0 && (
                <div className="msg-atts">
                  {m.attachments.map((a) =>
                    a.previewUrl ? (
                      <button
                        key={a.id}
                        type="button"
                        className="msg-att-btn"
                        onClick={() => openMedia(a.previewUrl || "", a.name)}
                      >
                        <img src={a.previewUrl} alt={a.name} className="msg-att-img" />
                      </button>
                    ) : (
                      <span key={a.id} className="msg-att-chip">
                        {a.name}
                      </span>
                    ),
                  )}
                </div>
              )}
              {m.role === "assistant" ? (
                <>
                  <LiveTurn
                    draft={
                      m.streaming &&
                      liveDraft &&
                      (liveDraft.id === m.id ||
                        // After reconnect draft id can lag; still show live sequence
                        (m.role === "assistant" && Boolean(m.streaming)))
                        ? liveDraft
                        : {
                            id: m.id,
                            content: m.content,
                            thought: m.thought || "",
                            tools: m.tools || [],
                            plan: m.plan || [],
                            phase: (m.phase as never) || "idle",
                            lastActivity: "",
                          }
                    }
                    streaming={Boolean(m.streaming)}
                    onMedia={openMedia}
                    onToolClick={(toolId) => {
                      setArtifactsOpen(true);
                      setArtifactsPinned(true);
                      // Prefer terminal id; ArtifactPane also matches file-* via list
                      setArtifactFocus(`term-${toolId}`);
                    }}
                  />
                  {m.content && !m.streaming ? (
                    <div className="msg-actions">
                      <SpeakBar text={m.content} messageId={m.id} />
                      <button
                        type="button"
                        className="copy-reply-btn"
                        onClick={() => void copyTextToClipboard(m.content)}
                      >
                        <Copy size={12} /> Copy
                      </button>
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="bubble user-bubble">
                  {m.content
                    .replace(/\n*\s*\[ATTACHED FILES[\s\S]*?\]\s*$/i, "")
                    .trim() || (m.attachments?.length ? "" : m.content)}
                </div>
              )}
            </div>
          ))}
        </div>
        </div>
        {!pinBottom && messages.length > 0 ? (
          <button
            type="button"
            className="jump-latest"
            onClick={() => {
              pinBottomRef.current = true;
              setPinBottom(true);
              scrollToBottom(true);
            }}
          >
            <ChevronDown size={16} strokeWidth={2.4} />
            Latest
          </button>
        ) : null}

        <div className="app-footer">
        {busy &&
          (!turnSessionRef.current || turnSessionRef.current === agent?.sessionId) && (
          <WorkingStrip
            phase={liveDraft?.phase || "thinking"}
            label={
              liveDraft?.lastActivity ||
              (liveDraft?.phase === "tooling"
                ? "Running tools…"
                : liveDraft?.phase === "writing"
                  ? "Writing reply…"
                  : "Thinking…")
            }
            queueLen={queueLen}
            onOpenQueue={() => {
              clientRef.current?.send({ type: "queue_list" });
              setQueueOpen(true);
            }}
            onStop={stopTurn}
            onSendNow={
              input.trim() || attachments.length ? sendNow : undefined
            }
          />
        )}

        <div className="hint">
          {agent?.cwd ? projectLabel(agent.cwd) : " "}
          {busy ? " · working" : ""}
          {sessionPhase === "creating" ? " · starting chat" : ""}
          {sessionPhase === "loading" ? " · opening" : ""}
          {historyOnly ? " · history only" : ""}
        </div>

        <div
          className={`composer-wrap ${dragOver ? "drag-over" : ""}`}
          onDragEnter={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            if (e.dataTransfer.files?.length) void addFiles(e.dataTransfer.files);
          }}
        >
          <div className="composer-inner">
          {attachments.length > 0 && (
            <div className="attach-strip">
              {attachments.map((a) => (
                <div key={a.id} className="attach-chip">
                  {a.previewUrl ? (
                    <img src={a.previewUrl} alt="" className="attach-thumb" />
                  ) : (
                    <span className="attach-file-icon">📄</span>
                  )}
                  <span className="attach-name" title={a.name}>
                    {a.name}
                  </span>
                  <button
                    type="button"
                    className="attach-x"
                    onClick={() => removeAttachment(a.id)}
                    aria-label="Remove"
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="composer-modes" title="Agent mode">
            {(
              [
                { id: "agent" as const, label: "Ask" },
                { id: "auto" as const, label: "Auto" },
                { id: "plan" as const, label: "Plan" },
                { id: "yolo" as const, label: "YOLO" },
              ] as const
            ).map((m) => (
              <button
                key={m.id}
                type="button"
                className={`mode-chip ${modeChip === m.id ? "active" : ""}`}
                onClick={() => setPermissionModeChip(m.id)}
              >
                {m.label}
              </button>
            ))}
          </div>
          <div
            className={`composer pill shell${busy ? " is-busy" : ""}${
              isMailSession || readOnly ? " mail-locked" : ""
            }`}
          >
          <div className="composer-row">
          <DictateButton
            disabled={loadingSession || isMailSession || readOnly}
            onText={(text) => {
              setInput((prev) => {
                const next = prev.trim() ? `${prev.replace(/\s+$/, "")} ${text}` : text;
                return next;
              });
              requestAnimationFrame(() => taRef.current?.focus());
            }}
            onError={(msg) => setError(msg)}
          />
          <button
            type="button"
            className="icon-btn sm"
            title="Attach files"
            disabled={isMailSession || readOnly}
            onClick={() => fileInputRef.current?.click()}
          >
            <Paperclip size={18} strokeWidth={2} />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files?.length) void addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <textarea
            ref={taRef}
            rows={1}
            placeholder={composerPlaceholder}
            value={input}
            inputMode="text"
            enterKeyHint="send"
            // Never disable during creating — iOS needs focus on + gesture for keyboard
            disabled={isMailSession || readOnly}
            onChange={(e) => {
              setInput(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = `${Math.min(180, e.target.scrollHeight)}px`;
            }}
            onPaste={(e) => {
              if (isMailSession) return;
              const items = e.clipboardData?.items;
              if (!items) return;
              const files: File[] = [];
              for (const it of Array.from(items)) {
                if (it.kind === "file") {
                  const f = it.getAsFile();
                  if (f) files.push(f);
                }
              }
              if (files.length) {
                e.preventDefault();
                void addFiles(files);
              }
            }}
            onKeyDown={(e) => {
              if ((e.key === "Enter" && !e.shiftKey) || ((e.metaKey || e.ctrlKey) && e.key === "Enter")) {
                e.preventDefault();
                send();
              }
            }}
          />
          {busy && (input.trim() || attachments.length > 0) ? (
            <button
              type="button"
              className="send-now-btn"
              onClick={sendNow}
              title="Stop & send now"
            >
              Send now
            </button>
          ) : null}
          <button
            type="button"
            className="send-btn icon-send"
            onClick={send}
            title={busy ? "Queue follow-up" : "Send"}
            aria-label={busy ? "Queue follow-up" : "Send"}
            disabled={
              (!input.trim() && attachments.length === 0) ||
              isMailSession ||
              readOnly
            }
          >
            {busy ? (
              <ListOrdered size={16} strokeWidth={2.25} />
            ) : (
              <ArrowUp size={18} strokeWidth={2.5} />
            )}
          </button>
          </div>
          </div>
          </div>
        </div>
        </div>
      </div>
      </div>

      <ArtifactPane
        open={artifactsOpen}
        artifacts={liveArtifacts}
        focusId={artifactFocus}
        cwd={agent?.cwd || null}
        sessionId={agent?.sessionId || null}
        busy={busy}
        onClose={() => {
          setArtifactsOpen(false);
          setArtifactsPinned(false);
        }}
        onRevealPath={revealPath}
      />
      </>
      )}

      <MediaLightbox item={mediaItem} onClose={() => setMediaItem(null)} />

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={() => {
          setSidebarTick((n) => n + 1);
          void fetch("/api/speak/settings")
            .then((r) => r.json())
            .then((d) => {
              if (typeof d.speakReady === "boolean") setSpeakReady(d.speakReady);
            })
            .catch(() => {});
          // refresh status from daemon
          clientRef.current?.send({ type: "status" });
          // sync display prefs
          void fetch("/api/settings")
            .then((r) => r.json())
            .then((d) => {
              const s = d.settings || {};
              if (typeof s.compactMode === "boolean") {
                setCompactMode(s.compactMode);
                try {
                  localStorage.setItem("grok-desk-compact", s.compactMode ? "1" : "0");
                } catch {
                  /* */
                }
              }
              if (typeof s.showTimestamps === "boolean") {
                setShowTimestamps(s.showTimestamps);
                try {
                  localStorage.setItem("grok-desk-timestamps", s.showTimestamps ? "1" : "0");
                } catch {
                  /* */
                }
              }
            })
            .catch(() => {});
        }}
      />

      {btwOpen ? (
        <div className="perm-overlay" role="dialog" aria-modal="true" aria-label="BTW aside">
          <div className="perm-card" style={{ maxWidth: 440 }}>
            <div className="perm-head">
              <div>
                <div className="perm-kicker">/btw</div>
                <h2 className="perm-title">Side question</h2>
              </div>
            </div>
            <p className="build-muted" style={{ fontSize: 12, marginBottom: 8 }}>
              Aside to the agent without replacing your main thread. Sends as a labeled user note.
            </p>
            <textarea
              className="build-textarea"
              rows={3}
              placeholder="Quick question while the main task continues…"
              value={btwText}
              onChange={(e) => setBtwText(e.target.value)}
            />
            {btwReply ? (
              <pre className="build-pre" style={{ marginTop: 8, maxHeight: 160 }}>
                {btwReply}
              </pre>
            ) : null}
            <div className="perm-actions" style={{ marginTop: 10 }}>
              <button
                type="button"
                className="icon-btn primary-btn"
                disabled={!btwText.trim()}
                onClick={() => {
                  const t = btwText.trim();
                  if (!t) return;
                  // Inject as labeled prompt so transcript keeps main flow clear
                  sendText(`[BTW / aside — answer briefly, then continue the main task]\n${t}`);
                  setBtwReply("Sent — answer will stream in chat.");
                  setBtwText("");
                  setTimeout(() => setBtwOpen(false), 600);
                }}
              >
                Ask
              </button>
              <button type="button" className="icon-btn sm" onClick={() => setBtwOpen(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
    </div>
  );
}

/** Last path segment of a cwd — "" when there is no cwd. */
function folderName(cwd: string | null | undefined): string {
  const c = String(cwd || "").replace(/\/+$/, "");
  if (!c) return "";
  const parts = c.split("/");
  return parts[parts.length - 1] || c;
}

function projectLabel(cwd: string): string {
  const parts = cwd.replace(/\/+$/, "").split("/");
  const name = parts[parts.length - 1] || cwd;
  return `${name}  ·  ${cwd}`;
}
