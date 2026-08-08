/**
 * Right rail — progressive disclosure for terminal / files / tasks / preview.
 */
import { useEffect, useMemo, useState } from "react";
import {
  Check,
  Copy,
  FileCode,
  FolderOpen,
  ListTodo,
  PanelRightClose,
  Terminal,
  X,
} from "lucide-react";
import type { Artifact, ArtifactKind } from "../lib/artifacts";
import { copyTextToClipboard } from "../lib/clipboard";
import { buildApi } from "../lib/buildClient";
import { ModuleInfo } from "./ModuleInfo";

type Tab = "tasks" | "terminal" | "files" | "preview";

type Props = {
  open: boolean;
  artifacts: Artifact[];
  focusId?: string | null;
  onClose: () => void;
  onRevealPath?: (path: string) => void;
  /** Session cwd for relative path resolve */
  cwd?: string | null;
};

const TABS: { id: Tab; label: string; icon: typeof Terminal }[] = [
  { id: "tasks", label: "Tasks", icon: ListTodo },
  { id: "terminal", label: "Terminal", icon: Terminal },
  { id: "files", label: "Files", icon: FileCode },
  { id: "preview", label: "Preview", icon: FileCode },
];

function byKind(arts: Artifact[], kind: ArtifactKind | ArtifactKind[]): Artifact[] {
  const kinds = Array.isArray(kind) ? kind : [kind];
  return arts.filter((a) => kinds.includes(a.kind));
}

export function ArtifactPane({ open, artifacts, focusId, onClose, onRevealPath, cwd }: Props) {
  const [tab, setTab] = useState<Tab>("tasks");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [fetchedBody, setFetchedBody] = useState<string | null>(null);

  const activeId = focusId || selectedId || artifacts[0]?.id || null;
  const active = artifacts.find((a) => a.id === activeId) || null;

  useEffect(() => {
    setFetchedBody(null);
    if (!active?.path) return;
    if (active.content && active.content.length > 20) return;
    let cancelled = false;
    void buildApi
      .file(active.path, cwd)
      .then((r) => {
        if (!cancelled && r.ok && r.content) setFetchedBody(r.content);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [active?.path, active?.content, cwd]);

  // Live ACP terminal host streams
  const [ptyLog, setPtyLog] = useState("");
  useEffect(() => {
    const onTerm = (ev: Event) => {
      const d = (ev as CustomEvent).detail as {
        type?: string;
        chunk?: string;
        stdout?: string;
        stderr?: string;
      };
      if (!d) return;
      if (d.stdout || d.stderr) {
        setPtyLog((d.stdout || "") + (d.stderr ? "\n" + d.stderr : ""));
      } else if (d.chunk) {
        setPtyLog((prev) => (prev + d.chunk).slice(-400_000));
      }
      setTab("terminal");
    };
    window.addEventListener("desk-terminal", onTerm);
    return () => window.removeEventListener("desk-terminal", onTerm);
  }, []);

  const taskList = useMemo(() => {
    const seen = new Set<string>();
    return [...byKind(artifacts, "plan"), ...byKind(artifacts, "task"), ...artifacts].filter(
      (a) => {
        if (seen.has(a.id)) return false;
        seen.add(a.id);
        return true;
      },
    );
  }, [artifacts]);

  const terminals = useMemo(() => byKind(artifacts, "terminal"), [artifacts]);
  const files = useMemo(() => byKind(artifacts, ["file", "diff"]), [artifacts]);

  if (!open) return null;

  const copyText = async (text: string) => {
    const ok = await copyTextToClipboard(text);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }
  };

  const select = (a: Artifact, preferTab?: Tab) => {
    setSelectedId(a.id);
    if (preferTab) setTab(preferTab);
    else if (a.kind === "terminal") setTab("terminal");
    else if (a.kind === "file" || a.kind === "diff") setTab("preview");
    else setTab("tasks");
  };

  return (
    <aside className="artifact-pane" aria-label="Artifacts">
      <div className="artifact-head">
        <span className="artifact-title">Artifacts</span>
        <div className="artifact-head-actions">
          <ModuleInfo moduleId="artifacts" compact />
          <button type="button" className="icon-btn sm" onClick={onClose} title="Close (⌘.)">
            <PanelRightClose size={16} strokeWidth={2} />
          </button>
        </div>
      </div>

      <div className="artifact-tabs">
        {TABS.map((t) => {
          const Icon = t.icon;
          const count =
            t.id === "terminal"
              ? terminals.length
              : t.id === "files"
                ? files.length
                : t.id === "tasks"
                  ? taskList.length
                  : active
                    ? 1
                    : 0;
          return (
            <button
              key={t.id}
              type="button"
              className={`artifact-tab ${tab === t.id ? "active" : ""}`}
              onClick={() => setTab(t.id)}
            >
              <Icon size={13} strokeWidth={2} />
              {t.label}
              {count > 0 ? <span className="artifact-tab-n">{count}</span> : null}
            </button>
          );
        })}
      </div>

      <div className="artifact-body">
        {tab === "tasks" && (
          <div className="artifact-list">
            {taskList.length === 0 && (
              <div className="artifact-empty">Tools and plan show up here while Grok works.</div>
            )}
            {taskList.map((a) => (
              <button
                key={a.id}
                type="button"
                className={`artifact-item ${a.id === activeId ? "active" : ""} st-${statusCls(a.status)}`}
                onClick={() => select(a)}
              >
                <span className={`artifact-dot st-${statusCls(a.status)}`} />
                <span className="artifact-item-title">{a.title}</span>
                {a.status ? <span className="artifact-item-st">{a.status.replace(/_/g, " ")}</span> : null}
              </button>
            ))}
          </div>
        )}

        {tab === "terminal" && (
          <div className="artifact-term-stack">
            {ptyLog ? (
              <div className="artifact-term-block">
                <div className="artifact-term-head">
                  <Terminal size={12} />
                  <span>live PTY</span>
                </div>
                <pre className="artifact-term-pre artifact-output">{ptyLog}</pre>
              </div>
            ) : null}
            {terminals.length === 0 && !ptyLog && (
              <div className="artifact-empty">Shell commands stream here.</div>
            )}
            {terminals.map((a) => (
              <div key={a.id} className="artifact-term-block">
                <div className="artifact-term-head">
                  <Terminal size={12} />
                  <span>{a.title}</span>
                  <span className={`artifact-item-st st-${statusCls(a.status)}`}>
                    {(a.status || "").replace(/_/g, " ")}
                  </span>
                  {a.content ? (
                    <button
                      type="button"
                      className="icon-btn sm"
                      title="Copy"
                      onClick={() => void copyText(a.content || "")}
                    >
                      {copied ? <Check size={12} /> : <Copy size={12} />}
                    </button>
                  ) : null}
                </div>
                <pre className="artifact-term-pre">{a.content || "…"}</pre>
              </div>
            ))}
          </div>
        )}

        {tab === "files" && (
          <div className="artifact-list">
            {files.length === 0 && (
              <div className="artifact-empty">Touched files appear here.</div>
            )}
            {files.map((a) => (
              <button
                key={a.id}
                type="button"
                className={`artifact-item ${a.id === activeId ? "active" : ""}`}
                onClick={() => select(a, "preview")}
              >
                <FileCode size={13} className="artifact-file-ico" />
                <span className="artifact-item-title" title={a.path || a.title}>
                  {a.title}
                </span>
                {a.path && onRevealPath ? (
                  <span
                    className="artifact-reveal"
                    role="button"
                    tabIndex={0}
                    title="Reveal in Finder"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRevealPath(a.path!);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.stopPropagation();
                        onRevealPath(a.path!);
                      }
                    }}
                  >
                    <FolderOpen size={12} />
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        )}

        {tab === "preview" && (
          <div className="artifact-preview">
            {!active && <div className="artifact-empty">Select a file or task to preview.</div>}
            {active && (
              <>
                <div className="artifact-preview-head">
                  <span className="artifact-preview-name" title={active.path || active.title}>
                    {active.path || active.title}
                  </span>
                  <button
                    type="button"
                    className="icon-btn sm"
                    title="Copy"
                    onClick={() => void copyText(active.content || active.path || active.title)}
                  >
                    {copied ? <Check size={12} /> : <Copy size={12} />}
                  </button>
                  {active.path && onRevealPath ? (
                    <button
                      type="button"
                      className="icon-btn sm"
                      title="Reveal in Finder"
                      onClick={() => onRevealPath(active.path!)}
                    >
                      <FolderOpen size={12} />
                    </button>
                  ) : null}
                </div>
                <pre className="artifact-preview-pre artifact-output">
                  {active.content || fetchedBody || active.path || active.title}
                </pre>
              </>
            )}
          </div>
        )}
      </div>

      {artifacts.length === 0 && (
        <button type="button" className="artifact-dismiss" onClick={onClose}>
          <X size={12} /> Close until Grok runs tools
        </button>
      )}
    </aside>
  );
}

function statusCls(st?: string): string {
  if (!st) return "idle";
  if (st === "completed") return "ok";
  if (st === "failed" || st === "cancelled") return "err";
  if (st === "in_progress" || st === "pending") return "run";
  return "idle";
}
