import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { buildApi, type SlashCommand } from "../lib/buildClient";
import { ModuleInfo } from "../components/ModuleInfo";

type Props = {
  open: boolean;
  onClose: () => void;
  onAction: (action: string, cmd?: SlashCommand) => void;
};

export function CommandPalette({ open, onClose, onAction }: Props) {
  const [q, setQ] = useState("");
  const [cmds, setCmds] = useState<SlashCommand[]>([]);
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQ("");
    setIdx(0);
    void buildApi.slash().then((r) => setCmds(r.commands || [])).catch(() => setCmds([]));
    const t = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(t);
  }, [open]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return cmds.slice(0, 40);
    return cmds
      .filter((c) => {
        const hay = `${c.cmd} ${c.label} ${c.category} ${(c.aliases || []).join(" ")}`.toLowerCase();
        return hay.includes(s) || c.cmd.replace(/^\//, "").startsWith(s.replace(/^\//, ""));
      })
      .slice(0, 40);
  }, [cmds, q]);

  useEffect(() => {
    setIdx(0);
  }, [q]);

  if (!open) return null;

  const run = (c: SlashCommand) => {
    onAction(c.action, c);
    onClose();
  };

  return (
    <div className="palette-overlay" role="dialog" aria-modal="true" aria-label="Command palette">
      <button type="button" className="palette-backdrop" aria-label="Close" onClick={onClose} />
      <div className="palette-panel">
        <div className="palette-search">
          <Search size={16} strokeWidth={2} className="palette-search-icon" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search commands, skills, modules…"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                setIdx((i) => Math.min(i + 1, Math.max(0, filtered.length - 1)));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setIdx((i) => Math.max(0, i - 1));
              } else if (e.key === "Enter" && filtered[idx]) {
                e.preventDefault();
                run(filtered[idx]);
              }
            }}
          />
          <ModuleInfo moduleId="palette" compact />
        </div>
        <div className="palette-list">
          {filtered.length === 0 ? (
            <div className="palette-empty">No matches</div>
          ) : (
            filtered.map((c, i) => (
              <button
                key={c.id}
                type="button"
                className={`palette-item ${i === idx ? "active" : ""}`}
                onMouseEnter={() => setIdx(i)}
                onClick={() => run(c)}
              >
                <span className="palette-cmd">{c.cmd}</span>
                <span className="palette-label">{c.label}</span>
                <span className="palette-cat">{c.category}</span>
              </button>
            ))
          )}
        </div>
        <div className="palette-foot">
          <span>↑↓ navigate</span>
          <span>↵ run</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}
