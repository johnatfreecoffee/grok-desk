import { ListOrdered, Trash2, X } from "lucide-react";

export type QueueItem = {
  index: number;
  sessionId: string | null;
  text?: string;
  preview: string;
  clientMsgId: string | null;
  hasAttachments?: boolean;
};

type Props = {
  open: boolean;
  items: QueueItem[];
  remaining: number;
  onClose: () => void;
  onCancel: (clientMsgId: string) => void;
  onClear: () => void;
};

export function QueuePanel({ open, items, remaining, onClose, onCancel, onClear }: Props) {
  if (!open) return null;

  return (
    <div className="session-drawer-overlay" role="dialog" aria-modal="true" aria-label="Prompt queue">
      <button type="button" className="session-drawer-backdrop" aria-label="Close" onClick={onClose} />
      <aside className="session-drawer">
        <header className="session-drawer-head">
          <div className="session-drawer-title">
            <ListOrdered size={16} strokeWidth={2} />
            <h2>Queue ({remaining})</h2>
          </div>
          <button type="button" className="icon-btn sm" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div className="session-drawer-body">
          <p className="build-muted" style={{ fontSize: 12, marginBottom: 10 }}>
            Follow-ups waiting while a turn is busy. Cancel one or clear all.
          </p>
          {items.length === 0 ? (
            <div className="build-empty">Queue empty</div>
          ) : (
            <div className="task-tree">
              {items.map((it) => (
                <div key={it.clientMsgId || `${it.sessionId}-${it.index}`} className="task-node">
                  <span className="agent-dot st-working" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="task-title" style={{ fontWeight: 500, fontSize: 12 }}>
                      {it.preview || "(empty)"}
                      {it.hasAttachments ? " · 📎" : ""}
                    </div>
                    <div className="task-kind">
                      #{it.index + 1}
                      {it.sessionId ? ` · ${it.sessionId.slice(0, 8)}` : ""}
                    </div>
                    {it.clientMsgId ? (
                      <button
                        type="button"
                        className="icon-btn sm danger-btn"
                        style={{ marginTop: 6 }}
                        onClick={() => onCancel(it.clientMsgId!)}
                      >
                        Cancel
                      </button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
          {items.length > 0 ? (
            <button type="button" className="icon-btn danger-btn" style={{ marginTop: 12 }} onClick={onClear}>
              <Trash2 size={14} /> Clear queue
            </button>
          ) : null}
        </div>
      </aside>
    </div>
  );
}
