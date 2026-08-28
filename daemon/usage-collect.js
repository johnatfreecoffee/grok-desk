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
  const signals = readJson(path.join(dir, "signals.json")) || {};
  const info = summary.info || {};
  const turns =
    summary.next_trace_turn ||
    summary.num_chat_messages ||
    summary.num_messages ||
    info.turn_count ||
    signals.turnCount ||
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
  if (contextUsed == null && signals.contextTokensUsed != null) {
    contextUsed = signals.contextTokensUsed;
  }
  if (contextLimit == null && signals.contextWindowTokens != null) {
    contextLimit = signals.contextWindowTokens;
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

function readOfficialAuth() {
  const authPath = path.join(GROK_HOME, "auth.json");
  const raw = readJson(authPath);
  if (!raw || typeof raw !== "object") return null;
  const rec = Object.values(raw).find((v) => v && typeof v === "object" && v.key);
  if (!rec) return null;
  return {
    token: rec.key,
    email: rec.email || null,
    userId: rec.user_id || rec.principal_id || null,
    expiresAt: rec.expires_at || null,
  };
}

function mapTier(raw) {
  if (!raw) return null;
  const s = String(raw);
  if (/heavy/i.test(s) || s === "SuperGrokPro") return "SuperGrok Heavy";
  if (/super/i.test(s)) return "SuperGrok";
  return s;
}

/**
 * SuperGrok quota — official CLI billing JSON. Never invent remaining $.
 * Token stays on the daemon; UI only sees redacted numbers.
 */
export async function probeAccountCredits() {
  const auth = readOfficialAuth();
  if (!auth?.token) {
    return {
      creditsRemaining: null,
      usedPercent: null,
      remainingPercent: null,
      plan: null,
      email: null,
      source: "unsigned",
      products: [],
      periodStart: null,
      periodEnd: null,
      note: "Sign in with grok login to read SuperGrok quota.",
    };
  }

  const headers = {
    Authorization: `Bearer ${auth.token}`,
    "x-grok-client-mode": "cli",
    Accept: "application/json",
  };

  let billing = null;
  let settings = null;
  try {
    const r = await fetch("https://cli-chat-proxy.grok.com/v1/billing?format=credits", {
      headers,
    });
    if (r.ok) billing = await r.json();
  } catch {
    /* */
  }
  try {
    const r = await fetch("https://cli-chat-proxy.grok.com/v1/settings", { headers });
    if (r.ok) settings = await r.json();
  } catch {
    /* */
  }

  const cfg = billing?.config || billing || {};
  const usedPercent =
    typeof cfg.creditUsagePercent === "number"
      ? cfg.creditUsagePercent
      : typeof billing?.creditUsagePercent === "number"
        ? billing.creditUsagePercent
        : null;
  const products = Array.isArray(cfg.productUsage || billing?.productUsage)
    ? (cfg.productUsage || billing.productUsage).map((p) => ({
        name: p.name || p.product || p.id || "usage",
        usedPercent: p.creditUsagePercent ?? p.usedPercent ?? null,
        remaining: p.remaining ?? p.creditsRemaining ?? null,
      }))
    : [];
  const plan =
    mapTier(settings?.subscription_tier_display) ||
    mapTier(settings?.subscriptionTier) ||
    mapTier(cfg.subscriptionTier) ||
    null;

  if (usedPercent == null && !products.length) {
    return {
      creditsRemaining: null,
      usedPercent: null,
      remainingPercent: null,
      plan,
      email: auth.email,
      source: "cli-unreadable",
      products: [],
      periodStart: cfg.periodStart || cfg.period_start || null,
      periodEnd: cfg.periodEnd || cfg.period_end || null,
      note: "CLI signed in, but billing did not return a remaining balance.",
    };
  }

  const remainingPercent =
    usedPercent != null ? Math.max(0, Math.min(100, 100 - usedPercent)) : null;

  return {
    creditsRemaining: cfg.creditsRemaining ?? billing?.creditsRemaining ?? null,
    usedPercent,
    remainingPercent,
    plan,
    email: auth.email,
    source: "cli-billing",
    products,
    periodStart: cfg.periodStart || cfg.period_start || null,
    periodEnd: cfg.periodEnd || cfg.period_end || null,
    note: null,
  };
}

/** Local activity heatmap from session mtimes — not SuperGrok billing. */
export function collectUsageHeatmap(days = 112) {
  const root = path.join(GROK_HOME, "sessions");
  const byDay = new Map();
  const cutoff = Date.now() - days * 86400000;
  if (!fs.existsSync(root)) return { days: [], max: 0 };

  const walk = (dir, depth) => {
    if (depth > 3) return;
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      if (!ent.isDirectory()) continue;
      const p = path.join(dir, ent.name);
      const summary = readJson(path.join(p, "summary.json"));
      if (summary) {
        const ts = Date.parse(
          summary.last_active_at || summary.updated_at || summary.created_at || "",
        );
        let when = Number.isFinite(ts) ? ts : 0;
        if (!when) {
          try {
            when = fs.statSync(path.join(p, "summary.json")).mtimeMs;
          } catch {
            when = 0;
          }
        }
        if (when >= cutoff) {
          const day = new Date(when).toISOString().slice(0, 10);
          const prev = byDay.get(day) || { date: day, sessions: 0, tokens: 0 };
          prev.sessions += 1;
          const u = summary.usage || summary.token_usage || {};
          const tok =
            Number(u.input || u.input_tokens || 0) +
            Number(u.output || u.output_tokens || 0);
          prev.tokens += tok;
          byDay.set(day, prev);
        }
        continue;
      }
      walk(p, depth + 1);
    }
  };
  walk(root, 0);

  const out = [];
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  let max = 0;
  for (let i = 0; i < days; i++) {
    const d = new Date(start.getTime());
    d.setDate(start.getDate() + i);
    const key = d.toISOString().slice(0, 10);
    const row = byDay.get(key) || { date: key, sessions: 0, tokens: 0 };
    max = Math.max(max, row.sessions);
    out.push(row);
  }
  return { days: out, max };
}
