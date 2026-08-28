/** Silent grok-automation fence from chat (stolen idea, Desk-owned store). */

export type AutomationFence = {
  title?: string;
  prompt: string;
  frequency?: "once" | "hourly" | "daily" | "weekdays" | "weekly";
  time?: string;
  weekdays?: number[];
  enabled?: boolean;
  cwd?: string;
};

const FENCE = /```grok-automation\s*([\s\S]*?)```/i;

export function extractAutomationFence(text: string): {
  cleaned: string;
  payload: AutomationFence | null;
} {
  const m = FENCE.exec(text || "");
  if (!m) return { cleaned: text, payload: null };
  let payload: AutomationFence | null = null;
  try {
    const raw = JSON.parse(m[1].trim()) as AutomationFence;
    if (raw && typeof raw.prompt === "string" && raw.prompt.trim()) payload = raw;
  } catch {
    payload = null;
  }
  const cleaned = text.replace(FENCE, "").trim();
  return { cleaned, payload };
}
