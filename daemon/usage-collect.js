/**
 * Session usage collection from on-disk Grok sessions.
 * Credits: best-effort only — SuperGrok balance is not in local files.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const GROK_HOME = process.env.GROK_HOME || path.join(os.homedir(), ".grok");

function findSessionDir(sessionId, cwd) {
  const root = path.join(GROK_HOME, "sessions");
  if (!sessionId || !fs.existsSync(root)) return null;
  if (cwd) {
    const c = path.join(root, encodeURIComponent(cwd), sessionId);
    if (fs.existsSync(c)) return c;
  }
  try {
    for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const p = path.join(root, ent.name, sessionId);
      if (fs.existsSync(p)) return p;
    }
  } catch {
    /* */
  }
  return null;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Pull usage-ish fields from summary + scan updates for token events.
 */
export function collectSessionUsage(sessionId, cwd) {
  const dir = findSessionDir(sessionId, cwd);
  if (!dir) return { ok: false, error: "session not found" };

  const summary = readJson(path.join(dir, "summary.json")) || {};
  const info = summary.info || {};
  const turns =
    summary.next_trace_turn ||
    summary.num_chat_messages ||
    summary.num_messages ||
    info.turn_count ||
    null;

  let inputTokens = null;
  let outputTokens = null;
  let reasoningTokens = null;
  let contextUsed = null;
  let contextLimit = null;

  // summary nested usage
  const u = summary.usage || summary.token_usage || info.usage || null;
  if (u && typeof u === "object") {
    inputTokens = u.input ?? u.input_tokens ?? u.prompt_tokens ?? null;
    outputTokens = u.output ?? u.output_tokens ?? u.completion_tokens ?? null;
    reasoningTokens = u.reasoning ?? u.reasoning_tokens ?? null;
    contextUsed = u.context_used ?? u.context_tokens ?? null;
    contextLimit = u.context_limit ?? u.context_window ?? null;
  }

  // scan last portion of updates.jsonl for usage events
  const updatesPath = path.join(dir, "updates.jsonl");
  if (fs.existsSync(updatesPath)) {
    try {
      const raw = fs.readFileSync(updatesPath, "utf8");
      const lines = raw.trim().split("\n").slice(-200);
      for (const line of lines) {
        let j;
        try {
          j = JSON.parse(line);
        } catch {
          continue;
        }
        const blob = j.usage || j.token_usage || j.params?.usage || j.update?.usage;
        if (blob && typeof blob === "object") {
          if (blob.input != null || blob.input_tokens != null)
            inputTokens = blob.input ?? blob.input_tokens;
          if (blob.output != null || blob.output_tokens != null)
            outputTokens = blob.output ?? blob.output_tokens;
          if (blob.reasoning != null || blob.reasoning_tokens != null)
            reasoningTokens = blob.reasoning ?? blob.reasoning_tokens;
        }
      }
    } catch {
      /* */
    }
  }

  return {
    ok: true,
    sessionId,
    cwd: cwd || summary.git_root_dir || null,
    turns,
    model: summary.current_model_id || info.model || null,
    title: summary.generated_title || null,
    inputTokens,
    outputTokens,
    reasoningTokens,
    contextUsed,
    contextLimit,
    lastActiveAt: summary.last_active_at || summary.updated_at || null,
    agentName: summary.agent_name || null,
  };
}

/** Probe for account credits — currently none local; returns null remaining. */
export async function probeAccountCredits() {
  // Future: if cli-chat-proxy exposes balance, wire here.
  // Deliberately do not invent numbers.
  return {
    creditsRemaining: null,
    plan: null,
    source: "unknown",
    note: "SuperGrok remaining balance is not exposed via local CLI files. Use /usage in TUI or account console.",
  };
}
