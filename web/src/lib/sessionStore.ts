/**
 * Session identity helpers.
 *
 * P3 deleted the transcript half of this module. `SessionStore`,
 * `hydrateMessages`, `applyUpdate`, `applyTurnEnd`, `stash`, `setMessages`,
 * `isViewing` and `isLive` were a second, never-reconciled copy of the chat —
 * `lib/sessionFeed.ts` now folds the daemon's cursor-based feed into the one
 * transcript the UI renders. What is left here is identity only: is this a
 * pending id, a mail thread, and may this event paint onto the viewed chat.
 *
 * Isolation rule that survived: an event without a sessionId is dropped, and an
 * event whose sessionId is not the viewed one never paints. Never fall back to
 * "current view".
 */

const PENDING_PREFIX = "pending:";

/** Local id for a chat the daemon has not named yet (New → first prompt). */
export function createPendingId(): string {
  return `${PENDING_PREFIX}${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function isPendingId(id: string | null | undefined): boolean {
  return Boolean(id && String(id).startsWith(PENDING_PREFIX));
}

export function isMailSession(id: string | null | undefined): boolean {
  return Boolean(id && String(id).startsWith("mail:"));
}

/** Paint only when both ids are known and equal. Never fall back to "current view". */
export function shouldPaint(
  viewingId: string | null | undefined,
  eventSessionId: string | null | undefined,
): boolean {
  if (!viewingId || !eventSessionId) return false;
  return String(viewingId) === String(eventSessionId);
}
