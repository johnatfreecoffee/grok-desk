import { useCallback, useEffect, useState } from "react";
import {
  buildApi,
  type AgentDef,
  type HookInfo,
  type MarketPlugin,
  type MemoryBank,
  type McpServer,
  type ModelInfo,
  type PersonaDef,
  type PluginInfo,
  type RadarSnapshot,
  type SkillInfo,
  type SubagentInfo,
} from "../lib/buildClient";
import {
  Brain,
  Check,
  FolderGit2,
  Gauge,
  GitBranch,
  Image,
  Loader2,
  Play,
  RefreshCw,
  Sparkles,
  Network,
  Boxes,
  Radar as RadarIcon,
  LayoutDashboard,
  Workflow,
  FolderTree,
  Store,
  Stethoscope,
  Webhook,
  Mail,
  Users,
  Plus,
  Trash2,
} from "lucide-react";
import { ModuleInfo } from "../components/ModuleInfo";

type SessionRow = {
  id: string;
  title?: string | null;
  cwd?: string | null;
  updatedAt?: string | null;
  projectName?: string;
  status?: string | null;
};

type LiveAgent = {
  workerId: string;
  sessionId: string | null;
  cwd: string | null;
  busy: boolean;
  agentAlive?: boolean;
  isDefault?: boolean;
};

type CommonProps = {
  cwd?: string | null;
  sessions?: SessionRow[];
  activeSessionId?: string | null;
  busy?: boolean;
  onOpenSession?: (id: string, cwd: string) => void;
  onNewChat?: () => void;
  onDispatch?: (text?: string) => void;
  onOpenSettings?: () => void;
  onInvokeSkill?: (name: string) => void;
  onPromptSlash?: (cmd: string) => void;
  onStopAgent?: () => void;
  onRenameSession?: (sessionId: string, title: string) => void;
  onDeleteSession?: (sessionId: string, cwd: string) => void;
  liveTasks?: { id: string; title: string; status: string; kind: string }[];
  liveAgents?: LiveAgent[];
  liveSessionIds?: string[];
  poolInfo?: { maxWorkers?: number; workerCount?: number; busyCount?: number } | null;
};

function Panel({
  title,
  icon,
  children,
  actions,
  helpId,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  actions?: React.ReactNode;
  /** MODULE_HELP key — shows Info button + help modal */
  helpId?: string;
}) {
  return (
    <div className="build-view">
      <header className="build-view-head">
        <div className="build-view-title">
          {icon}
          <h1>{title}</h1>
          {helpId ? <ModuleInfo moduleId={helpId} compact /> : null}
        </div>
        {actions ? <div className="build-view-actions">{actions}</div> : null}
      </header>
      <div className="build-view-body">{children}</div>
    </div>
  );
}

function relTime(iso?: string | null) {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function HomeDashboard({
  sessions: propSessions,
  activeSessionId,
  busy,
  onOpenSession,
  onNewChat,
  onDispatch,
  onStopAgent,
  onRenameSession,
  onDeleteSession,
  sessionStatuses,
  liveAgents = [],
  liveSessionIds = [],
  poolInfo,
}: CommonProps & { sessionStatuses?: Record<string, string> }) {
  const [fetched, setFetched] = useState<SessionRow[]>([]);
  const [dispatchText, setDispatchText] = useState("");
  const [poolLive, setPoolLive] = useState<LiveAgent[]>(liveAgents);
  const [peek, setPeek] = useState<SessionRow | LiveAgent | null>(null);
  const [peekInfo, setPeekInfo] = useState<string>("");
  const [renameDraft, setRenameDraft] = useState("");

  useEffect(() => {
    setPoolLive(liveAgents);
  }, [liveAgents]);

  useEffect(() => {
    if (propSessions && propSessions.length) return;
    void fetch("/api/projects")
      .then((r) => r.json())
      .then((data) => {
        const rows: SessionRow[] = [];
        for (const p of data.projects || []) {
          for (const s of p.sessions || []) {
            rows.push({
              id: s.id,
              title: s.title,
              cwd: p.cwd,
              updatedAt: s.updatedAt || s.lastInteractionAt || s.mtime,
              projectName: p.name || p.cwd?.split("/").pop(),
            });
          }
        }
        rows.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
        setFetched(rows);
      })
      .catch(() => setFetched([]));
  }, [propSessions]);

  useEffect(() => {
    const tick = () => {
      void fetch("/api/agents")
        .then((r) => r.json())
        .then((d) => {
          if (Array.isArray(d.workers)) setPoolLive(d.workers);
        })
        .catch(() => {});
    };
    tick();
    const t = window.setInterval(tick, 3000);
    return () => window.clearInterval(t);
  }, []);

  const rows = (propSessions && propSessions.length ? propSessions : fetched).slice(0, 48);
  const liveSet = new Set(liveSessionIds);
  for (const a of poolLive) {
    if (a.busy && a.sessionId) liveSet.add(a.sessionId);
  }

  useEffect(() => {
    if (!peek) {
      setPeekInfo("");
      return;
    }
    const sid = "id" in peek ? peek.id : peek.sessionId;
    const pcwd = "cwd" in peek ? peek.cwd : null;
    if (!sid) return;
    void buildApi
      .sessionInfo(sid, pcwd)
      .then((r) => {
        setPeekInfo(
          [r.title, r.model, r.nextTraceTurn != null ? `${r.nextTraceTurn} turns` : null, r.headBranch]
            .filter(Boolean)
            .join(" · "),
        );
        setRenameDraft(String(r.title || sid.slice(0, 8)));
      })
      .catch(() => setPeekInfo(""));
  }, [peek]);

  return (
    <Panel
      title="Agents"
      helpId="home"
      icon={<LayoutDashboard size={20} strokeWidth={2} />}
      actions={
        <>
          <span className="pill ok" title="Worker pool">
            <span className="dot" />
            {poolInfo?.busyCount ?? poolLive.filter((w) => w.busy).length}/
            {poolInfo?.maxWorkers ?? 4} busy
          </span>
          <button
            type="button"
            className="icon-btn primary-btn"
            onClick={() => {
              if (onDispatch) onDispatch(dispatchText.trim() || undefined);
              else onNewChat?.();
            }}
          >
            Dispatch
          </button>
        </>
      }
    >
      <p className="build-lede">
        Multi-agent pool — up to {poolInfo?.maxWorkers ?? 4} parallel Grok workers. Dispatch while another chat
        runs without killing it. Click a card once to peek; Open to attach.
      </p>
      {peek ? (
        <div className="agent-peek">
          <div className="agent-peek-head">
            <strong>
              {"workerId" in peek ? peek.workerId : (peek as SessionRow).title || (peek as SessionRow).id?.slice(0, 8)}
            </strong>
            <button type="button" className="icon-btn sm" onClick={() => setPeek(null)}>
              Close peek
            </button>
          </div>
          <div className="build-muted" style={{ fontSize: 12 }}>
            {peekInfo || ("cwd" in peek ? peek.cwd : "")}
          </div>
          <div className="agent-peek-actions">
            <input
              className="build-search"
              style={{ marginBottom: 0, flex: 1, maxWidth: 220, fontSize: 13, padding: "6px 10px" }}
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              placeholder="Rename"
            />
            <button
              type="button"
              className="icon-btn sm"
              onClick={() => {
                const sid = "id" in peek ? peek.id : peek.sessionId;
                if (sid && renameDraft.trim()) onRenameSession?.(sid, renameDraft.trim());
              }}
            >
              Rename
            </button>
            <button
              type="button"
              className="icon-btn sm primary-btn"
              onClick={() => {
                const sid = "id" in peek ? peek.id : peek.sessionId;
                const pcwd = ("cwd" in peek ? peek.cwd : null) || "";
                if (sid && pcwd) onOpenSession?.(sid, pcwd);
              }}
            >
              Open
            </button>
            {"busy" in peek && peek.busy ? (
              <button type="button" className="icon-btn sm danger-btn" onClick={() => onStopAgent?.()}>
                Stop
              </button>
            ) : null}
            <button
              type="button"
              className="icon-btn sm danger-btn"
              onClick={() => {
                const sid = "id" in peek ? peek.id : peek.sessionId;
                const pcwd = ("cwd" in peek ? peek.cwd : null) || "";
                if (sid && pcwd && confirm("Delete this session from disk?")) {
                  onDeleteSession?.(sid, pcwd);
                  setPeek(null);
                }
              }}
            >
              Delete
            </button>
          </div>
        </div>
      ) : null}
      <div className="dispatch-bar">
        <input
          className="build-search"
          style={{ marginBottom: 0, flex: 1, maxWidth: "none" }}
          placeholder="Optional first prompt for new agent…"
          value={dispatchText}
          onChange={(e) => setDispatchText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onDispatch?.(dispatchText.trim() || undefined);
              setDispatchText("");
            }
          }}
        />
        <button
          type="button"
          className="icon-btn primary-btn"
          onClick={() => {
            onDispatch?.(dispatchText.trim() || undefined);
            setDispatchText("");
          }}
        >
          Go
        </button>
      </div>

      <h3 className="build-h3">Live workers ({poolLive.length})</h3>
      <div className="agent-cards" style={{ marginBottom: 16 }}>
        {poolLive.length === 0 ? (
          <div className="build-empty" style={{ padding: 16 }}>
            No workers yet
          </div>
        ) : (
          poolLive.map((w) => {
            const st = w.busy ? "working" : w.sessionId ? "idle" : "idle";
            return (
              <button
                key={w.workerId}
                type="button"
                className={`agent-card st-${st} ${w.sessionId === activeSessionId ? "active" : ""}`}
                onClick={() => setPeek(w)}
                onDoubleClick={() => w.sessionId && w.cwd && onOpenSession?.(w.sessionId, w.cwd)}
              >
                <div className="agent-card-top">
                  <span className={`agent-dot st-${st}`} />
                  <span className="agent-title">
                    {w.workerId}
                    {w.isDefault ? " · primary" : ""}
                  </span>
                  <span className="agent-time">{w.busy ? "live" : "idle"}</span>
                </div>
                <div className="agent-meta">
                  <span>{w.cwd?.split("/").pop() || "—"}</span>
                  <span className="agent-state">{w.sessionId ? w.sessionId.slice(0, 8) : "empty"}</span>
                </div>
              </button>
            );
          })
        )}
      </div>

      <h3 className="build-h3">Sessions</h3>
      <div className="agent-cards">
        {rows.length === 0 ? (
          <div className="build-empty">No sessions yet. Dispatch a new chat.</div>
        ) : (
          rows.map((s) => {
            const active = s.id === activeSessionId;
            const st =
              (liveSet.has(s.id) ? "working" : null) ||
              (active && busy ? "working" : null) ||
              sessionStatuses?.[s.id] ||
              s.status ||
              "idle";
            return (
              <button
                key={s.id}
                type="button"
                className={`agent-card st-${st} ${active ? "active" : ""}`}
                onClick={() => setPeek(s)}
                onDoubleClick={() => s.cwd && onOpenSession?.(s.id, s.cwd)}
              >
                <div className="agent-card-top">
                  <span className={`agent-dot st-${st}`} />
                  <span className="agent-title">{s.title || s.id.slice(0, 8)}</span>
                  <span className="agent-time">{relTime(s.updatedAt)}</span>
                </div>
                <div className="agent-meta">
                  <span>{s.projectName || s.cwd?.split("/").pop() || "—"}</span>
                  <span className="agent-state">{st}</span>
                </div>
              </button>
            );
          })
        )}
      </div>
    </Panel>
  );
}

export function TasksMapView({ liveTasks = [], busy, activeSessionId, cwd }: CommonProps) {
  const [subs, setSubs] = useState<SubagentInfo[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    if (!activeSessionId) {
      setSubs([]);
      return;
    }
    setLoading(true);
    void buildApi
      .subagents(activeSessionId, cwd)
      .then((r) => setSubs(r.subagents || []))
      .catch(() => setSubs([]))
      .finally(() => setLoading(false));
  }, [activeSessionId, cwd]);

  useEffect(() => {
    load();
    if (!busy) return;
    const t = window.setInterval(load, 4000);
    return () => window.clearInterval(t);
  }, [load, busy]);

  return (
    <Panel
      title="Tasks map"
      helpId="tasks"
      icon={<Workflow size={20} strokeWidth={2} />}
      actions={
        <button type="button" className="icon-btn" onClick={load} title="Refresh">
          <RefreshCw size={14} />
        </button>
      }
    >
      <p className="build-lede">
        Live tool stream + persisted subagents for this session (disk meta under subagents/).
      </p>
      <h3 className="build-h3">Live tools</h3>
      {liveTasks.length === 0 ? (
        <div className="build-empty" style={{ padding: "16px" }}>
          {busy ? "Turn running — tools appear as they spawn…" : "No live tools right now."}
        </div>
      ) : (
        <div className="task-tree">
          {liveTasks.map((t) => (
            <div key={t.id} className={`task-node st-${t.status}`}>
              <span className={`agent-dot st-${t.status}`} />
              <div>
                <div className="task-title">{t.title}</div>
                <div className="task-kind">
                  {t.kind} · {t.status}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      <h3 className="build-h3">Subagents (session)</h3>
      {!activeSessionId ? (
        <div className="build-empty" style={{ padding: "16px" }}>
          Open a chat to see its child agents.
        </div>
      ) : loading && subs.length === 0 ? (
        <div className="build-empty" style={{ padding: "16px" }}>
          <Loader2 className="spin" size={16} /> Loading…
        </div>
      ) : subs.length === 0 ? (
        <div className="build-empty" style={{ padding: "16px" }}>
          No subagents recorded for this session yet.
        </div>
      ) : (
        <div className="task-tree">
          {subs.map((s) => (
            <div key={s.id} className={`task-node st-${s.status}`}>
              <span className={`agent-dot st-${s.status === "completed" ? "done" : s.status === "running" ? "working" : s.status}`} />
              <div>
                <div className="task-title">{s.description || s.id.slice(0, 10)}</div>
                <div className="task-kind">
                  {s.type} · {s.status}
                  {s.durationMs != null ? ` · ${Math.round(s.durationMs / 1000)}s` : ""}
                  {s.toolCalls != null ? ` · ${s.toolCalls} tools` : ""}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

export function SkillsStudio({ cwd, onInvokeSkill }: CommonProps) {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: "", description: "", body: "" });

  const load = useCallback(() => {
    setLoading(true);
    void buildApi
      .skills(cwd)
      .then((r) => setSkills(r.skills || []))
      .catch(() => setSkills([]))
      .finally(() => setLoading(false));
  }, [cwd]);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = skills.filter((s) => {
    const h = `${s.name} ${s.description} ${s.scope}`.toLowerCase();
    return !q.trim() || h.includes(q.trim().toLowerCase());
  });

  const toggle = async (s: SkillInfo) => {
    if (s.scope === "bundled") return;
    const enable = s.enabled === false;
    setBusy(s.id);
    setErr(null);
    try {
      await buildApi.skillAction({
        action: enable ? "enable" : "disable",
        id: s.id,
        path: s.dir || s.path,
      });
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const create = async () => {
    if (!form.name.trim()) return;
    setBusy("create");
    setErr(null);
    try {
      await buildApi.skillAction({
        action: "create",
        name: form.name,
        description: form.description,
        body: form.body || undefined,
      });
      setForm({ name: "", description: "", body: "" });
      setShowCreate(false);
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel
      title="Skills"
      helpId="skills"
      icon={<Sparkles size={20} strokeWidth={2} />}
      actions={
        <>
          <button
            type="button"
            className="icon-btn primary-btn sm"
            onClick={() => setShowCreate((v) => !v)}
            title="Create skill"
          >
            <Plus size={14} /> New
          </button>
          <button type="button" className="icon-btn" onClick={load} title="Refresh">
            <RefreshCw size={14} />
          </button>
        </>
      }
    >
      <p className="build-lede">
        Bundled / user / project skills. Create writes <code>~/.grok/skills/&lt;id&gt;/SKILL.md</code>. Toggle renames to{" "}
        <code>SKILL.md.off</code>.
      </p>
      {err ? <div className="build-err">{err}</div> : null}
      {showCreate ? (
        <div className="build-form" style={{ marginBottom: 14 }}>
          <input
            className="build-search"
            placeholder="Skill id (e.g. my-helper)"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />
          <input
            className="build-search"
            placeholder="Description"
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          />
          <textarea
            className="build-textarea"
            placeholder="SKILL.md body (markdown)"
            rows={5}
            value={form.body}
            onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className="icon-btn primary-btn sm"
              disabled={busy === "create" || !form.name.trim()}
              onClick={() => void create()}
            >
              {busy === "create" ? "Creating…" : "Create skill"}
            </button>
            <button type="button" className="icon-btn sm" onClick={() => setShowCreate(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      <input
        className="build-search"
        placeholder="Filter skills…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {loading ? (
        <div className="build-empty">
          <Loader2 className="spin" size={16} /> Loading…
        </div>
      ) : (
        <div className="skill-grid">
          {filtered.map((s) => {
            const on = s.enabled !== false;
            return (
              <div key={`${s.scope}:${s.id}`} className={`skill-card ${on ? "" : "off"}`}>
                <div className="skill-card-top">
                  <strong>{s.name}</strong>
                  <span
                    className={`src-chip src-${s.scope === "bundled" ? "cli" : s.scope === "user" ? "desk" : "mail"}`}
                  >
                    {s.scope}
                    {!on ? " · off" : ""}
                  </span>
                </div>
                <p>{s.description || "No description"}</p>
                <div className="skill-card-actions">
                  <button
                    type="button"
                    className="icon-btn primary-btn sm"
                    disabled={!on}
                    onClick={() => onInvokeSkill?.(s.name)}
                  >
                    Invoke
                  </button>
                  {s.scope !== "bundled" ? (
                    <button
                      type="button"
                      className="icon-btn sm"
                      disabled={busy === s.id}
                      onClick={() => void toggle(s)}
                    >
                      {busy === s.id ? "…" : on ? "Disable" : "Enable"}
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

export function McpStudio() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [doctorOut, setDoctorOut] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({
    name: "",
    target: "",
    kind: "url" as "url" | "command",
    transport: "",
    scope: "user",
  });

  const load = useCallback(() => {
    setLoading(true);
    void buildApi
      .mcp()
      .then((r) => setServers(r.servers || []))
      .catch(() => setServers([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (action: "enable" | "disable" | "remove", name: string) => {
    setBusy(`${action}:${name}`);
    setErr(null);
    try {
      const r = await buildApi.mcpAction({ action, name });
      if (!r.ok && r.error) throw new Error(r.error);
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const add = async () => {
    if (!form.name.trim() || !form.target.trim()) return;
    setBusy("add");
    setErr(null);
    try {
      const body: Parameters<typeof buildApi.mcpAction>[0] = {
        action: "add",
        name: form.name.trim(),
        scope: form.scope || "user",
      };
      if (form.kind === "url") {
        body.url = form.target.trim();
        if (form.transport) body.transport = form.transport;
      } else {
        body.command = form.target.trim();
        if (form.transport) body.transport = form.transport;
      }
      const r = await buildApi.mcpAction(body);
      if (!r.ok && r.error) throw new Error(r.error);
      setForm({ name: "", target: "", kind: "url", transport: "", scope: "user" });
      setShowAdd(false);
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const doctor = async () => {
    setBusy("doctor");
    setErr(null);
    try {
      const r = await buildApi.mcpAction({ action: "doctor" });
      setDoctorOut(r.output || (r.ok ? "OK" : r.error || "done"));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel
      title="MCP servers"
      helpId="mcp"
      icon={<Network size={20} strokeWidth={2} />}
      actions={
        <>
          <button type="button" className="icon-btn primary-btn sm" onClick={() => setShowAdd((v) => !v)}>
            <Plus size={14} /> Add
          </button>
          <button type="button" className="icon-btn sm" disabled={busy === "doctor"} onClick={() => void doctor()}>
            Doctor
          </button>
          <button type="button" className="icon-btn" onClick={load} title="Refresh">
            <RefreshCw size={14} />
          </button>
        </>
      }
    >
      <p className="build-lede">
        Native <code>grok mcp</code> — enable/disable/add/remove. OAuth may still need TUI for some servers.
      </p>
      {err ? <div className="build-err">{err}</div> : null}
      {doctorOut ? (
        <pre className="build-pre" style={{ marginBottom: 12, maxHeight: 160, overflow: "auto" }}>
          {doctorOut}
        </pre>
      ) : null}
      {showAdd ? (
        <div className="build-form" style={{ marginBottom: 14 }}>
          <input
            className="build-search"
            placeholder="Name (e.g. github)"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <select
              className="build-select"
              value={form.kind}
              onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value as "url" | "command" }))}
            >
              <option value="url">HTTP URL</option>
              <option value="command">stdio command</option>
            </select>
            <select
              className="build-select"
              value={form.scope}
              onChange={(e) => setForm((f) => ({ ...f, scope: e.target.value }))}
            >
              <option value="user">user</option>
              <option value="project">project</option>
              <option value="local">local</option>
            </select>
          </div>
          <input
            className="build-search"
            placeholder={form.kind === "url" ? "https://…/mcp" : "npx -y @modelcontextprotocol/server-…"}
            value={form.target}
            onChange={(e) => setForm((f) => ({ ...f, target: e.target.value }))}
          />
          <input
            className="build-search"
            placeholder="Transport override (optional: http / stdio)"
            value={form.transport}
            onChange={(e) => setForm((f) => ({ ...f, transport: e.target.value }))}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className="icon-btn primary-btn sm"
              disabled={busy === "add" || !form.name.trim() || !form.target.trim()}
              onClick={() => void add()}
            >
              {busy === "add" ? "Adding…" : "Add server"}
            </button>
            <button type="button" className="icon-btn sm" onClick={() => setShowAdd(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {loading ? (
        <div className="build-empty">Loading…</div>
      ) : servers.length === 0 ? (
        <div className="build-empty">No MCP servers — add one above or via <code>grok mcp add</code></div>
      ) : (
        <div className="mcp-list">
          {servers.map((s) => (
            <div key={s.name} className={`mcp-row ${s.enabled ? "on" : "off"}`}>
              <span className={`agent-dot st-${s.enabled ? "done" : "idle"}`} />
              <div className="mcp-info">
                <strong>{s.name}</strong>
                <span>
                  {s.transport || (s.url ? "http" : "stdio")}
                  {s.scope ? ` · ${s.scope}` : ""}
                  {s.url ? ` · ${s.url}` : s.command ? ` · ${s.command}` : ""}
                </span>
              </div>
              <span className="mcp-state">{s.enabled ? "enabled" : "disabled"}</span>
              <div className="mcp-actions">
                <button
                  type="button"
                  className="icon-btn sm"
                  disabled={!!busy}
                  onClick={() => void act(s.enabled ? "disable" : "enable", s.name)}
                >
                  {s.enabled ? "Disable" : "Enable"}
                </button>
                <button
                  type="button"
                  className="icon-btn sm danger-btn"
                  disabled={!!busy}
                  title="Remove server"
                  onClick={() => {
                    if (window.confirm(`Remove MCP server "${s.name}"?`)) void act("remove", s.name);
                  }}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

export function PlanBoard({
  cwd,
  activeSessionId,
  onPromptSlash,
  livePlan,
}: CommonProps & { livePlan?: { content: string; status: string }[] }) {
  const [content, setContent] = useState<string | null>(null);
  const [meta, setMeta] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    if (!activeSessionId) {
      setContent(null);
      setMeta(null);
      return;
    }
    setLoading(true);
    void buildApi
      .plan(activeSessionId, cwd)
      .then((r) => {
        setContent(r.content);
        setMeta(r.mtime ? `Updated ${relTime(r.mtime)} · ${r.source || "plan"}` : r.source || null);
      })
      .catch(() => setContent(null))
      .finally(() => setLoading(false));
  }, [activeSessionId, cwd]);

  useEffect(() => {
    load();
  }, [load]);

  const liveText =
    livePlan && livePlan.length
      ? livePlan.map((p) => `- [${p.status}] ${p.content}`).join("\n")
      : null;

  const body = content || liveText;

  return (
    <Panel
      title="Plan board"
      helpId="plan"
      icon={<FolderTree size={20} strokeWidth={2} />}
      actions={
        <>
          <button type="button" className="icon-btn" onClick={load} title="Refresh">
            <RefreshCw size={14} />
          </button>
          <button type="button" className="icon-btn primary-btn" onClick={() => onPromptSlash?.("/plan ")}>
            Enter plan mode
          </button>
        </>
      }
    >
      <p className="build-lede">
        Visual plan review — reads session plan.md. Approve / revise via chat until ACP plan tools are wired.
      </p>
      {!activeSessionId ? (
        <div className="build-empty">Open a chat session to load its plan.</div>
      ) : loading ? (
        <div className="build-empty">
          <Loader2 className="spin" size={16} /> Loading plan…
        </div>
      ) : !body ? (
        <div className="build-empty">
          No plan.md yet. Hit Enter plan mode, or ask the agent to plan first.
        </div>
      ) : (
        <>
          {meta ? <div className="build-muted" style={{ marginBottom: 10 }}>{meta}</div> : null}
          <div className="plan-board-actions">
            <button
              type="button"
              className="icon-btn primary-btn"
              onClick={() => onPromptSlash?.("Approve the plan and implement it.")}
            >
              Approve & implement
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={() => onPromptSlash?.("Revise the plan: ")}
            >
              Request changes
            </button>
            <button type="button" className="icon-btn" onClick={() => onPromptSlash?.("/view-plan")}>
              /view-plan
            </button>
          </div>
          <pre className="plan-md">{body}</pre>
        </>
      )}
    </Panel>
  );
}

export function ArchMap({ cwd }: CommonProps) {
  const [data, setData] = useState<Awaited<ReturnType<typeof buildApi.inspect>> | null>(null);

  useEffect(() => {
    if (!cwd) {
      setData(null);
      return;
    }
    void buildApi.inspect(cwd).then(setData).catch(() => setData(null));
  }, [cwd]);

  return (
    <Panel title="Architecture map"
      helpId="arch" icon={<Boxes size={20} strokeWidth={2} />}>
      {!cwd ? (
        <div className="build-empty">Select a project chat to map its rules, skills, hooks, agents.</div>
      ) : !data?.ok ? (
        <div className="build-empty">{data?.error || "Loading…"}</div>
      ) : (
        <div className="arch-map">
          <div className="arch-cwd" title={data.cwd}>
            {data.cwd}
          </div>
          <section>
            <h3>Rules</h3>
            {(data.rules || []).length === 0 ? (
              <div className="build-muted">No AGENTS.md / CLAUDE.md</div>
            ) : (
              <ul>
                {(data.rules || []).map((r) => (
                  <li key={r.path}>
                    <code>{r.name}</code>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section>
            <h3>.grok modules</h3>
            {(data.modules || []).length === 0 ? (
              <div className="build-muted">No project .grok/</div>
            ) : (
              <div className="arch-chips">
                {(data.modules || []).map((m) => (
                  <span key={m.name} className="arch-chip">
                    {m.name}
                    <em>{m.count}</em>
                  </span>
                ))}
              </div>
            )}
          </section>
          <section>
            <h3>Project skills</h3>
            {(data.skills || []).length === 0 ? (
              <div className="build-muted">None</div>
            ) : (
              <ul>
                {(data.skills || []).map((s) => (
                  <li key={s.id}>{s.name}</li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </Panel>
  );
}

export function RadarView() {
  const [latest, setLatest] = useState<RadarSnapshot | null>(null);
  const [queue, setQueue] = useState<{ id: string; text: string; priority: string; status: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    void buildApi
      .radar()
      .then((r) => {
        setLatest(r.latest);
        setQueue(r.queue || []);
      })
      .catch(() => {
        setLatest(null);
        setQueue([]);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const runScan = async () => {
    setRunning(true);
    try {
      const r = await buildApi.radarRun();
      setLatest(r.latest);
      setFlash("Scan complete");
      setTimeout(() => setFlash(null), 2000);
      load();
    } catch {
      setFlash("Scan failed");
    } finally {
      setRunning(false);
    }
  };

  const runDigest = async () => {
    try {
      const r = await buildApi.radarDigest({ dry: true });
      setFlash(r.ok ? "Digest dry-run OK" : "Digest failed");
      setTimeout(() => setFlash(null), 2500);
    } catch {
      setFlash("Digest failed");
      setTimeout(() => setFlash(null), 2500);
    }
  };

  const approve = async (p: { id: string; text: string; priority?: string }) => {
    await buildApi.radarApprove({ id: p.id, text: p.text, priority: p.priority });
    setFlash("Queued for weekly digest");
    setTimeout(() => setFlash(null), 2000);
    load();
  };

  return (
    <Panel
      title="Feature radar"
      helpId="radar"
      icon={<RadarIcon size={20} strokeWidth={2} />}
      actions={
        <>
          {flash ? <span className="pill ok">{flash}</span> : null}
          <button type="button" className="icon-btn" onClick={() => void runDigest()} title="Weekly digest dry-run">
            <Mail size={14} />
            <span>Digest</span>
          </button>
          <button type="button" className="icon-btn primary-btn" disabled={running} onClick={() => void runScan()}>
            {running ? <Loader2 className="spin" size={14} /> : <Play size={14} />}
            <span>Scan now</span>
          </button>
        </>
      }
    >
      <p className="build-lede">
        Daily scan of Grok Build / xAI surface. Weekly digest email (if Resend configured) with one-liner proposals. Reply BUILD n to
        ship.
      </p>
      {loading ? (
        <div className="build-empty">Loading…</div>
      ) : (
        <>
          <div className="radar-summary">
            <span className="pill ok">
              <span className="dot" />
              {latest?.local_version || latest?.binary_version || "Build"}
            </span>
            <span className="build-muted">{latest?.summary || "No snapshot yet — Scan now"}</span>
            {latest?.date ? <span className="build-muted">{latest.date}</span> : null}
          </div>
          <h3 className="build-h3">Proposals</h3>
          <div className="proposal-list">
            {(latest?.desk_gap_proposals || []).map((p, i) => (
              <div key={p.id} className="proposal-row">
                <span className="proposal-n">{i + 1}</span>
                <span className={`proposal-pri pri-${(p.priority || "P1").toLowerCase()}`}>{p.priority || "P1"}</span>
                <span className="proposal-text">{p.text}</span>
                <button type="button" className="icon-btn sm" title="Approve → queue" onClick={() => void approve(p)}>
                  <Check size={14} />
                </button>
              </div>
            ))}
          </div>
          {queue.length > 0 ? (
            <>
              <h3 className="build-h3">Approved queue</h3>
              <ul className="queue-list">
                {queue.map((q) => (
                  <li key={q.id}>
                    <span className="proposal-pri">{q.priority}</span> {q.text}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </>
      )}
    </Panel>
  );
}

export function MarketplaceView(_props: CommonProps) {
  const [installed, setInstalled] = useState<PluginInfo[]>([]);
  const [catalog, setCatalog] = useState<MarketPlugin[]>([]);
  const [q, setQ] = useState("");
  const [source, setSource] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    void Promise.all([
      buildApi.plugins().catch(() => ({ ok: false, plugins: [] as PluginInfo[] })),
      buildApi.marketplace().catch(() => ({
        ok: false,
        installed: [] as MarketPlugin[],
        catalog: [] as MarketPlugin[],
      })),
    ])
      .then(([pl, mk]) => {
        setInstalled(pl.plugins || []);
        setCatalog(mk.catalog || []);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const installedNames = new Set(installed.map((p) => p.name.toLowerCase()));
  const filtered = catalog.filter((p) => {
    const h = `${p.name} ${p.description || ""} ${p.marketplace || ""}`.toLowerCase();
    return !q.trim() || h.includes(q.trim().toLowerCase());
  });

  const run = async (
    action: "install" | "uninstall" | "update" | "enable" | "disable",
    opts: { name?: string; source?: string },
  ) => {
    const key = `${action}:${opts.name || opts.source || "all"}`;
    setBusy(key);
    setErr(null);
    setMsg(null);
    try {
      const r = await buildApi.pluginAction({ action, ...opts, trust: true });
      if (!r.ok && r.error) throw new Error(r.error);
      setMsg(`${action} ok${opts.name ? `: ${opts.name}` : ""}`);
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel
      title="Marketplace"
      helpId="marketplace"
      icon={<Store size={20} strokeWidth={2} />}
      actions={
        <>
          <button
            type="button"
            className="icon-btn sm"
            disabled={!!busy}
            onClick={() => void run("update", {})}
            title="Update all plugins"
          >
            Update all
          </button>
          <button type="button" className="icon-btn" onClick={load}>
            <RefreshCw size={14} />
          </button>
        </>
      }
    >
      <p className="build-lede">
        Native <code>grok plugin</code> install / uninstall / update. Catalog from marketplace cache.
      </p>
      {err ? <div className="build-err">{err}</div> : null}
      {msg ? <div className="build-ok">{msg}</div> : null}
      <div className="build-form" style={{ marginBottom: 14, display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input
          className="build-search"
          style={{ flex: 1, minWidth: 200 }}
          placeholder="Install source (plugin name or git URL)"
          value={source}
          onChange={(e) => setSource(e.target.value)}
        />
        <button
          type="button"
          className="icon-btn primary-btn sm"
          disabled={!source.trim() || !!busy}
          onClick={() => void run("install", { source: source.trim() }).then(() => setSource(""))}
        >
          Install
        </button>
      </div>
      <h3 className="build-h3">Installed ({installed.length})</h3>
      {installed.length === 0 ? (
        <div className="build-muted" style={{ marginBottom: 12 }}>
          None yet
        </div>
      ) : (
        <div className="skill-grid" style={{ marginBottom: 16 }}>
          {installed.map((p) => (
            <div key={p.name} className="skill-card">
              <div className="skill-card-top">
                <strong>{p.name}</strong>
                <span className="src-chip src-desk">{p.status || "installed"}</span>
              </div>
              <p>
                {p.marketplace || "plugin"}
                {p.version ? ` · v${p.version}` : ""}
              </p>
              <div className="skill-card-actions">
                <button
                  type="button"
                  className="icon-btn sm"
                  disabled={!!busy}
                  onClick={() => void run("update", { name: p.name })}
                >
                  Update
                </button>
                <button
                  type="button"
                  className="icon-btn sm danger-btn"
                  disabled={!!busy}
                  onClick={() => {
                    if (window.confirm(`Uninstall plugin "${p.name}"?`)) void run("uninstall", { name: p.name });
                  }}
                >
                  Uninstall
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <input
        className="build-search"
        placeholder="Search catalog…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <h3 className="build-h3">Catalog ({filtered.length})</h3>
      {loading ? (
        <div className="build-empty">Loading…</div>
      ) : (
        <div className="skill-grid">
          {filtered.slice(0, 60).map((p) => {
            const isIn = installedNames.has(p.name.toLowerCase()) || p.status === "installed";
            return (
              <div key={p.id} className="skill-card">
                <div className="skill-card-top">
                  <strong>{p.name}</strong>
                  <span className={`src-chip src-${isIn ? "desk" : "cli"}`}>
                    {isIn ? "installed" : p.status || "available"}
                  </span>
                </div>
                <p>{p.description || p.marketplace || "—"}</p>
                {p.skills?.length || p.mcp?.length ? (
                  <div className="build-muted" style={{ fontSize: 11 }}>
                    {p.skills?.length ? `${p.skills.length} skills` : ""}
                    {p.skills?.length && p.mcp?.length ? " · " : ""}
                    {p.mcp?.length ? `${p.mcp.length} mcp` : ""}
                  </div>
                ) : null}
                {!isIn ? (
                  <button
                    type="button"
                    className="icon-btn primary-btn sm"
                    disabled={!!busy}
                    onClick={() => void run("install", { source: p.name })}
                  >
                    Install
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

export function AgentsPersonasView({ cwd }: CommonProps) {
  const [agents, setAgents] = useState<AgentDef[]>([]);
  const [personas, setPersonas] = useState<PersonaDef[]>([]);
  const [tab, setTab] = useState<"agents" | "personas">("agents");
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [preview, setPreview] = useState<{ title: string; content: string } | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    void buildApi
      .agentDefs(cwd)
      .then((r) => {
        setAgents(r.agents || []);
        setPersonas(r.personas || []);
      })
      .catch(() => {
        setAgents([]);
        setPersonas([]);
      })
      .finally(() => setLoading(false));
  }, [cwd]);

  useEffect(() => {
    load();
  }, [load]);

  const rows = tab === "agents" ? agents : personas;
  const filtered = rows.filter((r) => {
    const h = `${r.name} ${r.description} ${r.scope}`.toLowerCase();
    return !q.trim() || h.includes(q.trim().toLowerCase());
  });

  const openFile = async (item: AgentDef | PersonaDef) => {
    try {
      const r = await buildApi.file(item.path);
      setPreview({ title: item.name, content: r.content || r.error || "(empty)" });
    } catch (e) {
      setPreview({ title: item.name, content: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <Panel
      title="Agents & Personas"
      helpId="personas"
      icon={<Users size={20} strokeWidth={2} />}
      actions={
        <button type="button" className="icon-btn" onClick={load}>
          <RefreshCw size={14} />
        </button>
      }
    >
      <p className="build-lede">
        Subagent types (<code>~/.grok/agents</code>, bundled) and personas (<code>~/.grok/personas</code>). Read-only
        browse — edit on disk or via agent.
      </p>
      <div className="build-tabs" style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button
          type="button"
          className={`icon-btn sm ${tab === "agents" ? "primary-btn" : ""}`}
          onClick={() => setTab("agents")}
        >
          Agents ({agents.length})
        </button>
        <button
          type="button"
          className={`icon-btn sm ${tab === "personas" ? "primary-btn" : ""}`}
          onClick={() => setTab("personas")}
        >
          Personas ({personas.length})
        </button>
      </div>
      <input
        className="build-search"
        placeholder={`Filter ${tab}…`}
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {loading ? (
        <div className="build-empty">Loading…</div>
      ) : (
        <div className="skill-grid">
          {filtered.map((item) => (
            <div key={item.id} className="skill-card">
              <div className="skill-card-top">
                <strong>{item.name}</strong>
                <span
                  className={`src-chip src-${item.scope === "bundled" ? "cli" : item.scope === "user" ? "desk" : "mail"}`}
                >
                  {item.scope}
                </span>
              </div>
              <p>{item.description || "—"}</p>
              <button type="button" className="icon-btn sm" onClick={() => void openFile(item)}>
                View
              </button>
            </div>
          ))}
        </div>
      )}
      {preview ? (
        <div className="build-preview" style={{ marginTop: 16 }}>
          <div className="skill-card-top" style={{ marginBottom: 8 }}>
            <h3 className="build-h3" style={{ margin: 0 }}>
              {preview.title}
            </h3>
            <button type="button" className="icon-btn sm" onClick={() => setPreview(null)}>
              Close
            </button>
          </div>
          <pre className="build-pre" style={{ maxHeight: 360, overflow: "auto" }}>
            {preview.content}
          </pre>
        </div>
      ) : null}
    </Panel>
  );
}

export function MemoryBrowser({ onPromptSlash }: CommonProps) {
  const [banks, setBanks] = useState<MemoryBank[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void buildApi
      .memory()
      .then((r) => {
        setBanks(r.banks || []);
        if (r.banks?.[0]) setActive(r.banks[0].id);
      })
      .catch(() => setBanks([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!active) return;
    void buildApi
      .memoryFile(active)
      .then((r) => setContent(r.content || r.error || ""))
      .catch(() => setContent("Failed to load"));
  }, [active]);

  return (
    <Panel
      title="Memory"
      helpId="memory"
      icon={<Brain size={20} strokeWidth={2} />}
      actions={
        <>
          <button type="button" className="icon-btn" onClick={() => onPromptSlash?.("/flush")}>
            Flush
          </button>
          <button type="button" className="icon-btn primary-btn" onClick={() => onPromptSlash?.("/dream")}>
            Dream
          </button>
        </>
      }
    >
      <p className="build-lede">
        Grok memory + AgentMemory banks. Flush/Dream run through the agent. Canonical: ~/AgentMemory.
      </p>
      {loading ? (
        <div className="build-empty">Loading…</div>
      ) : (
        <div className="memory-split">
          <div className="memory-list">
            {banks.map((b) => (
              <button
                key={b.id}
                type="button"
                className={`memory-item ${active === b.id ? "active" : ""}`}
                onClick={() => setActive(b.id)}
              >
                <span className="memory-name">{b.name}</span>
                <span className="memory-scope">{b.scope}</span>
              </button>
            ))}
          </div>
          <pre className="plan-md memory-body">{content || "Select a bank"}</pre>
        </div>
      )}
    </Panel>
  );
}

export function HooksManager() {
  const [hooks, setHooks] = useState<HookInfo[]>([]);
  const [detail, setDetail] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    void buildApi
      .hooks()
      .then((r) => {
        setHooks(r.hooks || []);
        if (r.hooks?.[0]) setActive(r.hooks[0].id);
      })
      .catch(() => setHooks([]));
  }, []);

  useEffect(() => {
    if (!active) return;
    void buildApi
      .hookFile(active)
      .then((r) => setDetail(r.content || r.error || ""))
      .catch(() => setDetail(null));
  }, [active]);

  return (
    <Panel title="Hooks"
      helpId="hooks" icon={<Webhook size={20} strokeWidth={2} />}>
      <p className="build-lede">Lifecycle hooks from ~/.grok/hooks — SessionStart, Stop, SessionEnd, etc.</p>
      {hooks.length === 0 ? (
        <div className="build-empty">No hook files found</div>
      ) : (
        <div className="memory-split">
          <div className="memory-list">
            {hooks.map((h) => (
              <button
                key={h.id}
                type="button"
                className={`memory-item ${active === h.id ? "active" : ""}`}
                onClick={() => setActive(h.id)}
              >
                <span className="memory-name">{h.name}</span>
                <span className="memory-scope">
                  {h.commandCount} cmds · {h.events.slice(0, 3).join(", ")}
                </span>
              </button>
            ))}
          </div>
          <pre className="plan-md memory-body">{detail || ""}</pre>
        </div>
      )}
    </Panel>
  );
}

export function DoctorView() {
  const [data, setData] = useState<Awaited<ReturnType<typeof buildApi.doctor>> | null>(null);

  const load = useCallback(() => {
    void buildApi.doctor().then(setData).catch(() => setData(null));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <Panel
      title="Doctor"
      helpId="doctor"
      icon={<Stethoscope size={20} strokeWidth={2} />}
      actions={
        <button type="button" className="icon-btn" onClick={load}>
          <RefreshCw size={14} />
        </button>
      }
    >
      <p className="build-lede">
        Local health for Grok Build + Desk. Binary: {data?.version?.version || "…"}.
      </p>
      {!data ? (
        <div className="build-empty">Checking…</div>
      ) : (
        <div className="doctor-list">
          {data.checks.map((c) => (
            <div key={c.id} className={`doctor-row ${c.ok ? "ok" : "bad"}`}>
              <span className={`agent-dot st-${c.ok ? "done" : "error"}`} />
              <strong>{c.id}</strong>
              <span className="build-muted">{c.detail}</span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

export function WorkflowsView({ cwd, onPromptSlash }: CommonProps) {
  const [rows, setRows] = useState<
    { id: string; name: string; scope: string; file: string; preview?: string }[]
  >([]);
  const [runs, setRuns] = useState<
    {
      id: string;
      name: string;
      status: string;
      phase?: string | null;
      sessionId?: string | null;
      mtime?: string | null;
      source?: string;
    }[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"runs" | "catalog">("runs");
  const [args, setArgs] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    void buildApi
      .workflows(cwd)
      .then((r) => {
        setRows(r.workflows || []);
        setRuns(r.runs || []);
      })
      .catch(() => {
        setRows([]);
        setRuns([]);
      })
      .finally(() => setLoading(false));
  }, [cwd]);

  useEffect(() => {
    load();
    const t = window.setInterval(load, 8_000);
    return () => window.clearInterval(t);
  }, [load]);

  const isLive = (s: string) => /^(run|running|active|pending|paused|pause|in_progress)/i.test(s) || /phase/i.test(s);
  const live = runs.filter((r) => isLive(r.status));
  const retained = runs.filter((r) => !isLive(r.status));

  return (
    <Panel
      title="Workflows"
      helpId="workflows"
      icon={<GitBranch size={20} strokeWidth={2} />}
      actions={
        <button type="button" className="icon-btn" onClick={load}>
          <RefreshCw size={14} />
        </button>
      }
    >
      <p className="build-lede">
        Live run board (like TUI <code>/workflows</code>) + saved <code>.rhai</code> catalog. Controls send{" "}
        <code>/workflow</code> slash commands.
      </p>
      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <button
          type="button"
          className={`icon-btn sm ${tab === "runs" ? "primary-btn" : ""}`}
          onClick={() => setTab("runs")}
        >
          Runs ({runs.length})
        </button>
        <button
          type="button"
          className={`icon-btn sm ${tab === "catalog" ? "primary-btn" : ""}`}
          onClick={() => setTab("catalog")}
        >
          Catalog ({rows.length})
        </button>
      </div>

      {tab === "runs" ? (
        loading && runs.length === 0 ? (
          <div className="build-empty">Loading…</div>
        ) : runs.length === 0 ? (
          <div className="build-empty">
            No runs yet. Launch a workflow from Catalog, or start one in chat with{" "}
            <code>/workflow &lt;name&gt;</code>.
          </div>
        ) : (
          <>
            {live.length > 0 ? <h3 className="build-h3">Active</h3> : null}
            {live.map((r) => (
              <div key={r.id} className="wf-run-row">
                <div className="wf-run-top">
                  <strong>{r.name}</strong>
                  <span className={`src-chip src-desk`}>{r.status}</span>
                </div>
                <div className="wf-run-meta">
                  {r.phase ? `phase: ${r.phase} · ` : ""}
                  {r.sessionId ? `session ${r.sessionId.slice(0, 8)} · ` : ""}
                  {r.mtime ? new Date(r.mtime).toLocaleString() : ""}
                  {r.source ? ` · ${r.source}` : ""}
                </div>
                <div className="wf-run-actions">
                  <button
                    type="button"
                    className="icon-btn sm"
                    onClick={() => onPromptSlash?.(`/workflow pause ${r.name}`)}
                  >
                    Pause
                  </button>
                  <button
                    type="button"
                    className="icon-btn sm"
                    onClick={() => onPromptSlash?.(`/workflow resume ${r.name}`)}
                  >
                    Resume
                  </button>
                  <button
                    type="button"
                    className="icon-btn sm danger-btn"
                    onClick={() => onPromptSlash?.(`/workflow stop ${r.name}`)}
                  >
                    Stop
                  </button>
                  <button
                    type="button"
                    className="icon-btn sm"
                    onClick={() => onPromptSlash?.(`/workflow save ${r.name}`)}
                  >
                    Save script
                  </button>
                </div>
              </div>
            ))}
            {retained.length > 0 ? <h3 className="build-h3">Retained / recent</h3> : null}
            {retained.map((r) => (
              <div key={r.id} className="wf-run-row">
                <div className="wf-run-top">
                  <strong>{r.name}</strong>
                  <span className="src-chip src-cli">{r.status}</span>
                </div>
                <div className="wf-run-meta">
                  {r.sessionId ? `${r.sessionId.slice(0, 8)} · ` : ""}
                  {r.mtime ? new Date(r.mtime).toLocaleString() : r.source || ""}
                </div>
              </div>
            ))}
          </>
        )
      ) : loading ? (
        <div className="build-empty">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="build-empty">
          No saved workflows. Create <code>.grok/workflows/*.rhai</code> or run /create-workflow.
        </div>
      ) : (
        <>
          <input
            className="build-search"
            placeholder='Optional args JSON e.g. {"target":"origin/main...HEAD"}'
            value={args}
            onChange={(e) => setArgs(e.target.value)}
            style={{ marginBottom: 12 }}
          />
          <div className="skill-grid">
            {rows.map((w) => (
              <div key={w.id} className="skill-card">
                <div className="skill-card-top">
                  <strong>{w.name}</strong>
                  <span className="src-chip src-cli">{w.scope}</span>
                </div>
                <p>{w.preview?.split("\n").slice(0, 3).join(" ") || w.file}</p>
                <button
                  type="button"
                  className="icon-btn primary-btn sm"
                  onClick={() => {
                    const a = args.trim();
                    onPromptSlash?.(a ? `/workflow ${w.name} ${a}` : `/workflow ${w.name}`);
                    setTab("runs");
                  }}
                >
                  Launch
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </Panel>
  );
}

export function WorktreesView({ cwd, onPromptSlash, onDispatch }: CommonProps) {
  const [rows, setRows] = useState<
    {
      id: string;
      path: string;
      sourceRepo?: string | null;
      repoName: string;
      kind: string;
      status: string;
      sessionId: string | null;
      gitRef: string | null;
    }[]
  >([]);
  const [err, setErr] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    void buildApi
      .worktrees()
      .then((r) => {
        setRows(r.worktrees || []);
        setErr(r.error || null);
      })
      .catch((e) => {
        setRows([]);
        setErr(String(e));
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (body: Record<string, unknown>, label: string) => {
    setBusyId(String(body.id || "x"));
    setFlash(null);
    try {
      const r = await buildApi.worktreeAction(body);
      if (!r.ok) throw new Error(r.error || "failed");
      setFlash(label);
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
      setTimeout(() => setFlash(null), 2500);
    }
  };

  const sourceRepo = cwd && cwd !== "/" ? cwd : null;

  return (
    <Panel
      title="Worktrees"
      helpId="worktrees"
      icon={<FolderGit2 size={20} strokeWidth={2} />}
      actions={
        <>
          {flash ? <span className="pill ok">{flash}</span> : null}
          <button type="button" className="icon-btn" onClick={load}>
            <RefreshCw size={14} />
          </button>
          <button type="button" className="icon-btn" onClick={() => void act({ action: "gc" }, "GC done")}>
            GC
          </button>
        </>
      }
    >
      <p className="build-lede">
        Create isolated git worktrees, discard, or merge branch back into main. Apply = resume session with
        worktree code (via agent).
      </p>
      <div className="dispatch-bar">
        <input
          className="build-search"
          style={{ marginBottom: 0, flex: 1, maxWidth: "none" }}
          placeholder={sourceRepo ? `Name for worktree under ${sourceRepo.split("/").pop()}` : "Open a project chat first"}
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={!sourceRepo}
        />
        <button
          type="button"
          className="icon-btn primary-btn"
          disabled={!sourceRepo || !name.trim()}
          onClick={() =>
            void act(
              { action: "create", sourceRepo, name: name.trim() },
              "Created",
            ).then(() => setName(""))
          }
        >
          Create
        </button>
      </div>
      {err ? <div className="build-muted" style={{ marginBottom: 8, color: "var(--red)" }}>{err}</div> : null}
      {loading ? (
        <div className="build-empty">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="build-empty">No worktrees yet — create one from the active project cwd.</div>
      ) : (
        <div className="task-tree">
          {rows.map((w) => (
            <div key={w.id} className={`task-node st-${w.status === "alive" ? "done" : "idle"}`}>
              <span className={`agent-dot st-${w.status === "alive" ? "done" : "idle"}`} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="task-title">
                  {w.repoName} · {w.kind}
                </div>
                <div className="task-kind" title={w.path}>
                  {w.status}
                  {w.gitRef ? ` · ${w.gitRef}` : ""}
                  {w.sessionId ? ` · ${w.sessionId.slice(0, 8)}` : ""}
                </div>
                <div className="build-muted" style={{ fontSize: 11, marginTop: 2 }}>
                  {w.path}
                </div>
                <div className="perm-actions" style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    className="icon-btn sm primary-btn"
                    disabled={busyId === w.id}
                    onClick={() => onDispatch?.(`Work in worktree at ${w.path}. Continue the task there.`)}
                  >
                    Dispatch here
                  </button>
                  <button
                    type="button"
                    className="icon-btn sm"
                    disabled={busyId === w.id || !w.sourceRepo}
                    onClick={() => {
                      if (!confirm(`Merge worktree branch into main of ${w.sourceRepo}?`)) return;
                      void act(
                        {
                          action: "merge",
                          sourceRepo: w.sourceRepo,
                          path: w.path,
                          targetBranch: "main",
                        },
                        "Merged",
                      );
                    }}
                  >
                    Merge→main
                  </button>
                  <button
                    type="button"
                    className="icon-btn sm"
                    onClick={() => onPromptSlash?.(`/fork --worktree apply from ${w.path}`)}
                  >
                    Apply
                  </button>
                  <button
                    type="button"
                    className="icon-btn sm danger-btn"
                    disabled={busyId === w.id}
                    onClick={() => {
                      if (!confirm(`Discard worktree ${w.path}?`)) return;
                      void act({ action: "rm", id: w.id, force: true }, "Discarded");
                    }}
                  >
                    Discard
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

export function MediaStudio({ onPromptSlash }: CommonProps) {
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<"image" | "video">("image");

  return (
    <Panel title="Media studio"
      helpId="media" icon={<Image size={20} strokeWidth={2} />}>
      <p className="build-lede">
        Generate via Grok Build /imagine and /imagine-video — results land in the chat session.
      </p>
      <div className="mode-chip-row" style={{ marginBottom: 12, display: "inline-flex" }}>
        <button
          type="button"
          className={`mode-chip ${mode === "image" ? "active" : ""}`}
          onClick={() => setMode("image")}
        >
          Image
        </button>
        <button
          type="button"
          className={`mode-chip ${mode === "video" ? "active" : ""}`}
          onClick={() => setMode("video")}
        >
          Video
        </button>
      </div>
      <textarea
        className="build-search"
        style={{ minHeight: 100, resize: "vertical", fontSize: 16, maxWidth: "100%" }}
        placeholder={mode === "image" ? "Describe an image…" : "Describe a video…"}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
      />
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button
          type="button"
          className="icon-btn primary-btn"
          disabled={!prompt.trim()}
          onClick={() => {
            const cmd = mode === "image" ? "/imagine" : "/imagine-video";
            onPromptSlash?.(`${cmd} ${prompt.trim()}`);
            setPrompt("");
          }}
        >
          Generate
        </button>
      </div>
    </Panel>
  );
}

export function UsageView({ activeSessionId, cwd }: CommonProps) {
  const [data, setData] = useState<Awaited<ReturnType<typeof buildApi.usage>> | null>(null);

  const load = useCallback(() => {
    void buildApi
      .usage(activeSessionId, cwd)
      .then(setData)
      .catch(() => setData(null));
  }, [activeSessionId, cwd]);

  useEffect(() => {
    load();
    const t = window.setInterval(load, 15_000);
    return () => window.clearInterval(t);
  }, [load]);

  const su = data?.sessionUsage;

  return (
    <Panel
      title="Usage & account"
      helpId="usage"
      icon={<Gauge size={20} strokeWidth={2} />}
      actions={
        <button type="button" className="icon-btn" onClick={load}>
          <RefreshCw size={14} />
        </button>
      }
    >
      <p className="build-lede">
        Session stats from disk · SuperGrok $ balance only if API exposes it (not inventing numbers).
      </p>
      {!data ? (
        <div className="build-empty">Loading…</div>
      ) : (
        <div className="doctor-list">
          <div className="doctor-row ok">
            <span className="agent-dot st-done" />
            <strong>version</strong>
            <span className="build-muted">{data.version?.version || "unknown"}</span>
          </div>
          <div className={`doctor-row ${data.auth?.present ? "ok" : "bad"}`}>
            <span className={`agent-dot st-${data.auth?.present ? "done" : "error"}`} />
            <strong>auth</strong>
            <span className="build-muted">
              {data.auth?.present
                ? `${data.auth.method || "session"}${data.auth.hasToken ? " · signed in" : ""}`
                : "not signed in"}
            </span>
          </div>
          <div className="doctor-row ok">
            <span className="agent-dot st-done" />
            <strong>credits</strong>
            <span className="build-muted">
              {data.account?.creditsRemaining != null
                ? String(data.account.creditsRemaining)
                : "n/a (no local balance API)"}
            </span>
          </div>
          <div className="doctor-row ok">
            <span className="agent-dot st-done" />
            <strong>session</strong>
            <span className="build-muted">
              {su
                ? [
                    su.turns != null ? `${su.turns} turns` : null,
                    su.model,
                    su.inputTokens != null ? `in ${su.inputTokens}` : null,
                    su.outputTokens != null ? `out ${su.outputTokens}` : null,
                    su.reasoningTokens != null ? `reason ${su.reasoningTokens}` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ") || "open a chat"
                : "open a chat for session stats"}
            </span>
          </div>
          <div className="doctor-row ok">
            <span className="agent-dot st-done" />
            <strong>models</strong>
            <span className="build-muted">
              {data.modelCount} cached — {(data.models || []).map((m) => m.name || m.id).join(", ")}
            </span>
          </div>
          {data.note ? <p className="build-muted">{data.note}</p> : null}
        </div>
      )}
    </Panel>
  );
}
