/**
 * Live assistant turn — CLI-flavored: thinking stream, tools, agents, plan.
 */
import type { PlanEntry, ToolCallView, TurnDraft } from "../lib/turnState";
import { toolIconLabel } from "../lib/turnState";
import { MarkdownBody } from "./MarkdownBody";

function statusDot(status: string): string {
  if (status === "completed") return "ok";
  if (status === "failed" || status === "cancelled") return "err";
  if (status === "in_progress" || status === "pending") return "run";
  return "idle";
}

function ToolRow({ t, onClick }: { t: ToolCallView; onClick?: (id: string) => void }) {
  const st = statusDot(t.status);
  const kind = toolIconLabel(t);
  return (
    <div
      className={`tool-row ${t.isAgent ? "is-agent" : ""} ${st}${onClick ? " clickable" : ""}`}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick ? () => onClick(t.id) : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") onClick(t.id);
            }
          : undefined
      }
    >
      <span className={`tool-pulse ${st}`} />
      <span className={`tool-kind kind-${kind}`}>{kind}</span>
      <span className="tool-title">{t.title}</span>
      {t.description || t.detail ? (
        <span className="tool-detail">{t.description || t.detail}</span>
      ) : null}
      <span className={`tool-status st-${st}`}>{t.status.replace(/_/g, " ")}</span>
    </div>
  );
}

function PlanBlock({ plan }: { plan: PlanEntry[] }) {
  if (!plan.length) return null;
  return (
    <div className="plan-block">
      <div className="plan-head">plan</div>
      {plan.map((e, i) => (
        <div key={i} className={`plan-row st-${statusDot(e.status)}`}>
          <span className="plan-mark">
            {e.status === "completed" ? "✓" : e.status === "in_progress" ? "›" : "·"}
          </span>
          <span>{e.content}</span>
        </div>
      ))}
    </div>
  );
}

type Props = {
  draft: TurnDraft;
  streaming?: boolean;
  onToolClick?: (toolId: string) => void;
};

export function LiveTurn({ draft, streaming, onToolClick }: Props) {
  const thinking = Boolean(draft.thought);
  // Stay open while streaming (any phase) so phone shows sequence, not a blank green pulse
  const showThoughtOpen =
    streaming &&
    Boolean(draft.thought) &&
    (draft.phase === "thinking" || draft.phase === "tooling" || !draft.content);

  return (
    <div className={`live-turn ${streaming ? "streaming" : ""} phase-${draft.phase}`}>
      {thinking && (
        <details
          className="thought-panel"
          open={showThoughtOpen ? true : undefined}
        >
          <summary>
            <span className="thought-label">
              {streaming && draft.phase === "thinking" ? (
                <>
                  <span className="think-dots" aria-hidden>
                    <i />
                    <i />
                    <i />
                  </span>
                  thinking
                </>
              ) : (
                "thought"
              )}
            </span>
          </summary>
          <pre className="thought-body">{draft.thought}</pre>
        </details>
      )}

      {draft.plan.length > 0 && <PlanBlock plan={draft.plan} />}

      {draft.tools.length > 0 && (
        <div className="tools-stack">
          {draft.tools.map((t) => (
            <ToolRow key={t.id} t={t} onClick={onToolClick} />
          ))}
        </div>
      )}

      {(draft.content || streaming) && (
        <div className="bubble assistant-bubble">
          {draft.content ? (
            <MarkdownBody
              content={draft.content}
              streaming={Boolean(streaming && draft.phase === "writing")}
            />
          ) : streaming && (draft.phase === "thinking" || draft.phase === "tooling") ? (
            <span className="inline-thinking">
              <span className="think-dots">
                <i />
                <i />
                <i />
              </span>
              <span className="inline-thinking-label">
                {draft.phase === "tooling"
                  ? draft.lastActivity || "Working…"
                  : draft.lastActivity || "Thinking…"}
              </span>
            </span>
          ) : streaming ? (
            <span className="caret" />
          ) : null}
        </div>
      )}
    </div>
  );
}

/** Compact status strip under the chat while a turn is live. */
export function WorkingStrip({
  phase,
  label,
  queueLen,
  onOpenQueue,
}: {
  phase: string;
  label: string;
  queueLen: number;
  onOpenQueue?: () => void;
}) {
  return (
    <div className="working-strip">
      <span className={`work-pulse phase-${phase}`} />
      <span className="work-label">{label}</span>
      {queueLen > 0 && (
        <button type="button" className="work-queue linkish" onClick={onOpenQueue}>
          {queueLen} queued — open queue
        </button>
      )}
    </div>
  );
}
