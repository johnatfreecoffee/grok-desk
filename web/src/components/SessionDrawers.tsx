import { useCallback, useEffect, useState } from "react";
import { History, Info, RotateCcw, X } from "lucide-react";
import { buildApi } from "../lib/buildClient";

type Drawer = "info" | "rewind" | "history" | "context" | null;

type Props = {
  sessionId: string | null | undefined;
  cwd?: string | null;
  open: Drawer;
  onClose: () => void;
  onRewind?: (promptIndex: number) => void;
  onReusePrompt?: (text: string) => void;
};

export function SessionDrawers({ sessionId, cwd, open, onClose, onRewind, onReusePrompt }: Props) {
  const [info, setInfo] = useState<Record<string, unknown> | null>(null);
  const [points, setPoints] = useState<
    { promptIndex: number; createdAt: string | null; fileCount: number; files: string[] }[]
  >([]);
  const [prompts, setPrompts] = useState<{ id: string; content: string; preview: string }[]>([]);
  const [usage, setUsage] = useState<Record<string, unknown> | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!sessionId || !open) return;
    setErr(null);
    if (open === "info" || open === "context") {
      void buildApi
        .sessionInfo(sessionId, cwd)
        .then((r) => setInfo(r as unknown as Record<string, unknown>))
        .catch((e) => setErr(String(e)));
      if (open === "context") {
        void buildApi
          .usage(sessionId, cwd)
          .then((r) => setUsage(r as unknown as Record<string, unknown>))
          .catch(() => setUsage(null));
      }
    } else if (open === "rewind") {
      void buildApi
        .rewindPoints(sessionId, cwd)
        .then((r) => setPoints(r.points || []))
        .catch((e) => setErr(String(e)));
    } else if (open === "history") {
      void buildApi
        .promptHistory(sessionId, cwd)
        .then((r) => setPrompts(r.prompts || []))
        .catch((e) => setErr(String(e)));
    }
  }, [sessionId, cwd, open]);

  useEffect(() => {
    load();
  }, [load]);

  if (!open) return null;

  const title =
    open === "info"
      ? "Session info"
      : open === "context"
        ? "Context & usage"
        : open === "rewind"
          ? "Rewind timeline"
          : "Prompt history";
  const Icon = open === "info" || open === "context" ? Info : open === "rewind" ? RotateCcw : History;

  return (
    <div className="session-drawer-overlay" role="dialog" aria-modal="true" aria-label={title}>
      <button type="button" className="session-drawer-backdrop" aria-label="Close" onClick={onClose} />
      <aside className="session-drawer">
        <header className="session-drawer-head">
          <div className="session-drawer-title">
            <Icon size={16} strokeWidth={2} />
            <h2>{title}</h2>
          </div>
          <button type="button" className="icon-btn sm" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div className="session-drawer-body">
          {!sessionId ? (
            <div className="build-empty">No session open</div>
          ) : err ? (
            <div className="build-empty">{err}</div>
          ) : (open === "info" || open === "context") && info ? (
            <>
              <dl className="session-info-dl">
                {[
                  ["Title", info.title],
                  ["Model", info.model],
                  ["Turns", info.nextTraceTurn ?? info.numMessages],
                  ["Cwd", info.cwd],
                  ["Branch", info.headBranch],
                  ["Agent", info.agentName],
                  ["Created", info.createdAt],
                  ["Updated", info.updatedAt],
                  ["Sandbox", info.sandboxProfile],
                  ["Effort", info.reasoningEffort],
                ].map(([k, v]) =>
                  v != null && v !== "" ? (
                    <div key={String(k)} className="session-info-row">
                      <dt>{k}</dt>
                      <dd title={String(v)}>{String(v)}</dd>
                    </div>
                  ) : null,
                )}
              </dl>
              {open === "context" && usage ? (
                <div style={{ marginTop: 14 }}>
                  <h3 className="build-h3">Token / usage</h3>
                  <dl className="session-info-dl">
                    {[
                      ["In", (usage.sessionUsage as { inputTokens?: number } | null)?.inputTokens],
                      ["Out", (usage.sessionUsage as { outputTokens?: number } | null)?.outputTokens],
                      [
                        "Reason",
                        (usage.sessionUsage as { reasoningTokens?: number } | null)?.reasoningTokens,
                      ],
                      ["Credits", (usage.account as { creditsRemaining?: number | null } | null)?.creditsRemaining ?? "n/a"],
                    ].map(([k, v]) => (
                      <div key={String(k)} className="session-info-row">
                        <dt>{k}</dt>
                        <dd>{v != null && v !== "" ? String(v) : "—"}</dd>
                      </div>
                    ))}
                  </dl>
                  <p className="build-muted" style={{ fontSize: 11, marginTop: 8 }}>
                    Compact: use palette /compact or send /compact to the agent.
                  </p>
                  {onReusePrompt ? (
                    <button
                      type="button"
                      className="icon-btn primary-btn sm"
                      style={{ marginTop: 8 }}
                      onClick={() => {
                        onReusePrompt("/compact ");
                        onClose();
                      }}
                    >
                      Compact context…
                    </button>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : open === "rewind" ? (
            points.length === 0 ? (
              <div className="build-empty">No rewind points yet for this session.</div>
            ) : (
              <div className="task-tree">
                {points
                  .slice()
                  .reverse()
                  .map((p) => (
                    <div key={p.promptIndex} className="task-node">
                      <span className="agent-dot st-idle" />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="task-title">Prompt #{p.promptIndex}</div>
                        <div className="task-kind">
                          {p.createdAt ? new Date(p.createdAt).toLocaleString() : "—"}
                          {p.fileCount ? ` · ${p.fileCount} files snapshotted` : ""}
                        </div>
                        {p.files?.length ? (
                          <div className="build-muted" style={{ fontSize: 11 }}>
                            {p.files.slice(0, 4).join(", ")}
                            {p.files.length > 4 ? "…" : ""}
                          </div>
                        ) : null}
                        <button
                          type="button"
                          className="icon-btn sm primary-btn"
                          style={{ marginTop: 6 }}
                          onClick={() => onRewind?.(p.promptIndex)}
                        >
                          Rewind here
                        </button>
                      </div>
                    </div>
                  ))}
              </div>
            )
          ) : open === "history" ? (
            prompts.length === 0 ? (
              <div className="build-empty">No user prompts in this session.</div>
            ) : (
              <div className="task-tree">
                {prompts.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="task-node"
                    style={{ width: "100%", textAlign: "left", cursor: "pointer" }}
                    onClick={() => {
                      onReusePrompt?.(p.content);
                      onClose();
                    }}
                  >
                    <div className="task-title" style={{ fontWeight: 500, fontSize: 12 }}>
                      {p.preview}
                    </div>
                  </button>
                ))}
              </div>
            )
          ) : (
            <div className="build-empty">Loading…</div>
          )}
        </div>
      </aside>
    </div>
  );
}

export type SessionDrawerKind = Drawer;
