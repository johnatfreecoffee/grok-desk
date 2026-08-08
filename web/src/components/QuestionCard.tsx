import { useEffect, useMemo, useState } from "react";
import { Check, HelpCircle, MessageSquare, SkipForward, X } from "lucide-react";

export type QuestionOption = {
  id: string;
  label: string;
  description?: string;
  preview?: string | null;
};

export type QuestionItem = {
  id: string;
  question: string;
  multiSelect?: boolean;
  options: QuestionOption[];
};

export type QuestionRequest = {
  requestId: string;
  workerId?: string;
  sessionId?: string | null;
  questions: QuestionItem[];
};

type Props = {
  request: QuestionRequest | null;
  onRespond: (payload: {
    action: "accept" | "skip" | "chat";
    answers?: (string | string[])[];
  }) => void;
};

/**
 * ask_user_question card — multi-question choice UI (TUI parity).
 * Always includes free-text "Other" per question.
 */
export function QuestionCard({ request, onRespond }: Props) {
  const questions = request?.questions || [];
  const [idx, setIdx] = useState(0);
  /** per-question: selected labels (multi) or single label */
  const [picks, setPicks] = useState<Record<number, string[]>>({});
  const [other, setOther] = useState<Record<number, string>>({});
  const [useOther, setUseOther] = useState<Record<number, boolean>>({});

  useEffect(() => {
    setIdx(0);
    setPicks({});
    setOther({});
    setUseOther({});
  }, [request?.requestId]);

  const q = questions[idx];
  const multi = Boolean(q?.multiSelect);
  const selected = picks[idx] || [];
  const doneCount = useMemo(() => {
    let n = 0;
    for (let i = 0; i < questions.length; i++) {
      if (useOther[i] && (other[i] || "").trim()) n++;
      else if ((picks[i] || []).length > 0) n++;
    }
    return n;
  }, [questions.length, picks, other, useOther]);

  if (!request || !q) return null;

  const toggle = (label: string) => {
    setUseOther((u) => ({ ...u, [idx]: false }));
    setPicks((prev) => {
      const cur = prev[idx] || [];
      if (multi) {
        const has = cur.includes(label);
        return { ...prev, [idx]: has ? cur.filter((x) => x !== label) : [...cur, label] };
      }
      return { ...prev, [idx]: [label] };
    });
  };

  const answerFor = (i: number): string | string[] | null => {
    if (useOther[i] && (other[i] || "").trim()) return other[i].trim();
    const p = picks[i] || [];
    if (!p.length) return null;
    const mq = questions[i]?.multiSelect;
    return mq ? p : p[0];
  };

  const canAdvance = answerFor(idx) != null;

  const submit = () => {
    const answers: (string | string[])[] = [];
    for (let i = 0; i < questions.length; i++) {
      const a = answerFor(i);
      if (a == null) {
        // incomplete — jump to first missing
        setIdx(i);
        return;
      }
      answers.push(a);
    }
    onRespond({ action: "accept", answers });
  };

  const next = () => {
    if (!canAdvance) return;
    if (idx < questions.length - 1) setIdx(idx + 1);
    else submit();
  };

  return (
    <div className="perm-overlay qcard-overlay" role="dialog" aria-modal="true" aria-label="Question">
      <div className="perm-card qcard">
        <div className="perm-head">
          <HelpCircle size={18} strokeWidth={2.25} className="perm-icon" />
          <div>
            <div className="perm-kicker">
              Question {idx + 1} of {questions.length}
              {doneCount ? ` · ${doneCount} answered` : ""}
            </div>
            <h2 className="perm-title">{q.question}</h2>
          </div>
        </div>

        <div className="qcard-options">
          {q.options.map((o) => {
            const on = selected.includes(o.label) && !useOther[idx];
            return (
              <button
                key={o.id}
                type="button"
                className={`qcard-opt ${on ? "on" : ""}`}
                onClick={() => toggle(o.label)}
              >
                <span className="qcard-opt-label">{o.label}</span>
                {o.description ? <span className="qcard-opt-desc">{o.description}</span> : null}
                {o.preview ? <pre className="qcard-opt-preview">{o.preview}</pre> : null}
              </button>
            );
          })}
          <button
            type="button"
            className={`qcard-opt ${useOther[idx] ? "on" : ""}`}
            onClick={() => {
              setUseOther((u) => ({ ...u, [idx]: true }));
              setPicks((p) => ({ ...p, [idx]: [] }));
            }}
          >
            <span className="qcard-opt-label">Other</span>
            <span className="qcard-opt-desc">Type your own answer</span>
          </button>
          {useOther[idx] ? (
            <input
              className="build-search"
              autoFocus
              placeholder="Your answer…"
              value={other[idx] || ""}
              onChange={(e) => setOther((o) => ({ ...o, [idx]: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  next();
                }
              }}
            />
          ) : null}
        </div>

        <div className="perm-actions qcard-actions">
          <button type="button" className="icon-btn sm" disabled={idx === 0} onClick={() => setIdx((i) => i - 1)}>
            Back
          </button>
          <button
            type="button"
            className="icon-btn primary-btn"
            disabled={!canAdvance}
            onClick={() => next()}
          >
            <Check size={14} /> {idx < questions.length - 1 ? "Next" : "Submit"}
          </button>
          <button type="button" className="icon-btn sm" onClick={() => onRespond({ action: "chat" })}>
            <MessageSquare size={14} /> Chat
          </button>
          <button type="button" className="icon-btn sm" onClick={() => onRespond({ action: "skip" })}>
            <SkipForward size={14} /> Skip
          </button>
          <button type="button" className="icon-btn sm danger-btn" onClick={() => onRespond({ action: "skip" })}>
            <X size={14} />
          </button>
        </div>
        <div className="perm-foot">Enter next · Esc skip · multi-select = click several</div>
      </div>
    </div>
  );
}

export type PlanApprovalRequest = {
  requestId: string;
  workerId?: string;
  sessionId?: string | null;
  plan: string;
};

type PlanProps = {
  request: PlanApprovalRequest | null;
  onRespond: (payload: { action: "approve" | "reject"; reason?: string; planContent?: string }) => void;
};

export function PlanApprovalCard({ request, onRespond }: PlanProps) {
  const [reason, setReason] = useState("");
  useEffect(() => {
    setReason("");
  }, [request?.requestId]);
  if (!request) return null;
  return (
    <div className="perm-overlay" role="dialog" aria-modal="true" aria-label="Plan approval">
      <div className="perm-card plan-approve-card">
        <div className="perm-head">
          <HelpCircle size={18} strokeWidth={2.25} className="perm-icon" />
          <div>
            <div className="perm-kicker">Exit plan mode</div>
            <h2 className="perm-title">Approve this plan?</h2>
          </div>
        </div>
        <pre className="perm-detail plan-approve-body">{request.plan || "(empty plan)"}</pre>
        <input
          className="build-search"
          placeholder="Rejection reason (optional)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <div className="perm-actions">
          <button
            type="button"
            className="icon-btn primary-btn"
            onClick={() => onRespond({ action: "approve", planContent: request.plan })}
          >
            <Check size={14} /> Approve & implement
          </button>
          <button
            type="button"
            className="icon-btn danger-btn"
            onClick={() => onRespond({ action: "reject", reason: reason || "revise" })}
          >
            <X size={14} /> Reject
          </button>
        </div>
      </div>
    </div>
  );
}
