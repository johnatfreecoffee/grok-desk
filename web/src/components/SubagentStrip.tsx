/**
 * Subagent strip — every child agent for the viewed session, at the top of the
 * chat, the way the terminal shows them.
 *
 * Source is the feed's `subagents[]` (merged `subagent_spawned` /
 * `subagent_finished` events + `subagents/<childId>/meta.json` and
 * `output.json`). Background *shell* tasks are a different thing entirely and
 * live in the artifacts rail — never here.
 *
 * Shape rules, because this sits above the transcript:
 *   - Nothing on screen when the session has no subagents. No spacer, no border.
 *   - Collapsed is ONE 44px rail that scrolls sideways, whatever the count.
 *   - Expanding is opt-in and capped, so 83 children never push the
 *     conversation off a phone.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, CornerDownRight, FileText, Users } from "lucide-react";
import type { FeedSubagent } from "../lib/sessionFeed";
import { formatDuration } from "../lib/turnState";

type Props = {
  subagents: FeedSubagent[];
  /** Parent session cwd — the fallback when a child has no `childCwd`. */
  cwd?: string | null;
  /** Open the child session in the chat pane. */
  onOpenChild: (childSessionId: string, cwd: string | null, title: string) => void;
};

/** meta.json / event status → the `agent-dot` / `st-` classes Desk already has. */
function statusCls(status?: string | null): string {
  const s = String(status || "").toLowerCase();
  if (s === "running" || s === "in_progress" || s === "started") return "working";
  if (s === "completed" || s === "success" || s === "done") return "completed";
  if (s === "failed" || s === "error") return "failed";
  if (s === "cancelled" || s === "canceled" || s === "aborted") return "failed";
  return "idle";
}

function statusLabel(status?: string | null): string {
  const s = String(status || "").toLowerCase();
  if (!s) return "unknown";
  return s.replace(/_/g, " ");
}

function shortType(type?: string | null): string {
  const t = String(type || "").trim();
  return t || "agent";
}

function subagentTitle(s: FeedSubagent): string {
  const d = String(s.description || "").replace(/\s+/g, " ").trim();
  if (d) return d;
  return String(s.childSessionId || s.id || "subagent").slice(0, 12);
}

/** started_at is an ISO string on disk and an epoch ms from the event log. */
function startedMs(s: FeedSubagent): number {
  const v = s.startedAt;
  if (typeof v === "number") return v;
  const t = Date.parse(String(v || ""));
  return Number.isFinite(t) ? t : 0;
}

export function SubagentStrip({ subagents, cwd, onOpenChild }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [reportFor, setReportFor] = useState<string | null>(null);
  const railRef = useRef<HTMLDivElement | null>(null);

  const rows = useMemo(
    () => [...(subagents || [])].sort((a, b) => startedMs(a) - startedMs(b)),
    [subagents],
  );
  const running = useMemo(
    () => rows.filter((s) => statusCls(s.status) === "working").length,
    [rows],
  );

  // A new child arriving WHILE you watch should be the one in view. Opening a
  // finished chat should not — that would drop you mid-rail with a chip sliced
  // in half at the left edge.
  const count = rows.length;
  const prevCount = useRef(0);
  useEffect(() => {
    const el = railRef.current;
    const grew = prevCount.current > 0 && count > prevCount.current;
    prevCount.current = count;
    if (!el || !grew) return;
    el.scrollLeft = el.scrollWidth;
  }, [count]);

  useEffect(() => {
    if (!expanded) setReportFor(null);
  }, [expanded]);

  // Switching chats resets the rail — a different session's scroll position is
  // meaningless here.
  const firstId = rows[0]?.id;
  useEffect(() => {
    prevCount.current = 0;
    if (railRef.current) railRef.current.scrollLeft = 0;
    setExpanded(false);
  }, [firstId]);

  if (!rows.length) return null;

  const open = (s: FeedSubagent) => {
    const child = String(s.childSessionId || s.id || "");
    if (!child) return;
    onOpenChild(child, (s.childCwd as string | null) || cwd || null, subagentTitle(s));
  };

  return (
    <div className="subagent-strip" aria-label="Subagents">
      <div className="subagent-rail-row">
        <button
          type="button"
          className={`subagent-lead${expanded ? " open" : ""}`}
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          title={expanded ? "Hide subagent list" : "Show every subagent"}
        >
          <Users size={13} strokeWidth={2.25} />
          <span className="subagent-lead-label">Agents</span>
          <span className="subagent-count">{rows.length}</span>
          {running > 0 ? <span className="subagent-running">{running} running</span> : null}
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>

        <div className="subagent-rail" ref={railRef}>
          {rows.map((s) => {
            const cls = statusCls(s.status);
            const dur = formatDuration(s.durationMs);
            return (
              <button
                key={String(s.id)}
                type="button"
                className={`subagent-chip st-${cls}`}
                onClick={() => open(s)}
                title={`${shortType(s.type)} · ${statusLabel(s.status)}\n${subagentTitle(s)}\n\nOpen this child session`}
              >
                <span className={`agent-dot st-${cls}`} aria-hidden />
                <span className="subagent-chip-body">
                  <span className="subagent-chip-type">{shortType(s.type)}</span>
                  <span className="subagent-chip-desc">{subagentTitle(s)}</span>
                </span>
                <span className="subagent-chip-meta">
                  {dur ? <span>{dur}</span> : null}
                  {s.toolCalls != null ? <span>{s.toolCalls}t</span> : null}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {expanded ? (
        <div className="subagent-panel">
          <div className="task-tree">
            {rows.map((s) => {
              const cls = statusCls(s.status);
              const dur = formatDuration(s.durationMs);
              const id = String(s.id);
              const showing = reportFor === id;
              const report = typeof s.output === "string" ? s.output : "";
              return (
                <div key={id} className={`task-node subagent-node st-${cls}`}>
                  <span className={`agent-dot st-${cls}`} aria-hidden />
                  <div className="subagent-node-body">
                    <div className="task-title">{subagentTitle(s)}</div>
                    <div className="task-kind">
                      {shortType(s.type)} · {statusLabel(s.status)}
                      {dur ? ` · ${dur}` : ""}
                      {s.toolCalls != null ? ` · ${s.toolCalls} tools` : ""}
                      {s.turns != null ? ` · ${s.turns} turns` : ""}
                      {s.model ? ` · ${s.model}` : ""}
                    </div>
                    <div className="subagent-node-actions">
                      <button
                        type="button"
                        className="icon-btn sm"
                        onClick={() => open(s)}
                        title="Open this child session in the chat pane"
                      >
                        <CornerDownRight size={13} strokeWidth={2.25} />
                        <span>Open session</span>
                      </button>
                      {report || s.outputTooLarge ? (
                        <button
                          type="button"
                          className={`icon-btn sm${showing ? " primary-btn" : ""}`}
                          onClick={() => setReportFor(showing ? null : id)}
                          aria-expanded={showing}
                          title="output.json — the report this agent handed back"
                        >
                          <FileText size={13} strokeWidth={2.25} />
                          <span>{showing ? "Hide report" : "Report"}</span>
                        </button>
                      ) : null}
                    </div>
                    {showing ? (
                      s.outputTooLarge ? (
                        <div className="build-empty subagent-report">
                          Report is {Math.round(Number(s.outputBytes || 0) / 1024)} KB — too
                          large to inline. Open the child session to read it.
                        </div>
                      ) : (
                        <pre className="subagent-report artifact-output">{report}</pre>
                      )
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
