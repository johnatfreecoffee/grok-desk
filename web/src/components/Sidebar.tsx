import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronsDownUp,
  ChevronsUpDown,
  ChevronDown,
  ChevronRight,
  Folder,
  ListFilter,
  PanelLeftClose,
  Pin,
  Plus,
  RefreshCw,
  Settings,
} from "lucide-react";
import {
  enablePush,
  disablePush,
  getPushState,
  pushSupported,
  isSecureForPush,
} from "../lib/push";
import { ModuleInfo } from "./ModuleInfo";

export type SessionMeta = {
  id: string;
  cwd: string;
  title: string;
  updatedAt: string | null;
  createdAt: string | null;
  numMessages: number;
  model: string | null;
  agentName: string | null;
  branch?: string | null;
  /** desk | cli | agent */
  source?: string;
  sourceLabel?: string;
  projectLabel?: string;
  /** Pinned within its project folder */
  pinned?: boolean;
};

export type ProjectGroup = {
  cwd: string;
  name: string;
  key: string;
  sessionCount: number;
  shownCount: number;
  truncated: boolean;
  latestAt: string | null;
  sessions: SessionMeta[];
  collapsed: boolean;
  pinned: boolean;
  isDeskSource?: boolean;
};

export type DeskSettings = {
  pushEnabled?: boolean;
  pushNotifyOnTurnEnd?: boolean;
  maxSessionsPerProject: number;
  maxProjectsShown: number;
  showHomeSessions: boolean;
  showAllCliSessions: boolean;
  collapsedProjects: Record<string, boolean>;
  pinnedCwds: string[];
  /** sessionId → true */
  pinnedSessions?: Record<string, boolean>;
  defaultCwd: string;
  compactMode?: boolean;
  showTimestamps?: boolean;
  permissionMode?: string;
  phoneAlwaysApprove?: boolean;
};

export type SessionListStatus =
  | "working"
  | "planning"
  | "waiting"
  | "question"
  | "done"
  | "error"
  | "unread";

type Props = {
  open: boolean;
  activeSessionId: string | null;
  activeCwd: string | null;
  /** True when the active session has a turn in flight. */
  activeBusy?: boolean;
  /** Live title overrides (first user message → instant rename). */
  sessionTitles?: Record<string, string>;
  /**
   * Per-session sidebar dots — see App SessionListStatus.
   * Absent = read/idle.
   */
  sessionStatuses?: Record<string, SessionListStatus>;
  onSelectSession: (s: SessionMeta) => void;
  onNewInProject: (cwd: string) => void;
  onToggleSidebar: () => void;
  onRefreshNeeded?: number;
  onOpenSettings: () => void;
  /** Toggle unread flag (long-press / mark button). */
  onToggleUnread?: (sessionId: string) => void;
};

const STATUS_LABEL: Record<SessionListStatus, string> = {
  working: "Working",
  planning: "Planning",
  waiting: "Waiting",
  question: "Needs you",
  done: "Done (unread)",
  error: "Error",
  unread: "Unread",
};

function shortTitle(t: string | null | undefined, id: string): { text: string; isNew: boolean } {
  const s = (t || "").trim();
  if (!s || s === "New chat" || /^[0-9a-f]{8}$/i.test(s) || s === id.slice(0, 8)) {
    return { text: s || "New chat", isNew: true };
  }
  return { text: s, isNew: false };
}

function relTime(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!t) return "";
  const sec = Math.round((Date.now() - t) / 1000);
  if (sec < 60) return "now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  if (sec < 86400 * 14) return `${Math.floor(sec / 86400)}d`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

type SourceFilter = "all" | "desk" | "cli" | "mail";
type PinFilter = "all" | "pinned" | "unpinned";

export function Sidebar({
  open,
  activeSessionId,
  activeCwd,
  activeBusy = false,
  sessionTitles = {},
  sessionStatuses = {},
  onSelectSession,
  onNewInProject,
  onToggleSidebar,
  onRefreshNeeded,
  onOpenSettings,
  onToggleUnread,
}: Props) {
  const [projects, setProjects] = useState<ProjectGroup[]>([]);
  const [settings, setSettings] = useState<DeskSettings | null>(null);
  const [filter, setFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [pinFilter, setPinFilter] = useState<PinFilter>("all");
  const [sourceMenuOpen, setSourceMenuOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  /** cwd → true means collapsed (default true) */
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  /**
   * One-shot expand per active session (or cwd). Poll/project list identity
   * must not re-open a folder the user just collapsed.
   */
  const expandedForKeyRef = useRef<string | null>(null);

  const persistCollapsed = async (next: Record<string, boolean>) => {
    try {
      await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ collapsedProjects: next }),
      });
      setSettings((s) => (s ? { ...s, collapsedProjects: next } : s));
    } catch {
      /* */
    }
  };

  const togglePin = async (sessionId: string, nextPinned: boolean) => {
    const prevMap = { ...(settings?.pinnedSessions || {}) };
    if (nextPinned) prevMap[sessionId] = true;
    else delete prevMap[sessionId];
    // Optimistic UI
    setProjects((list) =>
      list.map((p) => ({
        ...p,
        sessions: p.sessions
          .map((s) => (s.id === sessionId ? { ...s, pinned: nextPinned } : s))
          .sort((a, b) => {
            const ap = a.pinned ? 1 : 0;
            const bp = b.pinned ? 1 : 0;
            if (bp !== ap) return bp - ap;
            return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
          }),
      })),
    );
    setSettings((s) => (s ? { ...s, pinnedSessions: prevMap } : s));
    try {
      await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinnedSessions: prevMap }),
      });
    } catch {
      /* */
    }
  };

  const load = async (opts: { silent?: boolean } = {}) => {
    const silent = Boolean(opts.silent);
    if (!silent) {
      setLoading(true);
      setError(null);
    }
    try {
      const resp = await fetch("/api/projects");
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "Failed to load projects");
      const list: ProjectGroup[] = data.projects || [];
      setProjects(list);
      setSettings(data.settings || null);
      // Merge expand/collapse for *new* cwds only — never thrash user toggles on poll.
      // Active project is expanded once via expand-on-select effect, not here.
      setCollapsed((prev) => {
        const map: Record<string, boolean> = { ...prev };
        const saved = (data.settings?.collapsedProjects || {}) as Record<string, boolean>;
        let changed = false;
        for (const p of list) {
          if (map[p.cwd] !== undefined) continue; // keep in-memory toggle
          if (Object.prototype.hasOwnProperty.call(saved, p.cwd)) {
            map[p.cwd] = Boolean(saved[p.cwd]);
          } else {
            map[p.cwd] = true; // default collapsed
          }
          changed = true;
        }
        return changed ? map : prev;
      });
      if (!silent) setError(null);
    } catch (e) {
      if (!silent) setError(e instanceof Error ? e.message : "load failed");
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    if (open) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload on tick/open only
  }, [open, onRefreshNeeded]);

  // Live refresh while sidebar open (CLI titles/activity without manual refresh)
  useEffect(() => {
    if (!open) return;
    const id = window.setInterval(() => {
      void load({ silent: true });
    }, 2500);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Expand the project for the active chat once when selection changes.
  // Re-runs when projects first resolve the session's cwd; never re-forces after.
  useEffect(() => {
    if (!activeCwd && !activeSessionId) return;
    const key = activeSessionId || activeCwd || "";
    if (!key || expandedForKeyRef.current === key) return;

    let cwdToExpand = activeCwd;
    if (activeSessionId && projects.length) {
      const hit = projects.find((p) => p.sessions.some((s) => s.id === activeSessionId));
      if (hit) cwdToExpand = hit.cwd;
    }
    // Wait for project list if we only have a session id and can't resolve yet
    if (!cwdToExpand) return;

    expandedForKeyRef.current = key;
    setCollapsed((prev) => {
      if (prev[cwdToExpand!] === false) return prev;
      return { ...prev, [cwdToExpand!]: false };
    });
  }, [activeCwd, activeSessionId, projects]);

  const toggle = (cwd: string) => {
    // true = collapsed; unset defaults to collapsed
    const currentlyCollapsed = collapsed[cwd] !== false;
    const newCollapsed = !currentlyCollapsed;
    // Persist every known project so reopen restores exactly
    const next: Record<string, boolean> = { ...collapsed };
    for (const p of projects) {
      if (next[p.cwd] === undefined) next[p.cwd] = true;
    }
    next[cwd] = newCollapsed;
    setCollapsed(next);
    void persistCollapsed(next);
  };

  const collapseAll = () => {
    const map: Record<string, boolean> = {};
    for (const p of projects) map[p.cwd] = true;
    setCollapsed(map);
    void persistCollapsed(map);
  };

  const expandAll = () => {
    const map: Record<string, boolean> = {};
    for (const p of projects) map[p.cwd] = false;
    setCollapsed(map);
    void persistCollapsed(map);
  };

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return projects
      .map((p) => {
        const nameHit =
          !q || p.name.toLowerCase().includes(q) || p.cwd.toLowerCase().includes(q);
        let sessions = p.sessions.filter((s) => {
          if (sourceFilter !== "all" && (s.source || "cli") !== sourceFilter) return false;
          if (pinFilter === "pinned" && !s.pinned) return false;
          if (pinFilter === "unpinned" && s.pinned) return false;
          if (!q) return true;
          if (nameHit) return true;
          return (
            s.title.toLowerCase().includes(q) ||
            s.id.toLowerCase().includes(q)
          );
        });
        // If query hits project name, still apply source + pin filters
        if (q && nameHit) {
          sessions = p.sessions.filter((s) => {
            if (sourceFilter !== "all" && (s.source || "cli") !== sourceFilter) return false;
            if (pinFilter === "pinned" && !s.pinned) return false;
            if (pinFilter === "unpinned" && s.pinned) return false;
            return true;
          });
        }
        if (!nameHit && sessions.length === 0) return null;
        // Hide empty projects when source/pin-filtering
        if ((sourceFilter !== "all" || pinFilter !== "all") && sessions.length === 0) return null;
        return { ...p, sessions, sessionCount: sessions.length };
      })
      .filter(Boolean) as ProjectGroup[];
  }, [projects, filter, sourceFilter, pinFilter]);

  if (!open) return null;

  const sourceLabel =
    sourceFilter === "all"
      ? "All sources"
      : sourceFilter === "desk"
        ? "Desk only"
        : sourceFilter === "cli"
          ? "CLI only"
          : "Mail only";
  const pinLabel =
    pinFilter === "all" ? "All pins" : pinFilter === "pinned" ? "Pinned only" : "Unpinned only";
  const filterActive = sourceFilter !== "all" || pinFilter !== "all";

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        {/* Title removed — was crowding the action cluster under traffic lights */}
        <div className="sidebar-head-spacer" aria-hidden />
        <div className="sidebar-head-actions">
          <ModuleInfo moduleId="sidebar" compact />
          <button
            type="button"
            className="icon-btn sm"
            onClick={expandAll}
            title="Expand all folders"
          >
            <ChevronsUpDown size={16} strokeWidth={2} />
          </button>
          <button
            type="button"
            className="icon-btn sm"
            onClick={collapseAll}
            title="Collapse all folders"
          >
            <ChevronsDownUp size={16} strokeWidth={2} />
          </button>
          <button type="button" className="icon-btn sm" onClick={() => void load()} title="Refresh">
            <RefreshCw size={16} strokeWidth={2} />
          </button>
          <button type="button" className="icon-btn sm" onClick={onOpenSettings} title="Settings">
            <Settings size={16} strokeWidth={2} />
          </button>
        </div>
      </div>

      <div className="sidebar-search-row">
        <button
          type="button"
          className="icon-btn sm"
          onClick={onToggleSidebar}
          title="Hide sidebar"
        >
          <PanelLeftClose size={18} strokeWidth={2} />
        </button>
        <div className="sidebar-search">
          <input
            type="search"
            placeholder="Filter projects & sessions…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        <div className="source-filter-wrap">
          <button
            type="button"
            className={`icon-btn sm${filterActive ? " primary-btn" : ""}`}
            title={`Filter · ${sourceLabel} · ${pinLabel}`}
            onClick={() => setSourceMenuOpen((v) => !v)}
          >
            <ListFilter size={16} strokeWidth={2} />
          </button>
          {sourceMenuOpen && (
            <div className="source-filter-menu" role="menu">
              <div className="source-filter-section">Source</div>
              {(
                [
                  ["all", "All sources"],
                  ["desk", "Desk"],
                  ["cli", "CLI"],
                  ["mail", "Mail"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={sourceFilter === id ? "active" : ""}
                  onClick={() => {
                    setSourceFilter(id);
                  }}
                >
                  {label}
                </button>
              ))}
              <div className="source-filter-section">Pinned</div>
              {(
                [
                  ["all", "All chats"],
                  ["pinned", "Pinned only"],
                  ["unpinned", "Unpinned only"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={`pin-${id}`}
                  type="button"
                  className={pinFilter === id ? "active" : ""}
                  onClick={() => {
                    setPinFilter(id);
                  }}
                >
                  {label}
                </button>
              ))}
              <button
                type="button"
                className="source-filter-done"
                onClick={() => setSourceMenuOpen(false)}
              >
                Done
              </button>
            </div>
          )}
        </div>
      </div>

      {filterActive && (
        <div className="source-filter-bar">
          {sourceFilter !== "all" && (
            <span
              className={`src-chip src-${sourceFilter === "desk" ? "desk" : sourceFilter === "mail" ? "mail" : "cli"}`}
            >
              {sourceLabel}
            </span>
          )}
          {pinFilter !== "all" && (
            <span className="src-chip src-pin">{pinLabel}</span>
          )}
          <button
            type="button"
            className="linkish"
            onClick={() => {
              setSourceFilter("all");
              setPinFilter("all");
            }}
          >
            Clear
          </button>
        </div>
      )}

      {error && <div className="sidebar-error">{error}</div>}
      {loading && projects.length === 0 && <div className="sidebar-muted">Loading…</div>}

      <div className="sidebar-list">
        {filtered.map((p) => {
          // true = collapsed; default collapsed when unset
          const isCollapsed = collapsed[p.cwd] !== false;
          const expanded = !isCollapsed;

          return (
            <div
              key={p.cwd}
              className={`proj ${p.cwd === activeCwd ? "active-proj" : ""}${expanded ? " expanded" : " collapsed"}${p.isDeskSource ? " desk-src" : ""}`}
            >
              <div className="proj-row">
                <button type="button" className="proj-toggle" onClick={() => void toggle(p.cwd)}>
                  <span className="chev">
                    {isCollapsed ? (
                      <ChevronRight size={14} strokeWidth={2.25} />
                    ) : (
                      <ChevronDown size={14} strokeWidth={2.25} />
                    )}
                  </span>
                  <Folder size={14} strokeWidth={2.25} className="proj-folder-icon" aria-hidden />
                  <span className="proj-name" title={p.cwd}>
                    {p.name}
                  </span>
                  {p.isDeskSource && (
                    <span className="src-chip src-desk" title="This app's source">
                      app
                    </span>
                  )}
                  <span className="proj-count" title={`${p.sessionCount} chats`}>
                    {p.sessionCount}
                  </span>
                </button>
                <button
                  type="button"
                  className="icon-btn sm"
                  title={`New chat in ${p.name}`}
                  onClick={() => onNewInProject(p.cwd)}
                >
                  <Plus size={16} strokeWidth={2.25} />
                </button>
              </div>
              {expanded && (
                <div className="sess-list">
                  {p.sessions.map((s) => {
                    const isActive = s.id === activeSessionId;
                    const mapped = sessionStatuses[s.id];
                    // Live busy wins for the active chat
                    const status: SessionListStatus | null =
                      isActive && activeBusy
                        ? mapped && mapped !== "done" && mapped !== "unread" && mapped !== "error"
                          ? mapped
                          : "working"
                        : mapped || null;
                    const { text: title, isNew } = shortTitle(
                      sessionTitles[s.id] || s.title,
                      s.id,
                    );
                    const src = s.source || "cli";
                    const srcTitle =
                      src === "mail"
                        ? "Started from email (Agent Mail)"
                        : src === "desk"
                          ? "Started in Grok Desk"
                          : "Grok CLI / TUI";
                    const when = status
                      ? STATUS_LABEL[status].toLowerCase()
                      : relTime(s.updatedAt) || (isNew ? "just now" : "");
                    const statusHint = status ? ` · ${STATUS_LABEL[status]}` : "";
                    const isPinned = Boolean(s.pinned);
                    return (
                      <div
                        key={s.id}
                        className={[
                          "sess-row",
                          isActive ? "active" : "",
                          status ? `st-${status}` : "",
                          status === "working" || status === "planning" ? "live" : "",
                          status === "done" || status === "unread" ? "unread" : "",
                          src === "mail" ? "mail" : "",
                          isNew ? "is-new" : "",
                          isPinned ? "pinned" : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        data-status={status || "idle"}
                      >
                        <button
                          type="button"
                          className="sess-row-main"
                          onClick={() => onSelectSession(s)}
                          onContextMenu={(e) => {
                            if (!onToggleUnread) return;
                            e.preventDefault();
                            onToggleUnread(s.id);
                          }}
                          onTouchStart={(e) => {
                            if (!onToggleUnread) return;
                            const target = e.currentTarget;
                            const timer = window.setTimeout(() => {
                              onToggleUnread(s.id);
                              target.dataset.longPressed = "1";
                            }, 480);
                            const clear = () => {
                              window.clearTimeout(timer);
                              target.removeEventListener("touchend", clear);
                              target.removeEventListener("touchmove", clear);
                            };
                            target.addEventListener("touchend", clear, { once: true });
                            target.addEventListener("touchmove", clear, { once: true });
                          }}
                          title={`${title}\n${srcTitle}\n${s.id}${statusHint}${isPinned ? " · Pinned" : ""}\n\nPin to keep at top of folder · Long-press ○ unread`}
                          aria-current={isActive ? "true" : undefined}
                        >
                          <span className="sess-title">
                            {isPinned ? (
                              <Pin size={11} strokeWidth={2.5} className="sess-pin-icon" aria-hidden />
                            ) : null}
                            {status ? (
                              <span
                                className={`sess-status-dot sess-dot-${status}`}
                                aria-hidden
                                title={STATUS_LABEL[status]}
                              />
                            ) : null}
                            {title}
                          </span>
                          <span className="sess-meta">
                            {when ? (
                              <span className={status ? `sess-meta-${status}` : undefined}>
                                {when}
                              </span>
                            ) : null}
                            <span className={`src-chip src-${src}`} title={srcTitle}>
                              {s.sourceLabel ||
                                (src === "mail" ? "Mail" : src === "desk" ? "Desk" : "CLI")}
                            </span>
                          </span>
                        </button>
                        <button
                          type="button"
                          className={`sess-pin-btn${isPinned ? " on" : ""}`}
                          title={isPinned ? "Unpin" : "Pin to top of folder"}
                          aria-label={isPinned ? "Unpin session" : "Pin session"}
                          aria-pressed={isPinned}
                          onClick={(e) => {
                            e.stopPropagation();
                            void togglePin(s.id, !isPinned);
                          }}
                        >
                          <Pin size={12} strokeWidth={2.25} />
                        </button>
                        {onToggleUnread ? (
                          <button
                            type="button"
                            className="sess-mark-btn"
                            title={
                              status === "done" || status === "unread"
                                ? "Mark read"
                                : "Mark unread"
                            }
                            aria-label="Toggle read/unread"
                            onClick={(e) => {
                              e.stopPropagation();
                              onToggleUnread(s.id);
                            }}
                          >
                            {status === "done" || status === "unread" ? "●" : "○"}
                          </button>
                        ) : null}
                      </div>
                    );
                  })}
                  {p.sessions.length === 0 && (
                    <div className="sidebar-muted tiny">No chats yet — hit +</div>
                  )}
                  {p.truncated && (
                    <div className="sidebar-muted tiny">
                      Showing {p.shownCount}
                      {settings?.showAllCliSessions ? " (CLI history on)" : ""}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {!loading && filtered.length === 0 && (
          <div className="sidebar-muted">
            No projects yet.
            <br />
            Use <strong>New → Open folder…</strong> to start in a directory.
            <br />
            <span style={{ opacity: 0.8 }}>
              Or hit <strong>+</strong> on a project row for a new chat.
            </span>
          </div>
        )}
      </div>
    </aside>
  );
}

type SettingsProps = {
  open: boolean;
  onClose: () => void;
  onSaved: (voiceConfigured?: boolean) => void;
};

export function SettingsModal({ open, onClose, onSaved }: SettingsProps) {
  const [settings, setSettings] = useState<DeskSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [voiceConfigured, setVoiceConfigured] = useState(false);
  const [voiceKeyMasked, setVoiceKeyMasked] = useState<string | null>(null);
  const [xaiKeyDraft, setXaiKeyDraft] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushMsg, setPushMsg] = useState<string | null>(null);
  const [pushState, setPushState] = useState<{
    supported: boolean;
    secure: boolean;
    permission: string;
    subscribed: boolean;
  } | null>(null);
  const [pushServerCount, setPushServerCount] = useState(0);

  useEffect(() => {
    if (!open) return;
    setXaiKeyDraft("");
    setClearKey(false);
    setPushMsg(null);
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => {
        setSettings(d.settings);
        setVoiceConfigured(Boolean(d.voiceConfigured));
        setVoiceKeyMasked(d.voiceKeyMasked || null);
      })
      .catch(() => setSettings(null));
    void getPushState().then(setPushState);
    fetch("/api/push/status")
      .then((r) => r.json())
      .then((d) => setPushServerCount(Number(d.subscriberCount) || 0))
      .catch(() => setPushServerCount(0));
  }, [open]);

  if (!open || !settings) return null;

  const togglePhonePush = async (on: boolean) => {
    setPushBusy(true);
    setPushMsg(null);
    try {
      if (on) {
        const r = await enablePush();
        if (!r.ok) {
          setPushMsg(r.error || "Could not enable push");
          return;
        }
        setSettings({ ...settings, pushEnabled: true });
        setPushMsg("Push on — you'll get alerts when turns finish.");
      } else {
        await disablePush();
        setSettings({ ...settings, pushEnabled: false });
        setPushMsg("Push off on this device.");
      }
      setPushState(await getPushState());
      const st = await fetch("/api/push/status").then((r) => r.json()).catch(() => ({}));
      setPushServerCount(Number(st.subscriberCount) || 0);
    } finally {
      setPushBusy(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const body: Record<string, unknown> = { ...settings };
      if (clearKey) body.clearXaiApiKey = true;
      else if (xaiKeyDraft.trim()) body.xaiApiKey = xaiKeyDraft.trim();
      const resp = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || "Save failed");
      setVoiceConfigured(Boolean(data.voiceConfigured));
      setVoiceKeyMasked(data.voiceKeyMasked || null);
      setXaiKeyDraft("");
      setClearKey(false);
      onSaved(Boolean(data.voiceConfigured));
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-title-row">
          <h2>Settings</h2>
          <ModuleInfo moduleId="settings" compact />
        </div>

        <div className="settings-section">
          <div className="settings-section-title">Voice</div>
          {!voiceConfigured && !xaiKeyDraft.trim() && !clearKey && (
            <p className="settings-callout">
              Enter an xAI API key to use voice mode. Text chat works without a key.
            </p>
          )}
          {voiceConfigured && !clearKey && (
            <p className="settings-ok">
              Key on file{voiceKeyMasked ? `: ${voiceKeyMasked}` : ""}. Paste a new one to replace.
            </p>
          )}
          <label className="field">
            <span>xAI API key</span>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={
                voiceConfigured && !clearKey
                  ? "Paste new key to replace…"
                  : "xai-… paste from console.x.ai"
              }
              value={clearKey ? "" : xaiKeyDraft}
              disabled={clearKey}
              onChange={(e) => {
                setClearKey(false);
                setXaiKeyDraft(e.target.value);
              }}
            />
          </label>
          {voiceConfigured && (
            <label className="field check">
              <input
                type="checkbox"
                checked={clearKey}
                onChange={(e) => {
                  setClearKey(e.target.checked);
                  if (e.target.checked) setXaiKeyDraft("");
                }}
              />
              <span>Remove key (disable voice)</span>
            </label>
          )}
          <p className="modal-hint">
            Only used when you start voice. Get a key at{" "}
            <a href="https://console.x.ai" target="_blank" rel="noreferrer">
              console.x.ai
            </a>
            . Stored locally in this app — not for text chat.
          </p>
        </div>

        <div className="settings-section">
          <div className="settings-section-title">Phone push</div>
          {!pushSupported() ? (
            <p className="modal-hint">
              Push is for the phone/browser PWA (Add to Home Screen). Desktop app uses the Mac
              directly.
            </p>
          ) : (
            <>
              {!isSecureForPush() && (
                <p className="settings-callout">
                  Need HTTPS for push. On the Mac run{" "}
                  <code>./scripts/phone-serve.sh</code> and open the{" "}
                  <strong>https://</strong> URL, then reinstall the home-screen app.
                </p>
              )}
              <p className="modal-hint">
                Status:{" "}
                {pushState?.subscribed
                  ? "this device subscribed"
                  : pushState?.permission === "denied"
                    ? "blocked in system settings"
                    : "not subscribed"}
                {pushServerCount > 0 ? ` · ${pushServerCount} device(s) on Mac` : ""}
              </p>
              <label className="field check">
                <input
                  type="checkbox"
                  checked={Boolean(pushState?.subscribed) && settings.pushEnabled !== false}
                  disabled={pushBusy || !isSecureForPush()}
                  onChange={(e) => void togglePhonePush(e.target.checked)}
                />
                <span>Push notifications on this device</span>
              </label>
              <label className="field check">
                <input
                  type="checkbox"
                  checked={settings.pushNotifyOnTurnEnd !== false}
                  onChange={(e) =>
                    setSettings({ ...settings, pushNotifyOnTurnEnd: e.target.checked })
                  }
                />
                <span>Notify when a turn finishes</span>
              </label>
              <label className="field check">
                <input
                  type="checkbox"
                  checked={settings.pushEnabled !== false}
                  onChange={(e) => setSettings({ ...settings, pushEnabled: e.target.checked })}
                />
                <span>Allow Mac to send push (master)</span>
              </label>
              {pushMsg && <p className="settings-ok">{pushMsg}</p>}
              <p className="modal-hint">
                iPhone: iOS 16.4+, installed to Home Screen, Tailscale on. Alerts work even if the
                PWA is closed; opening chat still needs Mac + Tailscale.
              </p>
            </>
          )}
        </div>

        <div className="settings-section">
          <div className="settings-section-title">Sessions</div>
          <label className="field">
            <span>Max sessions per project</span>
            <input
              type="number"
              min={5}
              max={200}
              value={settings.maxSessionsPerProject}
              onChange={(e) =>
                setSettings({ ...settings, maxSessionsPerProject: Number(e.target.value) || 40 })
              }
            />
          </label>
          <label className="field">
            <span>Max projects shown</span>
            <input
              type="number"
              min={5}
              max={200}
              value={settings.maxProjectsShown}
              onChange={(e) =>
                setSettings({ ...settings, maxProjectsShown: Number(e.target.value) || 80 })
              }
            />
          </label>
          <label className="field check">
            <input
              type="checkbox"
              checked={Boolean(settings.showAllCliSessions)}
              onChange={(e) => setSettings({ ...settings, showAllCliSessions: e.target.checked })}
            />
            <span>Show all Grok CLI history</span>
          </label>
          <label className="field check">
            <input
              type="checkbox"
              checked={settings.showHomeSessions}
              onChange={(e) => setSettings({ ...settings, showHomeSessions: e.target.checked })}
            />
            <span>Include home-directory sessions</span>
          </label>
        </div>

        <div className="settings-section">
          <div className="settings-section-title">Display</div>
          <label className="field check">
            <input
              type="checkbox"
              checked={Boolean(settings.compactMode)}
              onChange={(e) => setSettings({ ...settings, compactMode: e.target.checked })}
            />
            <span>Compact mode (tighter chrome)</span>
          </label>
          <label className="field check">
            <input
              type="checkbox"
              checked={Boolean(settings.showTimestamps)}
              onChange={(e) => setSettings({ ...settings, showTimestamps: e.target.checked })}
            />
            <span>Show message timestamps</span>
          </label>
        </div>

        <div className="settings-section">
          <div className="settings-section-title">Privacy</div>
          <p className="modal-hint">
            Grok Desk is local-only (daemon on 127.0.0.1). Chat text goes through the Grok CLI /
            xAI agent process using your CLI login. Voice uses an optional xAI API key stored in Desk
            Application Support. No Desk cloud backend. Session files live under{" "}
            <code>~/.grok/sessions</code>.
          </p>
          <p className="modal-hint">
            Clear history by deleting sessions in Agents or via filesystem. Feedback (/feedback)
            goes through the agent to xAI when you send it.
          </p>
        </div>

        <div className="modal-actions">
          <button type="button" className="icon-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="send-btn" onClick={() => void save()} disabled={saving}>
            {saving ? "…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
