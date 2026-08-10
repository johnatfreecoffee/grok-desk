import { useEffect, useId, useState } from "react";
import { Info, X } from "lucide-react";
import { getModuleHelp, type ModuleHelp } from "../lib/moduleHelp";

type Props = {
  /** Key into MODULE_HELP */
  moduleId: string;
  /** Compact icon for tight toolbars */
  compact?: boolean;
  className?: string;
  /** Optional override copy */
  help?: ModuleHelp;
  /** Controlled open (optional) */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Hide the trigger button (modal still works when open is controlled) */
  hideTrigger?: boolean;
};

/**
 * Info button + modal. Closes via backdrop, Esc, X, Got it, or re-tap Info.
 */
export function ModuleInfo({
  moduleId,
  compact,
  className = "",
  help: helpProp,
  open: openProp,
  onOpenChange,
  hideTrigger,
}: Props) {
  const [internalOpen, setInternalOpen] = useState(false);
  const controlled = openProp !== undefined;
  const open = controlled ? openProp : internalOpen;
  const titleId = useId();
  const help = helpProp || getModuleHelp(moduleId);

  const setOpen = (next: boolean) => {
    if (!controlled) setInternalOpen(next);
    onOpenChange?.(next);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setOpen identity not needed
  }, [open, controlled]);

  return (
    <>
      {!hideTrigger ? (
        <button
          type="button"
          className={`module-info-btn ${compact ? "sm" : ""} ${className}`.trim()}
          title={`About ${help.title}`}
          aria-label={`About ${help.title}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <Info size={compact ? 14 : 16} strokeWidth={2.25} />
          {!compact ? <span className="module-info-label">Info</span> : null}
        </button>
      ) : null}

      {open ? (
        <div className="module-info-overlay" role="presentation">
          <button
            type="button"
            className="module-info-backdrop"
            aria-label="Close help"
            onClick={() => setOpen(false)}
          />
          <div
            className="module-info-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
          >
            <header className="module-info-head">
              <div>
                <div className="module-info-kicker">How this works</div>
                <h2 id={titleId}>{help.title}</h2>
                <p className="module-info-summary">{help.summary}</p>
              </div>
              <button
                type="button"
                className="icon-btn sm module-info-close"
                aria-label="Close help"
                onClick={() => setOpen(false)}
              >
                <X size={18} strokeWidth={2} />
              </button>
            </header>

            <div className="module-info-body">
              <section>
                <h3>What it does</h3>
                <p>{help.what}</p>
              </section>
              <section>
                <h3>How to use it</h3>
                <ol>
                  {help.how.map((step, i) => (
                    <li key={i}>{step}</li>
                  ))}
                </ol>
              </section>
              {help.tips && help.tips.length > 0 ? (
                <section>
                  <h3>Tips</h3>
                  <ul>
                    {help.tips.map((t, i) => (
                      <li key={i}>{t}</li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </div>

            <footer className="module-info-foot">
              <button type="button" className="icon-btn primary-btn" onClick={() => setOpen(false)}>
                Got it
              </button>
              <span className="module-info-foot-hint">
                Esc, tap outside, or Got it to close · reopen anytime with Info
              </span>
            </footer>
          </div>
        </div>
      ) : null}
    </>
  );
}
