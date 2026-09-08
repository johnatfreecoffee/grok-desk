/**
 * Context window meter — `/context` and `/session-info` parity.
 *
 * Reads the feed's `context` block, which the daemon derives from the session's
 * own `signals.json`. This is the number that says a chat is about to
 * auto-compact, and it had no surface in Desk at all.
 */
import type { FeedContext } from "../lib/sessionFeed";

type Props = {
  context: FeedContext | null;
  /** Open the Context & usage drawer. */
  onOpen?: () => void;
};

/**
 * `signals.json` writes `contextWindowUsage` as whole percent (48 = 48% of a
 * 500k window). Fall back to tokens/window when the field is missing.
 */
export function contextPct(context: FeedContext | null): number | null {
  if (!context) return null;
  const raw = Number(context.usagePct);
  if (context.usagePct != null && Number.isFinite(raw)) {
    return Math.max(0, Math.min(100, raw));
  }
  const used = Number(context.tokensUsed);
  const win = Number(context.windowTokens);
  if (Number.isFinite(used) && Number.isFinite(win) && win > 0) {
    return Math.max(0, Math.min(100, (used / win) * 100));
  }
  return null;
}

export function contextLevel(pct: number): "ok" | "warn" | "err" {
  if (pct >= 85) return "err";
  if (pct >= 60) return "warn";
  return "ok";
}

export function formatTokens(n: number | null | undefined): string {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return "—";
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${Math.round(v / 1000)}k`;
  return String(Math.round(v));
}

export function ContextMeter({ context, onOpen }: Props) {
  const pct = contextPct(context);
  if (pct == null) return null;
  const level = contextLevel(pct);
  const used = formatTokens(context?.tokensUsed);
  const win = formatTokens(context?.windowTokens);
  const label = `Context ${Math.round(pct)}% — ${used} of ${win} tokens${
    level === "err" ? " · close to auto-compact" : ""
  }`;
  return (
    <button
      type="button"
      className={`ctx-meter ${level}`}
      onClick={onOpen}
      title={label}
      aria-label={label}
    >
      <span className="ctx-meter-bar" aria-hidden>
        <span className="ctx-meter-fill" style={{ width: `${Math.max(3, Math.round(pct))}%` }} />
      </span>
      <span className="ctx-meter-pct">{Math.round(pct)}%</span>
    </button>
  );
}
