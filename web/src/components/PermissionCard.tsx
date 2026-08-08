import { AlertTriangle, Check, Shield, X } from "lucide-react";

export type PermissionRequest = {
  requestId: string;
  workerId?: string;
  sessionId?: string | null;
  title: string;
  detail?: string;
  options?: { optionId: string; name: string; kind?: string | null }[];
};

type Props = {
  request: PermissionRequest | null;
  onRespond: (
    decision: "allow" | "allow_always" | "deny",
    optionId?: string,
    pattern?: string,
  ) => void;
};

export function PermissionCard({ request, onRespond }: Props) {
  if (!request) return null;

  const opts = request.options || [];
  const allowOnce =
    opts.find((o) => /once/i.test(o.optionId) && /allow/i.test(o.optionId)) ||
    opts.find((o) => /allow/i.test(o.name) && /once/i.test(o.name));
  const allowAlways =
    opts.find((o) => /always/i.test(o.optionId)) ||
    opts.find((o) => /always/i.test(o.name));
  const deny =
    opts.find((o) => /reject|deny/i.test(o.optionId)) ||
    opts.find((o) => /reject|deny/i.test(o.name));

  return (
    <div className="perm-overlay" role="dialog" aria-modal="true" aria-label="Permission required">
      <div className="perm-card">
        <div className="perm-head">
          <Shield size={18} strokeWidth={2.25} className="perm-icon" />
          <div>
            <div className="perm-kicker">Permission required</div>
            <h2 className="perm-title">{request.title}</h2>
          </div>
        </div>
        {request.detail ? (
          <pre className="perm-detail">{request.detail}</pre>
        ) : (
          <div className="perm-detail muted">
            <AlertTriangle size={14} /> Agent wants to run a tool
          </div>
        )}
        {(request.sessionId || request.workerId) && (
          <div className="perm-meta">
            {request.workerId ? <span>{request.workerId}</span> : null}
            {request.sessionId ? <span>{request.sessionId.slice(0, 8)}</span> : null}
          </div>
        )}
        <div className="perm-actions">
          <button
            type="button"
            className="icon-btn primary-btn"
            onClick={() => onRespond("allow", allowOnce?.optionId)}
          >
            <Check size={14} /> Allow once
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => {
              // Remember first word of title as pattern (e.g. shell / bash command prefix)
              const pat =
                (request.detail || request.title || "")
                  .split(/\s+/)
                  .slice(0, 2)
                  .join(" ")
                  .trim() || request.title;
              onRespond("allow_always", allowAlways?.optionId, pat);
            }}
          >
            Always allow
          </button>
          <button
            type="button"
            className="icon-btn danger-btn"
            onClick={() => onRespond("deny", deny?.optionId)}
          >
            <X size={14} /> Deny
          </button>
        </div>
        <div className="perm-foot">1 allow · 2 always · 3 deny · Esc deny</div>
      </div>
    </div>
  );
}
