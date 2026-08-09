import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DeskClient,
  fetchTurnTruth,
  type AgentStatus,
  type AttachmentPreview,
  type ChatMessage,
  type TurnSnapshot,
} from "./lib/acpClient";
import { GrokVoiceSession, type VoiceStatus } from "./lib/voiceRealtime";
import { Sidebar, SettingsModal, type SessionMeta } from "./components/Sidebar";
import { VoiceWaveButton } from "./components/VoiceWaveButton";
import { LiveTurn, WorkingStrip } from "./components/LiveTurn";
import { ArtifactPane } from "./components/ArtifactPane";
import { applyTurnUpdate, createTurnDraft, type TurnDraft } from "./lib/turnState";
import {
  artifactsFromDraft,
  shouldAutoOpenArtifacts,
  type Artifact,
} from "./lib/artifacts";
import {
  playVoiceCue,
  preloadVoiceCues,
  startThinkingChime,
  stopThinkingChime,
} from "./lib/voiceCues";
import { copyTextToClipboard } from "./lib/clipboard";
import {
  ChevronDown,
  Copy,
  Download,
  FolderOpen,
  Gauge,
  GitBranch,
  History,
  Info,
  ListOrdered,
  PanelLeft,
  PanelRight,
  Paperclip,
  Plus,
  RotateCcw,
  Square,
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

function recentContext(messages: ChatMessage[], max = 12): string {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-max)
    .map((m) => `${m.role === "user" ? "User" : "Grok"}: ${m.content.slice(0, 800)}`)
    .join("\n");
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
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [agent, setAgent] = useState<AgentStatus | null>(null);
  const [voiceConfigured, setVoiceConfigured] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [voiceActive, setVoiceActive] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>("idle");
  const [voiceLevel, setVoiceLevel] = useState(0);
  const [outLevel, setOutLevel] = useState(0);
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
  const [attachments, setAttachments] = useState<AttachmentPreview[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [queueLen, setQueueLen] = useState(0);
  const [liveDraft, setLiveDraft] = useState<TurnDraft | null>(null);
  /** creating | loading | ready | history_only | error | idle */
  const [sessionPhase, setSessionPhase] = useState<string>("idle");
  const [historyOnly, setHistoryOnly] = useState(false);
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
  const voiceRef = useRef<GrokVoiceSession | null>(null);
  const draftRef = useRef<TurnDraft | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** In-memory transcript per session so switch-away never blanks the chat. */
  const sessionCacheRef = useRef<Map<string, ChatMessage[]>>(new Map());
  /** Live turn drafts that survive session switch / sidebar open-close. */
  const liveDraftBySessionRef = useRef<Map<string, TurnDraft>>(new Map());
  const messagesRef = useRef<ChatMessage[]>([]);
  const agentRef = useRef<AgentStatus | null>(null);
  /** Session that owns the in-flight turn (survives navigate-away). */
  const turnSessionRef = useRef<string | null>(null);
  const pendingPromptRef = useRef<{
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

  const stashSession = useCallback(() => {
    const id = agentRef.current?.sessionId;
    if (!id) return;
    const snap = messagesRef.current
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({
        ...m,
        streaming: false,
        queued: false,
      }));
    if (snap.length) sessionCacheRef.current.set(id, snap);
  }, []);

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

  const pickMessages = useCallback((sessionId: string, disk: ChatMessage[]): ChatMessage[] => {
    const cached = sessionCacheRef.current.get(sessionId) || [];
    const norm = (role: string, content: string) => {
      const body = String(content || "")
        .replace(/^\s*\[GROK DESK — PROJECT CONTEXT\][\s\S]*?(?:\n\n|\r\n\r\n)/i, "")
        .replace(/\n*\s*\[ATTACHED FILES[\s\S]*?\]\s*$/i, "")
        .replace(/<image_files>[\s\S]*?<\/image_files>/gi, "")
        .replace(/\[Image #\d+\]/gi, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 240)
        .toLowerCase();
      return `${role}:${body}`;
    };
    const cleanUser = (m: ChatMessage): ChatMessage => {
      if (m.role !== "user") return m;
      const c = String(m.content || "")
        .replace(/^\s*\[GROK DESK — PROJECT CONTEXT\][\s\S]*?(?:\n\n|\r\n\r\n)/i, "")
        .replace(/\n*\s*\[ATTACHED FILES[\s\S]*?\]\s*$/i, "")
        .replace(/<image_files>[\s\S]*?<\/image_files>/gi, "")
        .trim();
      return c === m.content ? m : { ...m, content: c };
    };
    const enrich = (base: ChatMessage, extra?: ChatMessage): ChatMessage => {
      if (!extra) return base;
      if (base.role !== "assistant" && extra.role !== "assistant") {
        if (extra.attachments?.length && !base.attachments?.length) {
          return { ...base, attachments: extra.attachments, id: base.id || extra.id };
        }
        return base;
      }
      // Prefer the longer assistant body (cache often has live partial/final Desk wrote)
      const baseLen = (base.content || "").length;
      const extraLen = (extra.content || "").length;
      const richer = extraLen > baseLen + 20 ? extra : base;
      const poorer = richer === extra ? base : extra;
      return {
        ...richer,
        id: richer.id || poorer.id,
        thought: richer.thought || poorer.thought,
        tools: richer.tools?.length ? richer.tools : poorer.tools,
        plan: richer.plan?.length ? richer.plan : poorer.plan,
        phase: richer.phase || poorer.phase,
        // Never re-infect finished rows with sticky streaming from cache
        streaming: Boolean(base.streaming && extra.streaming),
        attachments: base.attachments?.length ? base.attachments : extra.attachments,
      };
    };
    if (!disk.length && cached.length) return cached.map(cleanUser);
    if (!cached.length) return disk.map(cleanUser);
    // Prefer cache when it has more turns OR richer last assistant content
    const cacheLast = [...cached].reverse().find((m) => m.role === "assistant");
    const diskLast = [...disk].reverse().find((m) => m.role === "assistant");
    if (
      cached.length > disk.length ||
      ((cacheLast?.content?.length || 0) > (diskLast?.content?.length || 0) + 40 &&
        cached.length >= disk.length - 1)
    ) {
      // Still merge disk-only tails via fingerprint pass below when counts close
      if (cached.length > disk.length) return cached.map(cleanUser);
    }
    // Merge: keep disk order (cleaned), add cached lines disk missed.
    // Prefer cached user message when fingerprint matches (keeps image previews).
    const diskClean = disk.map(cleanUser);
    const byKey = new Map<string, ChatMessage>();
    for (const m of diskClean) byKey.set(norm(m.role, m.content), m);
    for (const m of cached.map(cleanUser)) {
      const k = norm(m.role, m.content);
      const prev = byKey.get(k);
      if (!prev) {
        byKey.set(k, m);
        continue;
      }
      byKey.set(k, enrich(prev, m));
    }
    // Preserve approximate order: disk sequence, then any pure-cache extras
    const out: ChatMessage[] = [];
    const used = new Set<string>();
    for (const m of diskClean) {
      const k = norm(m.role, m.content);
      if (used.has(k)) continue;
      used.add(k);
      out.push(byKey.get(k) || m);
    }
    for (const m of cached.map(cleanUser)) {
      const k = norm(m.role, m.content);
      if (used.has(k)) continue;
      used.add(k);
      out.push(m);
    }
    return out;
  }, []);

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      const el = scrollerRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
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

    /** Strip streaming from every message (zombies after reconnect unlock). */
    const stripAllStreaming = (list: ChatMessage[]): ChatMessage[] =>
      list.map((m) => (m.streaming ? { ...m, streaming: false, phase: m.phase === "idle" ? m.phase : "idle" } : m));

    /** Unlock UI + finalize draft when server is idle but client still thinks mid-turn. */
    const finalizeIdleTurn = (opts?: {
      pullTranscript?: boolean;
      error?: boolean;
      reason?: string;
    }) => {
      const sid = turnSessionRef.current || agentRef.current?.sessionId || null;
      const draft = draftRef.current;
      const viewing =
        !suppressPaintRef.current &&
        (!sid || agentRef.current?.sessionId === sid);

      setBusy(false);
      setBgWorkingBanner(false);

      const applyFinalizeList = (prev: ChatMessage[]): ChatMessage[] => {
        let next = stripAllStreaming(prev);
        if (draft) {
          next = next.map((m) =>
            m.id === draft.id
              ? {
                  ...m,
                  streaming: false,
                  content:
                    draft.content ||
                    m.content ||
                    (draft.tools.length ? "" : "✓"),
                  thought: draft.thought || undefined,
                  tools: draft.tools,
                  plan: draft.plan,
                  phase: "idle",
                }
              : m,
          );
          if (!next.some((m) => m.id === draft.id)) {
            next.push({
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
        }
        return next;
      };

      if (viewing) {
        setMessages((prev) => {
          const next = applyFinalizeList(prev);
          if (sid) sessionCacheRef.current.set(sid, next);
          return next;
        });
        setLiveDraft(null);
      } else if (sid) {
        const cached = sessionCacheRef.current.get(sid) || [];
        sessionCacheRef.current.set(sid, applyFinalizeList(cached));
      } else {
        setMessages((prev) => stripAllStreaming(prev));
      }

      draftRef.current = null;
      if (viewing) setLiveDraft(null);
      if (sid) {
        liveDraftBySessionRef.current.delete(sid);
        if (opts?.error) setSessionListStatus(sid, "error");
        else if (viewing) setSessionListStatus(sid, null);
        else setSessionListStatus(sid, "done");
      }
      turnSessionRef.current = null;
      setSidebarTick((n) => n + 1);

      if (opts?.pullTranscript !== false && sid && viewing) {
        void (async () => {
          try {
            const q = agentRef.current?.cwd
              ? `?cwd=${encodeURIComponent(agentRef.current.cwd)}`
              : "";
            const resp = await fetch(
              `/api/sessions/${encodeURIComponent(sid)}/transcript${q}`,
            );
            if (!resp.ok) return;
            if (agentRef.current?.sessionId !== sid) return;
            const data = await resp.json();
            const disk: ChatMessage[] = (data.messages || []).map(
              (m: {
                id?: string;
                role: string;
                content: string;
                thought?: string;
                tools?: ChatMessage["tools"];
                plan?: ChatMessage["plan"];
              }) => ({
                id: m.id || uid(),
                role: m.role as ChatMessage["role"],
                content: m.content || "",
                thought: m.thought,
                tools: m.tools,
                plan: m.plan,
                streaming: false,
              }),
            );
            if (!disk.length) return;
            const merged = stripAllStreaming(pickMessages(sid, disk));
            sessionCacheRef.current.set(sid, merged);
            setMessages(merged);
          } catch {
            /* */
          }
        })();
      }
    };

    /** Apply server turn truth (WS status/hello or HTTP /api/turn). */
    const applyTurnTruth = (snap: TurnSnapshot, source: string) => {
      const active = Boolean(snap.turnActive);
      const liveSid =
        snap.activeSessionId ||
        snap.bridgeSessionId ||
        (active ? turnSessionRef.current : null) ||
        null;

      if (!active) {
        if (busyRef.current || draftRef.current) {
          finalizeIdleTurn({ pullTranscript: true, reason: source });
        }
        return;
      }

      // Server live — rehydrate if we own / should show that session
      if (liveSid) {
        turnSessionRef.current = liveSid;
        setBusy(true);
        setSessionListStatus(liveSid, "working");
        const partial = snap.partialDraft;
        if (partial) {
          const id = partial.id || draftRef.current?.id || uid();
          const draft = createTurnDraft(id);
          draft.content = partial.content || "";
          draft.thought = partial.thought || "";
          draft.tools = (partial.tools as TurnDraft["tools"]) || [];
          draft.plan = (partial.plan as TurnDraft["plan"]) || [];
          draft.phase = (partial.phase as TurnDraft["phase"]) || "thinking";
          liveDraftBySessionRef.current.set(liveSid, draft);
          if (agentRef.current?.sessionId === liveSid) {
            draftRef.current = draft;
            setLiveDraft(draft);
          }
        }
        setBgWorkingBanner(
          Boolean(agentRef.current?.sessionId && agentRef.current.sessionId !== liveSid),
        );
      }
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
      },
      onClose: () => {
        setConnected(false);
        // Do NOT fake-finalize the turn. Phone WS flaps mid-stream; agent keeps
        // working on the Mac. Keep streaming UI + busy so reconnect can resume.
        if (busyRef.current || draftRef.current) {
          const draft = draftRef.current;
          const sid = turnSessionRef.current || agentRef.current?.sessionId;
          if (draft && sid) liveDraftBySessionRef.current.set(sid, { ...draft });
          // Stay "working" — status pill will say daemon offline via connected=false
        }
        // Allow hello on next socket to re-bind session without forced load thrash
        // only if we were NOT mid-turn
        if (!busyRef.current && !draftRef.current) {
          restoredSessionRef.current = false;
        }
      },
      onStatus: (info) => {
        if (info.agent) setAgent(info.agent);
        if (typeof info.voiceConfigured === "boolean") setVoiceConfigured(info.voiceConfigured);
        const snap = info as TurnSnapshot;
        if (snap.agents) setLiveAgents(snap.agents);
        if (snap.liveSessionIds) setLiveSessionIds(snap.liveSessionIds);
        if (snap.pool) setPoolInfo(snap.pool);
        applyTurnTruth(snap, "ws-status");
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
        // Open artifacts so user sees context
        setArtifactsOpen(true);
      },
      onQuestionRequest: (info) => {
        setQuestionRequest({
          requestId: info.requestId,
          workerId: info.workerId,
          sessionId: info.sessionId,
          questions: info.questions || [],
        });
        if (info.sessionId) {
          setSessionListStatus(info.sessionId, "question");
        }
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
      onHello: (info) => {
        setAgent(info.agent);
        setVoiceConfigured(info.voiceConfigured);
        const hello = info as {
          agent: AgentStatus;
          voiceConfigured: boolean;
          turnActive?: boolean;
          activeSessionId?: string;
          bridgeSessionId?: string;
          queueSessionIds?: string[];
          partialDraft?: TurnDraft & { sessionId?: string; id?: string };
          agents?: typeof liveAgents;
          liveSessionIds?: string[];
          pool?: { maxWorkers: number; workerCount: number; busyCount: number };
        };
        if (hello.agents) setLiveAgents(hello.agents);
        if (hello.liveSessionIds) setLiveSessionIds(hello.liveSessionIds);
        if (hello.pool) setPoolInfo(hello.pool);
        const liveSid =
          hello.activeSessionId ||
          hello.bridgeSessionId ||
          (hello.turnActive ? turnSessionRef.current : null) ||
          null;
        const queued = Array.isArray(hello.queueSessionIds) ? hello.queueSessionIds : [];
        // Rehydrate dots from server; strip stale working/* from localStorage
        setSessionStatuses((prev) => {
          const LIVE = new Set(["working", "planning", "waiting"]);
          const next: Record<string, SessionListStatus> = {};
          for (const [id, s] of Object.entries(prev)) {
            if (s && !LIVE.has(s)) next[id] = s;
          }
          if (hello.turnActive && liveSid) next[liveSid] = "working";
          for (const q of queued) {
            if (q && q !== liveSid) next[q] = next[q] || "working";
          }
          persistSessionStatuses(next);
          return next;
        });
        applyTurnTruth(hello as TurnSnapshot, "hello");
        // PWA cold start only — never load_session mid-turn (that abandons ACP work)
        if (!restoredSessionRef.current) {
          restoredSessionRef.current = true;
          if (hello.turnActive) {
            // Mid-turn reconnect: keep current session, do not load_session
            return;
          }
          const last = loadLastSession();
          const curId = info.agent?.sessionId;
          const liveSid = turnSessionRef.current;
          if (liveSid && last?.id === liveSid && liveDraftBySessionRef.current.has(liveSid)) {
            preferredCwdRef.current = last.cwd;
            const draft = liveDraftBySessionRef.current.get(liveSid)!;
            draftRef.current = draft;
            setLiveDraft(draft);
          } else if (last && last.id && last.id !== curId) {
            preferredCwdRef.current = last.cwd;
            setSessionPhase("loading");
            setLoadingSession(true);
            client.loadSession(last.id, last.cwd);
          } else if (last?.cwd) {
            preferredCwdRef.current = last.cwd;
          } else if (info.agent?.cwd) {
            preferredCwdRef.current = info.agent.cwd;
          }
        }
      },
      onReady: (info) => setAgent(info.agent),
      onSession: (info) => {
        const prevSid = agentRef.current?.sessionId || null;
        const midTurn = Boolean(
          busyRef.current || draftRef.current || turnSessionRef.current,
        );
        setAgent((a) =>
          a
            ? { ...a, sessionId: info.sessionId, cwd: info.cwd || a.cwd, ready: true }
            : {
                agentAlive: true,
                ready: true,
                sessionId: info.sessionId,
                cwd: info.cwd,
                grokBin: "",
              },
        );
        if (info.cwd) preferredCwdRef.current = info.cwd;
        saveLastSession(info.sessionId, info.cwd);
        // Ensure new chats appear in sidebar immediately under the project
        setSessionTitles((prev) =>
          prev[info.sessionId] ? prev : { ...prev, [info.sessionId]: info.title || "New chat" },
        );
        setSidebarTick((n) => n + 1);

        // CRITICAL: agent often emits session/new after turn_start. Never wipe the
        // live stream / messages mid-turn (mobile "green only" + lost reply).
        if (midTurn) {
          const oldOwner = turnSessionRef.current || prevSid;
          if (oldOwner && oldOwner !== info.sessionId) {
            const cached = sessionCacheRef.current.get(oldOwner);
            if (cached?.length) sessionCacheRef.current.set(info.sessionId, cached);
            const live = liveDraftBySessionRef.current.get(oldOwner);
            if (live) liveDraftBySessionRef.current.set(info.sessionId, live);
            turnSessionRef.current = info.sessionId;
            setSessionListStatus(info.sessionId, "working");
          }
          suppressPaintRef.current = false;
          setLoadingSession(false);
          setSessionPhase("ready");
          setHistoryOnly(false);
          setSidebarTick((n) => n + 1);
          return;
        }

        setSessionListStatus(info.sessionId, null);
        const pending = pendingPromptRef.current;
        if (pending) {
          const seed: ChatMessage[] = [
            {
              id: uid(),
              role: "user",
              content: pending.label || pending.text,
            },
          ];
          setMessages(seed);
          sessionCacheRef.current.set(info.sessionId, seed);
          const t = (pending.label || pending.text).trim().replace(/\s+/g, " ");
          setSessionTitles((prev) => ({
            ...prev,
            [info.sessionId]:
              (t.length > 72 ? t.slice(0, 72) + "…" : t) || info.title || "New chat",
          }));
        } else {
          setMessages([]);
          sessionCacheRef.current.set(info.sessionId, []);
          setSessionTitles((prev) => ({
            ...prev,
            [info.sessionId]: info.title || "New chat",
          }));
        }
        setBusy(false);
        setLiveDraft(null);
        draftRef.current = null;
        viewOnlyRef.current = false;
        setViewOnlyBrowse(false);
        suppressPaintRef.current = false; // New chat session ready — paint allowed
        setQueueLen(0);
        setLoadingSession(false);
        setSessionPhase("ready");
        setHistoryOnly(false);
        setSessionArtifacts([]);
        setArtifactFocus(null);
        if (!artifactsPinned) setArtifactsOpen(false);
        setSidebarTick((n) => n + 1);
        if (focusComposerRef.current) {
          focusComposerRef.current = false;
          // Secondary re-focus after session ready (primary was sync on +)
          window.setTimeout(() => focusComposer(), 50);
        }
        if (pending) {
          pendingPromptRef.current = null;
          setTimeout(() => {
            clientRef.current?.prompt(pending.text, pending.atts, {
              sessionId: info.sessionId,
              clientMsgId: uid(),
            });
          }, 80);
        }
      },
      onSessionLoaded: (info) => {
        setAgent((a) =>
          a
            ? { ...a, sessionId: info.sessionId, cwd: info.cwd || a.cwd, ready: true }
            : {
                agentAlive: true,
                ready: true,
                sessionId: info.sessionId,
                cwd: info.cwd,
                grokBin: "",
              },
        );
        if (info.cwd) preferredCwdRef.current = info.cwd;
        saveLastSession(info.sessionId, info.cwd);
        const disk = (info.messages || []).map((m) => ({
          id: m.id || uid(),
          role: m.role,
          content: m.content,
          thought: (m as ChatMessage).thought,
          tools: (m as ChatMessage).tools,
          plan: (m as ChatMessage).plan,
          streaming: Boolean((m as ChatMessage).streaming),
        }));
        let merged = pickMessages(info.sessionId, disk);
        // Restore live stream if this session still has an in-flight turn
        const partial = (info as { partialDraft?: TurnDraft & { id?: string } }).partialDraft;
        const live =
          liveDraftBySessionRef.current.get(info.sessionId) ||
          (partial
            ? (() => {
                const d = createTurnDraft(partial.id || uid());
                d.content = partial.content || "";
                d.thought = partial.thought || "";
                d.tools = partial.tools || [];
                d.plan = partial.plan || [];
                d.phase = (partial.phase as TurnDraft["phase"]) || "thinking";
                return d;
              })()
            : null);
        if (live) liveDraftBySessionRef.current.set(info.sessionId, live);
        // Fold partial/live into transcript so switch-back never drops the last reply mid-stream
        if (live && (live.content || live.thought || live.tools?.length)) {
          const has = merged.some(
            (m) => m.id === live.id || (m.streaming && m.role === "assistant"),
          );
          if (has) {
            merged = merged.map((m) =>
              m.id === live.id || (m.streaming && m.role === "assistant")
                ? {
                    ...m,
                    id: live.id,
                    content: live.content || m.content,
                    thought: live.thought || m.thought,
                    tools: live.tools?.length ? live.tools : m.tools,
                    plan: live.plan?.length ? live.plan : m.plan,
                    phase: live.phase,
                    streaming: true,
                  }
                : m,
            );
          } else {
            merged = [
              ...merged,
              {
                id: live.id,
                role: "assistant",
                content: live.content,
                thought: live.thought || undefined,
                tools: live.tools,
                plan: live.plan,
                phase: live.phase,
                streaming: true,
              },
            ];
          }
        }
        // Drop sticky streaming flag on finished rows from desk shadow
        if (!(info as { turnActive?: boolean }).turnActive && !live) {
          merged = merged.map((m) => (m.streaming ? { ...m, streaming: false } : m));
        }
        setMessages(merged);
        sessionCacheRef.current.set(info.sessionId, merged);
        const turnActive = Boolean(
          (info as { turnActive?: boolean }).turnActive ||
            (live && turnSessionRef.current === info.sessionId) ||
            Boolean(partial),
        );
        const viewOnly = Boolean((info as { viewOnly?: boolean }).viewOnly);
        if (turnActive && (live || turnSessionRef.current === info.sessionId || partial)) {
          viewOnlyRef.current = false;
          setViewOnlyBrowse(false);
          if (live) {
            draftRef.current = live;
            setLiveDraft(live);
            turnSessionRef.current = info.sessionId;
          }
          setBusy(true);
          setHistoryOnly(false);
          setSessionPhase("ready");
        } else if (viewOnly) {
          // Browsing another chat while a background turn runs
          viewOnlyRef.current = true;
          setViewOnlyBrowse(true);
          setLiveDraft(null);
          draftRef.current = null;
          // keep busy if background turn still going
          setBusy(Boolean(turnSessionRef.current));
          setHistoryOnly(true);
          setSessionPhase("history_only");
        } else if (live && turnSessionRef.current === info.sessionId) {
          viewOnlyRef.current = false;
          setViewOnlyBrowse(false);
          draftRef.current = live;
          setLiveDraft(live);
          setBusy(true);
          setHistoryOnly(false);
          setSessionPhase("ready");
        } else {
          viewOnlyRef.current = false;
          setViewOnlyBrowse(false);
          setBusy(false);
          setLiveDraft(null);
          draftRef.current = null;
          setSessionPhase(info.agentResumed === false ? "history_only" : "ready");
          setHistoryOnly(info.agentResumed === false);
        }
        setQueueLen(0);
        setLoadingSession(false);
        setSessionArtifacts([]);
        setArtifactFocus(null);
        if (!artifactsPinned) setArtifactsOpen(false);
        if (info.loadError && !String(info.sessionId || "").startsWith("mail:")) {
          setError(`History loaded — send to continue in a fresh turn (${info.loadError})`);
        }
        setSidebarTick((n) => n + 1);
        scrollToBottom();
      },
      onSessionStatus: (info) => {
        setSessionPhase(info.state);
        if (info.state === "creating" || info.state === "loading") {
          setLoadingSession(true);
        }
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
      onProjectsTick: () => {
        setSidebarTick((n) => n + 1);
      },
      onSessionActivity: (info) => {
        const sid = info.sessionId || turnSessionRef.current || agentRef.current?.sessionId;
        if (!sid || !info.status) return;
        const s = info.status as SessionListStatus;
        if (!STATUS_SET.has(s)) return;
        // Don't override manual unread with transient states from other sessions
        setSessionListStatus(sid, s);
      },
      onTurnStart: (info) => {
        setBusy(true);
        // Server sessionId is source of truth; never steal owner from viewed chat
        const sid =
          info?.sessionId ||
          turnSessionRef.current ||
          null;
        if (sid) turnSessionRef.current = sid;
        if (sid) setSessionListStatus(sid, "working");
        setBgWorkingBanner(true);
        // New-chat mid-turn: never paint old stream into the blank new thread
        const viewing =
          !suppressPaintRef.current &&
          (!sid ||
            !agentRef.current?.sessionId ||
            agentRef.current?.sessionId === sid);
        // Clear queued badges for the message that just started (view only)
        if (viewing) {
          setMessages((prev) =>
            prev.map((m) => (m.queued ? { ...m, queued: false } : m)),
          );
        }
        // Prefer server draftId so reconnect / partial_draft / desk shadow share one id
        const serverDraftId = info?.draftId ? String(info.draftId) : null;
        // Reconnect may re-emit turn_start — reuse existing streaming draft
        if (info?.resume && draftRef.current) {
          if (serverDraftId && draftRef.current.id !== serverDraftId) {
            draftRef.current = { ...draftRef.current, id: serverDraftId };
          }
          if (viewing) setLiveDraft({ ...draftRef.current });
          return;
        }
        if (draftRef.current && draftRef.current.phase !== "idle") {
          if (serverDraftId && draftRef.current.id !== serverDraftId) {
            const oldId = draftRef.current.id;
            draftRef.current = { ...draftRef.current, id: serverDraftId };
            if (viewing) {
              setMessages((prev) =>
                prev.map((m) => (m.id === oldId ? { ...m, id: serverDraftId } : m)),
              );
            }
          }
          if (viewing) setLiveDraft({ ...draftRef.current });
          return;
        }
        const existing = viewing
          ? messagesRef.current.find((m) => m.streaming && m.role === "assistant")
          : undefined;
        if (existing) {
          const id = serverDraftId || existing.id;
          const draft = createTurnDraft(id);
          draft.content = existing.content || "";
          draft.thought = existing.thought || "";
          draft.tools = existing.tools || [];
          draft.plan = existing.plan || [];
          draftRef.current = draft;
          if (sid) liveDraftBySessionRef.current.set(sid, draft);
          if (viewing) {
            setLiveDraft({ ...draft, tools: [...draft.tools], plan: [...draft.plan] });
            if (id !== existing.id) {
              setMessages((prev) =>
                prev.map((m) => (m.id === existing.id ? { ...m, id } : m)),
              );
            }
          }
          return;
        }
        const id = serverDraftId || uid();
        const draft = createTurnDraft(id);
        draftRef.current = draft;
        if (sid) liveDraftBySessionRef.current.set(sid, draft);
        if (viewing) {
          setLiveDraft({ ...draft, tools: [], plan: [] });
          setMessages((prev) => {
            // Avoid double empty assistant rows on reconnect
            if (prev.some((m) => m.streaming && m.role === "assistant")) {
              return prev.map((m) =>
                m.streaming && m.role === "assistant" ? { ...m, id, streaming: true } : m,
              );
            }
            const next: ChatMessage[] = [
              ...prev,
              { id, role: "assistant", content: "", streaming: true },
            ];
            if (sid) sessionCacheRef.current.set(sid, next);
            return next;
          });
        }
      },
      onUpdate: (update, meta) => {
        const updateSid =
          meta?.sessionId || turnSessionRef.current || agentRef.current?.sessionId || null;
        // Ignore paint into main pane when New is in flight or viewing another chat
        const viewing =
          !suppressPaintRef.current &&
          (!updateSid || agentRef.current?.sessionId === updateSid);
        let draft = draftRef.current;
        // If this update belongs to a different turn owner than current draft, use cache
        if (updateSid && turnSessionRef.current && updateSid !== turnSessionRef.current) {
          draft = liveDraftBySessionRef.current.get(updateSid) || draft;
        }
        // Reconnect mid-stream: only recreate draft if we already know a live turn owner
        // (never invent Working… from a lone late update after finalize)
        if (!draft) {
          const liveOwner = turnSessionRef.current;
          const canRevive =
            Boolean(liveOwner) &&
            (!updateSid || updateSid === liveOwner) &&
            (busyRef.current || liveDraftBySessionRef.current.has(liveOwner!));
          if (!canRevive) {
            // Stale update after turn end — ignore
            return;
          }
          const existing = liveDraftBySessionRef.current.get(liveOwner!);
          const id = existing?.id || uid();
          draft = existing || createTurnDraft(id);
          draftRef.current = draft;
          setBusy(true);
          const sid = updateSid || liveOwner || null;
          if (sid) {
            turnSessionRef.current = sid;
            liveDraftBySessionRef.current.set(sid, draft);
            setSessionListStatus(sid, "working");
          }
          if (viewing && !existing) {
            setMessages((prev) => {
              const next: ChatMessage[] = [
                ...prev,
                { id, role: "assistant", content: "", streaming: true },
              ];
              if (sid) sessionCacheRef.current.set(sid, next);
              return next;
            });
          }
        }
        applyTurnUpdate(draft, update);
        // Clone for React
        const snap: TurnDraft = {
          ...draft,
          tools: draft.tools.map((t) => ({ ...t })),
          plan: draft.plan.map((p) => ({ ...p })),
        };
        if (viewing || !suppressPaintRef.current) draftRef.current = snap;
        const turnSid = updateSid || turnSessionRef.current || agentRef.current?.sessionId;
        if (turnSid) {
          liveDraftBySessionRef.current.set(turnSid, snap);
          // Live dots from phase (always — sidebar truth)
          if (snap.phase === "tooling" && snap.plan.length) setSessionListStatus(turnSid, "planning");
          else if (snap.phase === "tooling") setSessionListStatus(turnSid, "working");
          else if (snap.phase === "thinking") setSessionListStatus(turnSid, "working");
          else if (snap.phase === "writing") setSessionListStatus(turnSid, "working");
        }
        if (viewing) setLiveDraft(snap);
        if (viewing) mergeArtifacts(artifactsFromDraft(snap));
        // Match by draft id OR any streaming assistant (id can lag after reconnect)
        const patch = (m: ChatMessage): ChatMessage => {
          const isTarget =
            m.id === draft!.id ||
            (m.role === "assistant" && m.streaming) ||
            (m.role === "assistant" && !m.content && snap.content);
          if (!isTarget) return m;
          return {
            ...m,
            id: draft!.id || m.id,
            content: snap.content,
            thought: snap.thought || undefined,
            tools: snap.tools,
            plan: snap.plan,
            phase: snap.phase,
            streaming: true,
          };
        };
        if (viewing) {
          setMessages((prev) => {
            let next = prev.map(patch);
            if (!next.some((m) => m.id === draft!.id || (m.streaming && m.role === "assistant"))) {
              next = [
                ...next,
                {
                  id: draft!.id,
                  role: "assistant",
                  content: snap.content,
                  thought: snap.thought || undefined,
                  tools: snap.tools,
                  plan: snap.plan,
                  phase: snap.phase,
                  streaming: true,
                },
              ];
            }
            if (turnSid) sessionCacheRef.current.set(turnSid, next);
            return next;
          });
          scrollToBottom();
        } else if (turnSid) {
          const cached = sessionCacheRef.current.get(turnSid) || [];
          let next = cached.map(patch);
          if (!next.some((m) => m.id === draft!.id || (m.streaming && m.role === "assistant"))) {
            next = [
              ...next,
              {
                id: draft!.id,
                role: "assistant",
                content: snap.content,
                thought: snap.thought || undefined,
                tools: snap.tools,
                plan: snap.plan,
                phase: snap.phase,
                streaming: true,
              },
            ];
          }
          sessionCacheRef.current.set(turnSid, next);
        }
      },
      onPartialDraft: (info) => {
        const partial = info?.draft;
        if (!partial) return;
        const sid =
          info.sessionId || turnSessionRef.current || agentRef.current?.sessionId || null;
        if (!sid) return;
        // Only apply to live owner / viewed session
        if (turnSessionRef.current && turnSessionRef.current !== sid) {
          // still cache for background session
        }
        const id = partial.id || draftRef.current?.id || uid();
        const draft = createTurnDraft(id);
        draft.content = partial.content || "";
        draft.thought = partial.thought || "";
        draft.tools = (partial.tools as TurnDraft["tools"]) || [];
        draft.plan = (partial.plan as TurnDraft["plan"]) || [];
        draft.phase = (partial.phase as TurnDraft["phase"]) || "thinking";
        liveDraftBySessionRef.current.set(sid, draft);
        setBusy(true);
        setSessionListStatus(sid, "working");
        const viewing =
          !suppressPaintRef.current &&
          (!agentRef.current?.sessionId || agentRef.current.sessionId === sid);
        if (viewing) {
          draftRef.current = draft;
          setLiveDraft({ ...draft, tools: [...draft.tools], plan: [...draft.plan] });
          setMessages((prev) => {
            let hit = false;
            const next = prev.map((m) => {
              if (m.role === "assistant" && (m.streaming || m.id === id)) {
                hit = true;
                return {
                  ...m,
                  id,
                  content: draft.content,
                  thought: draft.thought || undefined,
                  tools: draft.tools,
                  plan: draft.plan,
                  phase: draft.phase,
                  streaming: true,
                };
              }
              return m;
            });
            if (!hit) {
              next.push({
                id,
                role: "assistant",
                content: draft.content,
                thought: draft.thought || undefined,
                tools: draft.tools,
                plan: draft.plan,
                phase: draft.phase,
                streaming: true,
              });
            }
            sessionCacheRef.current.set(sid, next);
            return next;
          });
          scrollToBottom();
        } else {
          const cached = sessionCacheRef.current.get(sid) || [];
          let hit = false;
          const next = cached.map((m) => {
            if (m.role === "assistant" && (m.streaming || m.id === id)) {
              hit = true;
              return {
                ...m,
                id,
                content: draft.content,
                thought: draft.thought || undefined,
                tools: draft.tools,
                plan: draft.plan,
                phase: draft.phase,
                streaming: true,
              };
            }
            return m;
          });
          if (!hit) {
            next.push({
              id,
              role: "assistant",
              content: draft.content,
              thought: draft.thought || undefined,
              tools: draft.tools,
              plan: draft.plan,
              phase: draft.phase,
              streaming: true,
            });
          }
          sessionCacheRef.current.set(sid, next);
        }
      },
      onTurnEnd: (info) => {
        const turnSid = info?.sessionId || turnSessionRef.current;
        const endedSid = turnSid;
        const liveOwner = turnSessionRef.current;
        const hadDraft =
          Boolean(draftRef.current) ||
          Boolean(endedSid && liveDraftBySessionRef.current.has(endedSid));
        // Dedup only when fully idle and no draft left for this session.
        // Never drop a late turn_end after a partial reconnect unlock (phone).
        if (!busyRef.current && !hadDraft && !info?.abandoned && !info?.error) {
          if (endedSid) setSessionListStatus(endedSid, null);
          return;
        }
        // Only clear busy if this end matches live owner (or abandon / no owner)
        const endsLive =
          info?.abandoned ||
          !liveOwner ||
          !endedSid ||
          endedSid === liveOwner;
        if (endsLive) {
          setBusy(false);
          setBgWorkingBanner(false);
          turnSessionRef.current = null;
        }
        if (endedSid) liveDraftBySessionRef.current.delete(endedSid);
        // Only clear observe-mode when the *ended* turn is the one we're viewing
        const viewingId = agentRef.current?.sessionId;
        const endedIsViewing = Boolean(endedSid && viewingId && endedSid === viewingId);
        if (endedIsViewing && endsLive) {
          viewOnlyRef.current = false;
          setViewOnlyBrowse(false);
          setHistoryOnly(false);
          setSessionPhase("ready");
        } else if (viewOnlyRef.current) {
          setBusy(false);
        } else if (endsLive) {
          viewOnlyRef.current = false;
          setViewOnlyBrowse(false);
        }
        // Abandon → idle (not green done). Natural finish → done if not viewing.
        if (endedSid) {
          if (info?.abandoned) setSessionListStatus(endedSid, null);
          else if (info?.error) setSessionListStatus(endedSid, "error");
          else if (endedIsViewing) setSessionListStatus(endedSid, null); // read
          else setSessionListStatus(endedSid, "done"); // green unread
        }
        const draft = draftRef.current;
        const finalizeRow = (m: ChatMessage): ChatMessage => {
          const isDraft = draft && m.id === draft.id;
          if (isDraft && draft) {
            return {
              ...m,
              streaming: false,
              content:
                draft.content ||
                m.content ||
                (info?.abandoned
                  ? "(left chat — work stopped; open this session again to continue)"
                  : draft.tools.length
                    ? ""
                    : "✓"),
              thought: draft.thought || undefined,
              tools: draft.tools,
              plan: draft.plan,
              phase: "idle",
            };
          }
          // Always clear streaming zombies (draft id mismatch after reconnect)
          if (m.streaming) return { ...m, streaming: false, phase: "idle" };
          return m;
        };
        if (draft) mergeArtifacts(artifactsFromDraft(draft));
        const stillViewing =
          !suppressPaintRef.current &&
          (!turnSid || agentRef.current?.sessionId === turnSid);
        if (stillViewing) {
          setMessages((prev) => {
            let next = prev.map(finalizeRow);
            if (draft && !next.some((m) => m.id === draft.id)) {
              next = [
                ...next,
                finalizeRow({
                  id: draft.id,
                  role: "assistant",
                  content: "",
                  streaming: true,
                }),
              ];
            }
            const cacheSid = turnSid || agentRef.current?.sessionId;
            if (cacheSid) sessionCacheRef.current.set(cacheSid, next);
            return next;
          });
          setLiveDraft(null);
          scrollToBottom();
        } else if (turnSid) {
          const cached = sessionCacheRef.current.get(turnSid) || [];
          let next = cached.map(finalizeRow);
          if (draft && !next.some((m) => m.id === draft.id)) {
            next.push(
              finalizeRow({
                id: draft.id,
                role: "assistant",
                content: "",
                streaming: true,
              }),
            );
          }
          sessionCacheRef.current.set(turnSid, next);
        } else {
          setMessages((prev) => prev.map(finalizeRow));
        }
        if (!suppressPaintRef.current) draftRef.current = null;
        else if (endsLive) draftRef.current = null;
        if (
          !suppressPaintRef.current &&
          (!turnSid || agentRef.current?.sessionId === turnSid)
        ) {
          setLiveDraft(null);
        }
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
        // Don't surface queue-related noise
        if (/already working/i.test(err)) return;
        setError(err);
        // Optimistic busy with no turn: re-check server truth
        if (busyRef.current || draftRef.current) {
          void fetchTurnTruth().then((snap) => {
            if (snap && !snap.turnActive) {
              finalizeIdleTurn({
                pullTranscript: true,
                error: true,
                reason: "error-truth",
              });
            }
          });
        }
      },
      onAgentExit: () => {
        // Server also emits turn_end; belt-and-suspenders unlock
        if (busyRef.current || draftRef.current) {
          void fetchTurnTruth().then((snap) => {
            if (!snap || !snap.turnActive) {
              finalizeIdleTurn({
                pullTranscript: true,
                error: true,
                reason: "agent_exit",
              });
            }
          });
        }
      },
    });
    return () => {
      client.disconnect();
      voiceRef.current?.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- connect once per mount
  }, [scrollToBottom, pickMessages, mergeArtifacts, focusComposer, setSessionListStatus]);

  // While Working…: dual-channel truth (WS status + HTTP /api/turn)
  useEffect(() => {
    if (!busy) return;
    const tick = () => {
      const client = clientRef.current;
      if (client?.isConnected()) {
        client.requestStatus();
      }
      // HTTP backup when WS silent or half-open
      if (!client?.isConnected() || client.lastInboundAge() > 15000) {
        void fetchTurnTruth().then((snap) => {
          if (!snap) return;
          if (!snap.turnActive && (busyRef.current || draftRef.current)) {
            // Re-use connect-time finalize via status path simulation
            clientRef.current?.requestStatus();
            // Direct HTTP finalize path
            setBusy(false);
            setBgWorkingBanner(false);
            setLiveDraft(null);
            draftRef.current = null;
            const sid = turnSessionRef.current || agentRef.current?.sessionId;
            if (sid) {
              liveDraftBySessionRef.current.delete(sid);
              setMessages((prev) => {
                const next = prev.map((m) =>
                  m.streaming ? { ...m, streaming: false, phase: "idle" } : m,
                );
                sessionCacheRef.current.set(sid, next);
                return next;
              });
              turnSessionRef.current = null;
              // Pull final transcript
              void (async () => {
                try {
                  const q = agentRef.current?.cwd
                    ? `?cwd=${encodeURIComponent(agentRef.current.cwd)}`
                    : "";
                  const resp = await fetch(
                    `/api/sessions/${encodeURIComponent(sid)}/transcript${q}`,
                  );
                  if (!resp.ok) return;
                  const data = await resp.json();
                  const disk: ChatMessage[] = (data.messages || []).map(
                    (m: {
                      id?: string;
                      role: string;
                      content: string;
                      thought?: string;
                      tools?: ChatMessage["tools"];
                      plan?: ChatMessage["plan"];
                    }) => ({
                      id: m.id || uid(),
                      role: m.role as ChatMessage["role"],
                      content: m.content || "",
                      thought: m.thought,
                      tools: m.tools,
                      plan: m.plan,
                      streaming: false,
                    }),
                  );
                  if (!disk.length) return;
                  if (agentRef.current?.sessionId !== sid) return;
                  const merged = pickMessages(sid, disk).map((m) => ({
                    ...m,
                    streaming: false,
                  }));
                  sessionCacheRef.current.set(sid, merged);
                  setMessages(merged);
                } catch {
                  /* */
                }
              })();
            }
          }
        });
      }
    };
    tick();
    const id = window.setInterval(tick, 6000);
    return () => window.clearInterval(id);
  }, [busy, pickMessages]);

  // Phone: page becomes visible — reconnect dead socket + HTTP truth first frame
  useEffect(() => {
    const onVis = (ev?: Event) => {
      if (document.visibilityState !== "visible" && !(ev as PageTransitionEvent)?.persisted) {
        // pageshow with persisted still counts
        if (ev?.type !== "pageshow") return;
      }
      const client = clientRef.current;
      if (!client?.isConnected()) {
        client?.reconnect();
      } else {
        client.requestStatus();
        client.send({ type: "ping" });
      }
      if (busyRef.current || draftRef.current) {
        void fetchTurnTruth().then((snap) => {
          if (snap && !snap.turnActive) {
            client?.requestStatus();
            // Force unlock if status path missed
            setTimeout(() => {
              if ((busyRef.current || draftRef.current) && snap && !snap.turnActive) {
                setBusy(false);
                setBgWorkingBanner(false);
                setLiveDraft(null);
                const d = draftRef.current;
                draftRef.current = null;
                const sid = turnSessionRef.current || agentRef.current?.sessionId;
                if (sid) liveDraftBySessionRef.current.delete(sid);
                turnSessionRef.current = null;
                setMessages((prev) =>
                  prev.map((m) => {
                    if (!m.streaming && !(d && m.id === d.id)) return m;
                    return {
                      ...m,
                      streaming: false,
                      content:
                        (d && m.id === d.id ? d.content || m.content : m.content) ||
                        (d?.tools?.length ? "" : m.content || "✓"),
                      thought: (d && m.id === d.id ? d.thought : m.thought) || m.thought,
                      tools: (d && m.id === d.id ? d.tools : m.tools) || m.tools,
                      plan: (d && m.id === d.id ? d.plan : m.plan) || m.plan,
                      phase: "idle",
                    };
                  }),
                );
              }
            }, 400);
          }
        });
      }
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pageshow", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pageshow", onVis);
    };
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages.length, scrollToBottom]);

  /**
   * Live transcript sync — when this session is also advanced from CLI (or
   * another client), pull disk messages so Desk stays current without re-open.
   * Skip while a Desk turn is streaming so we don't clobber liveDraft.
   */
  useEffect(() => {
    const sid = agent?.sessionId;
    if (!sid || busy || loadingSession) return;
    let cancelled = false;
    const pull = async () => {
      if (cancelled || busyRef.current || draftRef.current) return;
      const cur = agentRef.current?.sessionId;
      if (cur !== sid) return;
      try {
        const q = agentRef.current?.cwd
          ? `?cwd=${encodeURIComponent(agentRef.current.cwd)}`
          : "";
        const resp = await fetch(`/api/sessions/${encodeURIComponent(sid)}/transcript${q}`);
        if (!resp.ok || cancelled) return;
        const data = await resp.json();
        const disk: ChatMessage[] = (data.messages || []).map(
          (m: {
            id?: string;
            role: string;
            content: string;
            thought?: string;
            tools?: ChatMessage["tools"];
            plan?: ChatMessage["plan"];
          }) => ({
            id: m.id || uid(),
            role: m.role as ChatMessage["role"],
            content: m.content || "",
            thought: m.thought,
            tools: m.tools,
            plan: m.plan,
            streaming: false,
          }),
        );
        if (!disk.length || cancelled) return;
        if (agentRef.current?.sessionId !== sid) return;
        const merged = pickMessages(sid, disk).map((m) =>
          m.streaming ? { ...m, streaming: false } : m,
        );
        setMessages((prev) => {
          // Never clobber a richer in-memory transcript with a sparser disk view
          const prevAssist = [...prev].reverse().find((m) => m.role === "assistant");
          const nextAssist = [...merged].reverse().find((m) => m.role === "assistant");
          const prevLen = prevAssist?.content?.length || 0;
          const nextLen = nextAssist?.content?.length || 0;
          if (prev.length === 0 && merged.length) {
            sessionCacheRef.current.set(sid, merged);
            return merged;
          }
          if (merged.length > prev.length && nextLen >= prevLen) {
            sessionCacheRef.current.set(sid, merged);
            return merged;
          }
          if (
            prev.length === merged.length &&
            nextLen > prevLen + 40
          ) {
            sessionCacheRef.current.set(sid, merged);
            return merged;
          }
          // Prefer prev when it has more assistant body (just finalized in UI)
          return prev;
        });
        // Refresh title from summary if present
        const t = data.summary?.title;
        if (t && typeof t === "string") {
          setSessionTitles((prev) =>
            prev[sid] === t ? prev : { ...prev, [sid]: t },
          );
        }
      } catch {
        /* */
      }
    };
    void pull();
    const id = window.setInterval(() => void pull(), 3000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [agent?.sessionId, busy, loadingSession, pickMessages]);

  /**
   * Mobile/WS flap safety: while busy, poll /api/turn for partialDraft so
   * thoughts/tools/text keep painting even when WS updates are dropped.
   */
  useEffect(() => {
    if (!busy) return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled || !busyRef.current) return;
      try {
        const resp = await fetch("/api/turn");
        if (!resp.ok || cancelled) return;
        const snap = (await resp.json()) as {
          turnActive?: boolean;
          activeSessionId?: string | null;
          partialDraft?: {
            id?: string;
            content?: string;
            thought?: string;
            tools?: TurnDraft["tools"];
            plan?: TurnDraft["plan"];
            phase?: string;
            sessionId?: string;
          } | null;
        };
        if (!snap.turnActive) return;
        const partial = snap.partialDraft;
        if (!partial) return;
        const sid =
          snap.activeSessionId ||
          partial.sessionId ||
          turnSessionRef.current ||
          agentRef.current?.sessionId ||
          null;
        if (!sid) return;
        // Reuse partial_draft path via synthetic handler body
        const id = partial.id || draftRef.current?.id || uid();
        const draft = createTurnDraft(id);
        draft.content = partial.content || "";
        draft.thought = partial.thought || "";
        draft.tools = partial.tools || [];
        draft.plan = partial.plan || [];
        draft.phase = (partial.phase as TurnDraft["phase"]) || "thinking";
        // Skip if we already have equal/richer content from WS
        const cur = draftRef.current;
        if (
          cur &&
          (cur.content?.length || 0) >= (draft.content?.length || 0) &&
          (cur.thought?.length || 0) >= (draft.thought?.length || 0) &&
          (cur.tools?.length || 0) >= (draft.tools?.length || 0)
        ) {
          return;
        }
        liveDraftBySessionRef.current.set(sid, draft);
        const viewing =
          !suppressPaintRef.current &&
          (!agentRef.current?.sessionId || agentRef.current.sessionId === sid);
        if (!viewing) {
          const cached = sessionCacheRef.current.get(sid) || [];
          sessionCacheRef.current.set(
            sid,
            cached.map((m) =>
              m.streaming && m.role === "assistant"
                ? {
                    ...m,
                    id,
                    content: draft.content,
                    thought: draft.thought || undefined,
                    tools: draft.tools,
                    plan: draft.plan,
                    phase: draft.phase,
                    streaming: true,
                  }
                : m,
            ),
          );
          return;
        }
        draftRef.current = draft;
        setLiveDraft({ ...draft, tools: [...draft.tools], plan: [...draft.plan] });
        setMessages((prev) => {
          let hit = false;
          const next = prev.map((m) => {
            if (m.role === "assistant" && (m.streaming || m.id === id)) {
              hit = true;
              return {
                ...m,
                id,
                content: draft.content,
                thought: draft.thought || undefined,
                tools: draft.tools,
                plan: draft.plan,
                phase: draft.phase,
                streaming: true,
              };
            }
            return m;
          });
          if (!hit) {
            next.push({
              id,
              role: "assistant",
              content: draft.content,
              thought: draft.thought || undefined,
              tools: draft.tools,
              plan: draft.plan,
              phase: draft.phase,
              streaming: true,
            });
          }
          sessionCacheRef.current.set(sid, next);
          return next;
        });
      } catch {
        /* */
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [busy]);

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
      const sid = agentRef.current?.sessionId;
      if (sid?.startsWith("mail:")) {
        setError("Email agent threads are read-only here — reply by email to continue.");
        return;
      }
      if (
        viewOnlyRef.current &&
        turnSessionRef.current &&
        turnSessionRef.current !== agentRef.current?.sessionId
      ) {
        setError(
          "Another chat is still working in the background. Open that chat to follow it.",
        );
        return;
      }
      setInput("");
      setError(null);
      const label = text;
      const atts: { name: string; mime: string; dataBase64: string }[] = [];
      setMessages((prev) => {
        const next: ChatMessage[] = [
          ...prev,
          {
            id: uid(),
            role: "user",
            content: label,
            queued: busyRef.current && !historyOnlyRef.current,
          },
        ];
        if (sid) sessionCacheRef.current.set(sid, next);
        return next;
      });
      if (historyOnlyRef.current && !viewOnlyRef.current) {
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
        clientRef.current?.newSession(cwd);
        setSidebarTick((n) => n + 1);
        scrollToBottom();
        return;
      }
      const clientMsgId = uid();
      if (sid) {
        turnSessionRef.current = sid;
        setSessionListStatus(sid, "working");
      }
      if (!busyRef.current) setBusy(true);
      else setQueueLen((n) => n + 1);
      clientRef.current?.prompt(text, atts, { sessionId: sid, clientMsgId });
      setSidebarTick((n) => n + 1);
      scrollToBottom();
    },
    [scrollToBottom, setSessionListStatus],
  );

  const send = useCallback(() => {
    const text = input.trim();
    if (!text && attachments.length === 0) return;
    const sid = agentRef.current?.sessionId;
    // Mail sessions are read-only in Desk
    if (sid?.startsWith("mail:")) {
      setError("Email agent threads are read-only here — reply by email to continue.");
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
      setMessages([
        {
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
        },
      ]);
      setAttachments([]);
      scrollToBottom();
      return;
    }
    const hadUser = messagesRef.current.some((m) => m.role === "user");
    setMessages((prev) => {
      const next: ChatMessage[] = [
        ...prev,
        {
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
        },
      ];
      if (sid) sessionCacheRef.current.set(sid, next);
      return next;
    });
    if (sid && !hadUser && label.trim()) {
      const t = label.trim().replace(/\s+/g, " ");
      const title = t.length > 72 ? `${t.slice(0, 72)}…` : t;
      setSessionTitles((prev) => ({ ...prev, [sid]: title }));
    }
    // Browsing chat B while chat A is still working — never newSession (would abandon A)
    if (
      viewOnlyRef.current &&
      turnSessionRef.current &&
      turnSessionRef.current !== agentRef.current?.sessionId
    ) {
      setError(
        "Another chat is still working in the background. Open that chat (amber · working) to follow it, or wait until it finishes.",
      );
      // roll back the optimistic user bubble for this dead-end send
      setMessages((prev) => prev.slice(0, -1));
      setInput(text);
      return;
    }
    // Failed resume: continue in a fresh session so we never prompt the wrong ACP id
    if (historyOnlyRef.current && !viewOnlyRef.current) {
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
      clientRef.current?.newSession(cwd);
      setAttachments([]);
      setSidebarTick((n) => n + 1);
      scrollToBottom();
      return;
    }
    // Optimistic ownership — covers the gap before turn_start so switch → viewOnly works
    const clientMsgId = uid();
    if (sid) {
      turnSessionRef.current = sid;
      setSessionListStatus(sid, "working");
    }
    if (!busy) setBusy(true);
    else setQueueLen((n) => n + 1);
    clientRef.current?.prompt(text, atts, { sessionId: sid, clientMsgId });
    setAttachments([]);
    setSidebarTick((n) => n + 1);
    if (taRef.current) taRef.current.style.height = "auto";
    scrollToBottom();
  }, [input, busy, attachments, loadingSession, sessionPhase, scrollToBottom, setSessionListStatus]);

  /** Drop mid-turn UI so New / Open folder / switch session always work. */
  const resetTurnUi = useCallback(() => {
    setBusy(false);
    setLiveDraft(null);
    draftRef.current = null;
    setQueueLen(0);
  }, []);

  const stopTurn = useCallback(() => {
    if (!busy && !turnSessionRef.current) return;
    // Server stop — cancel ACP / restart agent; UI finalizes on turn_end abandoned
    clientRef.current?.stop();
    const draft = draftRef.current;
    const sid = turnSessionRef.current;
    if (draft) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === draft.id
            ? {
                ...m,
                streaming: false,
                content: draft.content || m.content || "(stopped)",
                thought: draft.thought || undefined,
                tools: draft.tools,
                plan: draft.plan,
                phase: "idle",
              }
            : m,
        ),
      );
      if (sid) {
        const cached = sessionCacheRef.current.get(sid) || [];
        sessionCacheRef.current.set(
          sid,
          cached.map((m) =>
            m.id === draft.id
              ? { ...m, streaming: false, content: draft.content || m.content || "(stopped)" }
              : m,
          ),
        );
        liveDraftBySessionRef.current.delete(sid);
      }
    }
    turnSessionRef.current = null;
    viewOnlyRef.current = false;
    setViewOnlyBrowse(false);
    resetTurnUi();
  }, [busy, resetTurnUi]);

  const newChat = useCallback(
    (cwd?: string) => {
      const prevLive = turnSessionRef.current;
      // New abandons any live turn — clear amber immediately + honest banner
      if (prevLive || busyRef.current) {
        if (prevLive) {
          setSessionListStatus(prevLive, null);
          liveDraftBySessionRef.current.delete(prevLive);
        }
        setPrevStoppedBanner(true);
        window.setTimeout(() => setPrevStoppedBanner(false), 3200);
      }
      turnSessionRef.current = null;
      suppressPaintRef.current = true; // block old stream painting into blank thread
      setBgWorkingBanner(false);
      stashSession();
      setError(null);
      setNewMenuOpen(false);
      resetTurnUi();
      setMessages([]);
      setLiveDraft(null);
      draftRef.current = null;
      // Detach agent session so late updates for A fail the viewing check
      setAgent((a) => (a ? { ...a, sessionId: null } : a));
      setSessionPhase("creating");
      setLoadingSession(true);
      setHistoryOnly(false);
      setViewOnlyBrowse(false);
      viewOnlyRef.current = false;
      const target = cwd || preferredCwdRef.current || agent?.cwd;
      if (target) preferredCwdRef.current = target;
      // Mobile: collapse sidebar + open keyboard on the same user gesture
      closeMobileSidebar();
      focusComposerRef.current = true;
      clientRef.current?.newSession(target);
      setSidebarTick((n) => n + 1);
      // Sync focus BEFORE any await — iOS won't open keyboard on delayed focus
      focusComposer({ sync: true });
    },
    [agent?.cwd, resetTurnUi, stashSession, closeMobileSidebar, focusComposer, setSessionListStatus],
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
      stashSession();
      setError(null);
      resetTurnUi();
      setMessages([]);
      setSessionPhase("creating");
      setLoadingSession(true);
      setHistoryOnly(false);
      preferredCwdRef.current = folder;
      suppressPaintRef.current = true;
      turnSessionRef.current = null;
      setAgent((a) => (a ? { ...a, sessionId: null } : a));
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
  }, [agent?.cwd, resetTurnUi, stashSession, closeMobileSidebar, focusComposer]);

  const openSession = useCallback(
    (s: SessionMeta) => {
      // Allow re-click if stuck loading the same session
      if (s.id === agent?.sessionId && !loadingSession && sessionPhase !== "loading") {
        setSessionListStatus(s.id, null);
        closeMobileSidebar();
        return;
      }
      // Opening marks read unless this session is still working in background
      const liveSid = turnSessionRef.current;
      const isLive =
        Boolean(liveSid) &&
        (busyRef.current || busy || liveDraftBySessionRef.current.has(liveSid!));
      const isBackgroundLive = Boolean(liveSid && liveSid === s.id && isLive);
      if (!isBackgroundLive) setSessionListStatus(s.id, null);
      stashSession();
      setError(null);
      // Keep live draft if reopening the session that owns the in-flight turn
      const keepLive = liveSid === s.id && isLive;
      // Another chat is working — view transcript only, do NOT kill that turn
      // Use turnSessionRef (set optimistically on send) not only React busy
      const viewOnly = Boolean(isLive && liveSid && liveSid !== s.id);
      if (!keepLive && !viewOnly) resetTurnUi();
      if (viewOnly) {
        // Stay globally "busy" for the other session's turn; this chat is history
        setLiveDraft(null);
      }
      setSessionPhase("loading");
      setLoadingSession(true);
      setHistoryOnly(false);
      const cached = sessionCacheRef.current.get(s.id);
      setMessages(cached && cached.length ? cached : []);
      if (keepLive) {
        const draft = liveDraftBySessionRef.current.get(s.id);
        if (draft) {
          draftRef.current = draft;
          setLiveDraft(draft);
        }
        setBusy(true);
      }
      if (s.cwd) preferredCwdRef.current = s.cwd;
      saveLastSession(s.id, s.cwd);
      closeMobileSidebar();
      clientRef.current?.loadSession(s.id, s.cwd, { viewOnly });
      window.setTimeout(() => {
        setLoadingSession((v) => {
          if (v) setSessionPhase((p) => (p === "loading" ? "history_only" : p));
          return false;
        });
      }, 15000);
    },
    [
      agent?.sessionId,
      loadingSession,
      sessionPhase,
      resetTurnUi,
      stashSession,
      setSessionListStatus,
      closeMobileSidebar,
      busy,
    ],
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

  const stopVoice = useCallback(() => {
    stopThinkingChime();
    voiceRef.current?.stop();
    voiceRef.current = null;
    setVoiceActive(false);
    setVoiceStatus("idle");
    setVoiceLevel(0);
    setOutLevel(0);
    playVoiceCue("stop");
  }, []);

  const startVoice = useCallback(async () => {
    if (voiceActive) {
      stopVoice();
      return;
    }
    setError(null);
    preloadVoiceCues();
    let readyCuePlayed = false;
    let endCuePlayed = false;
    const session = new GrokVoiceSession({
      onStatus: (s) => {
        setVoiceStatus(s);
        if (s === "listening" && !readyCuePlayed) {
          readyCuePlayed = true;
          playVoiceCue("start");
        }
        if (s === "thinking") startThinkingChime();
        else stopThinkingChime();
        if ((s === "ended" || s === "error") && !endCuePlayed) {
          endCuePlayed = true;
          stopThinkingChime();
          setVoiceActive(false);
        }
      },
      onLevel: setVoiceLevel,
      onOutputLevel: setOutLevel,
      onUserTranscript: (text, final) => {
        if (!final || !text.trim()) return;
        setMessages((prev) => [...prev, { id: uid(), role: "user", content: text.trim() }]);
      },
      onAssistantTranscript: (text, final) => {
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "assistant" && last.streaming) {
            return prev.map((m, i) =>
              i === prev.length - 1 ? { ...m, content: text, streaming: !final } : m,
            );
          }
          return [
            ...prev,
            { id: uid(), role: "assistant", content: text, streaming: !final },
          ];
        });
      },
      onAssistantTurnStart: () => {
        setMessages((prev) => [
          ...prev,
          { id: uid(), role: "assistant", content: "", streaming: true },
        ]);
      },
      onError: (msg) => setError(msg),
      onToolCall: async () => ({ ok: true }),
      isExternalAudioActive: () => false,
    });
    voiceRef.current = session;
    setVoiceActive(true);

    await session.start({
      getAuthHeaders: async () => ({}),
      greet: messages.length === 0,
      contextText: messages.length ? recentContext(messages) : null,
      fetchConfig: async () => {
        const resp = await fetch("/api/voice-token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contextText: messages.length ? recentContext(messages) : null,
          }),
        });
        const body = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          setVoiceActive(false);
          return {
            ok: false,
            error: body.error || "Couldn't start voice",
            errorCode: body.no_xai_key ? "no_xai_key" : undefined,
            cfg: {},
          };
        }
        return { ok: true, cfg: body };
      },
    });
  }, [voiceActive, stopVoice, messages]);

  const statusPill = useMemo(() => {
    if (!connected) return { cls: "err", label: "Daemon offline" };
    if (busy) return { cls: "warn", label: "Working…" };
    if (sessionPhase === "creating") return { cls: "warn", label: "Starting chat…" };
    if (sessionPhase === "loading") return { cls: "warn", label: "Opening…" };
    if (isMailSession) return { cls: "warn", label: "Mail · read-only" };
    if (historyOnly) return { cls: "warn", label: "History only" };
    if (agent?.ready) return { cls: "ok", label: "Ready" };
    if (agent?.agentAlive) return { cls: "warn", label: "Agent starting…" };
    return { cls: "warn", label: "Connecting…" };
  }, [connected, agent, busy, sessionPhase, historyOnly, isMailSession]);

  const projectName = useMemo(() => {
    const cwd = agent?.cwd || "";
    if (!cwd) return "";
    const parts = cwd.replace(/\/+$/, "").split("/");
    return parts[parts.length - 1] || cwd;
  }, [agent?.cwd]);

  const composerPlaceholder = useMemo(() => {
    if (isMailSession) return "Reply by email to continue";
    if (voiceActive) return "Listening… type to inject a note";
    if (busy) return "Queue a follow-up…";
    if (historyOnly) return "Send to continue in a fresh turn…";
    if (projectName && messages.length === 0) return `Ask anything about ${projectName}…`;
    return "Message Grok…";
  }, [isMailSession, voiceActive, busy, historyOnly, projectName, messages.length]);

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
    }, 20000);
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
  }, [newChat, openFolder, busy, stopTurn, permRequest]);

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
        clientRef.current?.send({ type: "stop" });
      },
      onRenameSession: (sessionId, title) => {
        void buildApi.sessionRename(sessionId, title).then(() => setSidebarTick((n) => n + 1));
      },
      onDeleteSession: (sessionId, cwd) => {
        void buildApi.sessionDelete(sessionId, cwd).then(() => setSidebarTick((n) => n + 1));
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
            <span className="brand-text">Grok Desk</span>
            <span className="sub brand-sub">local</span>
            <ModuleInfo moduleId="chat" compact />
            {projectName ? (
              <span className="project-chip" title={agent?.cwd || projectName}>
                {projectName}
              </span>
            ) : null}
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
                  onClick={() => {
                    setModeChip(m.id);
                    if (m.id === "plan") {
                      setDeskView("plan");
                      clientRef.current?.setPermissionMode("ask");
                    } else if (m.id === "yolo") {
                      clientRef.current?.setPermissionMode("always-approve");
                    } else if (m.id === "auto") {
                      clientRef.current?.setPermissionMode("auto");
                    } else {
                      clientRef.current?.setPermissionMode("ask");
                    }
                  }}
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
              {voiceConfigured ? (
                <span className="pill ok">
                  <span className="dot" />
                  voice ready
                </span>
              ) : (
                <button
                  type="button"
                  className="pill"
                  title="Add an xAI key in Settings for voice"
                  onClick={() => setSettingsOpen(true)}
                  style={{ cursor: "pointer", border: "none" }}
                >
                  <span className="dot" />
                  voice off
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
              className={`icon-btn ${copyFlash ? "primary-btn" : ""}`}
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
            <div className="new-menu-wrap">
              <button
                className="icon-btn primary-btn"
                type="button"
                onClick={() => {
                  // Mobile: dropdown is flaky (Safari) — + always starts a new chat now
                  if (isMobileViewport()) {
                    newChat();
                    return;
                  }
                  setNewMenuOpen((v) => !v);
                }}
                disabled={restarting}
                title="New chat (⌘N)"
                aria-label="New chat"
              >
                <Plus size={16} strokeWidth={2.25} />
                <span className="new-btn-label">New</span>
                <ChevronDown size={14} strokeWidth={2} className="new-btn-chevron" />
              </button>
              {newMenuOpen && !isMobileViewport() && (
                <div className="new-menu">
                  <button type="button" onClick={() => newChat()}>
                    <Plus size={15} /> New chat here
                  </button>
                  <button type="button" onClick={() => void openFolder()}>
                    <FolderOpen size={15} /> Open folder…
                  </button>
                </div>
              )}
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
        {bgWorkingBanner && !viewOnlyBrowse && turnSessionRef.current && agent?.sessionId !== turnSessionRef.current && (
          <div className="banner info" role="status">
            Grok is still working in another chat…
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
        {historyOnly && agent?.sessionId?.startsWith("mail:") && (
          <div className="banner info" role="status">
            Email agent thread (Agent Mail). Read-only here — reply by email to continue the thread.
          </div>
        )}
        {historyOnly && viewOnlyBrowse && (
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
                // Jump to live session from sidebar metadata or cache
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
        {historyOnly && !viewOnlyBrowse && !agent?.sessionId?.startsWith("mail:") && (
          <div className="banner" role="status">
            Showing saved history. Agent didn’t fully resume — send a message to continue in a fresh turn.
          </div>
        )}

        <div className="messages" ref={scrollerRef}>
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
              {!voiceConfigured && isDesktop && (
                <p className="empty-note">
                  Voice optional — add a key in{" "}
                  <button type="button" className="linkish" onClick={() => setSettingsOpen(true)}>
                    Settings
                  </button>
                  .
                </p>
              )}
            </div>
          )}
          {messages.map((m) => (
            <div key={m.id} className={`msg ${m.role}${m.queued ? " queued" : ""}`}>
              <div className="role">
                {m.role === "user" ? "you" : m.role === "assistant" ? "grok" : m.role}
                {m.streaming ? " · live" : ""}
                {m.queued ? (
                  <span className="queued-badge">queued</span>
                ) : null}
                {showTimestamps && (m as { createdAt?: string }).createdAt ? (
                  <span className="msg-ts">
                    {new Date(String((m as { createdAt?: string }).createdAt)).toLocaleTimeString()}
                  </span>
                ) : null}
              </div>
              {m.attachments && m.attachments.length > 0 && (
                <div className="msg-atts">
                  {m.attachments.map((a) =>
                    a.previewUrl ? (
                      <img key={a.id} src={a.previewUrl} alt={a.name} className="msg-att-img" />
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
                    onToolClick={(toolId) => {
                      setArtifactsOpen(true);
                      setArtifactsPinned(true);
                      // Prefer terminal id; ArtifactPane also matches file-* via list
                      setArtifactFocus(`term-${toolId}`);
                    }}
                  />
                  {m.content && !m.streaming ? (
                    <button
                      type="button"
                      className="copy-reply-btn"
                      onClick={() => void copyTextToClipboard(m.content)}
                    >
                      <Copy size={12} /> Copy
                    </button>
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
          />
        )}

        <div className="hint">
          {agent?.cwd ? projectLabel(agent.cwd) : " "}
          {agent?.sessionId ? ` · ${agent.sessionId.slice(0, 8)}` : ""}
          {busy ? " · working" : ""}
          {sessionPhase === "creating" ? " · starting chat" : ""}
          {sessionPhase === "loading" ? " · opening" : ""}
          {historyOnly ? " · history only" : ""}
          {voiceActive ? ` · voice ${voiceStatus}` : ""}
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
          <div className={`composer pill${isMailSession ? " mail-locked" : ""}`}>
          <VoiceWaveButton
            active={voiceActive}
            status={voiceStatus}
            micLevel={voiceLevel}
            outLevel={outLevel}
            size="sm"
            disabled={loadingSession || isMailSession}
            onStart={() => {
              if (!voiceConfigured) {
                setError("Enter an xAI API key in Settings to use voice mode.");
                setSettingsOpen(true);
                return;
              }
              void startVoice();
            }}
            onStop={stopVoice}
          />
          <button
            type="button"
            className="icon-btn sm"
            title="Attach files"
            disabled={loadingSession || voiceActive || isMailSession || viewOnlyBrowse}
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
            disabled={isMailSession || viewOnlyBrowse}
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
                if (voiceActive && input.trim()) {
                  voiceRef.current?.sendUserText(input.trim());
                  setMessages((prev) => [
                    ...prev,
                    { id: uid(), role: "user", content: input.trim() },
                  ]);
                  setInput("");
                  return;
                }
                send();
              }
            }}
          />
          {busy ? (
            <button type="button" className="stop-btn" onClick={stopTurn} title="Stop (Esc)">
              <Square size={12} fill="currentColor" /> Stop
            </button>
          ) : null}
          <button
            type="button"
            className="send-btn"
            onClick={send}
            disabled={
              (!input.trim() && attachments.length === 0) ||
              voiceActive ||
              viewOnlyBrowse ||
              isMailSession
            }
          >
            {busy ? "Queue" : "Send"}
          </button>
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
        onClose={() => {
          setArtifactsOpen(false);
          setArtifactsPinned(false);
        }}
        onRevealPath={revealPath}
      />
      </>
      )}

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={(vc) => {
          setSidebarTick((n) => n + 1);
          if (typeof vc === "boolean") setVoiceConfigured(vc);
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

function projectLabel(cwd: string): string {
  const parts = cwd.replace(/\/+$/, "").split("/");
  const name = parts[parts.length - 1] || cwd;
  return `${name}  ·  ${cwd}`;
}
