import { useState } from "react";
import { GitBranch, X } from "lucide-react";

type Props = {
  open: boolean;
  cwd?: string | null;
  onClose: () => void;
  onFork: (opts: { worktree: boolean; name?: string; prompt?: string }) => void;
};

export function ForkDialog({ open, cwd, onClose, onFork }: Props) {
  const [worktree, setWorktree] = useState(false);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");

  if (!open) return null;

  return (
    <div className="module-info-overlay" role="dialog" aria-modal="true" aria-label="Fork session">
      <div className="module-info-backdrop" aria-hidden />
      <div className="module-info-modal" style={{ maxHeight: "auto" }}>
        <header className="module-info-head">
          <div>
            <div className="module-info-kicker">Session</div>
            <h2>Fork / new branch of work</h2>
            <p className="module-info-summary">
              Start a parallel agent in the same project
              {worktree ? " inside a new git worktree" : ""}.
            </p>
          </div>
          <button type="button" className="icon-btn sm" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div className="module-info-body">
          <p className="build-muted" style={{ fontSize: 12, marginBottom: 10 }}>
            cwd: {cwd || "—"}
          </p>
          <label className="fork-check">
            <input type="checkbox" checked={worktree} onChange={(e) => setWorktree(e.target.checked)} />
            Create git worktree (isolated folder)
          </label>
          {worktree ? (
            <input
              className="build-search"
              style={{ maxWidth: "100%" }}
              placeholder="Worktree name (e.g. feat-auth)"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          ) : null}
          <input
            className="build-search"
            style={{ maxWidth: "100%" }}
            placeholder="Optional first prompt for the forked agent"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </div>
        <footer className="module-info-foot">
          <button
            type="button"
            className="icon-btn primary-btn"
            onClick={() => {
              onFork({
                worktree,
                name: name.trim() || undefined,
                prompt: prompt.trim() || undefined,
              });
              onClose();
            }}
          >
            <GitBranch size={14} /> Fork
          </button>
          <button type="button" className="icon-btn" onClick={onClose}>
            Cancel
          </button>
        </footer>
      </div>
    </div>
  );
}
