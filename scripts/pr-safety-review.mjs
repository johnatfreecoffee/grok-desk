#!/usr/bin/env node
/**
 * Autonomous PR safety review — simple English summary for maintainers.
 * Reads unified diff from stdin or GITHUB_EVENT_PATH / gh pr diff.
 *
 * Exit 0 always for "comment only" mode; exit 2 if hard fail (secrets / binary).
 * Env:
 *   PR_DIFF_FILE  path to diff (optional)
 *   MODE=check|comment  default check (exit 2 on hard fails)
 */
import fs from "node:fs";
import { execSync } from "node:child_process";

const MODE = process.env.MODE || "check";

function getDiff() {
  if (process.env.PR_DIFF_FILE && fs.existsSync(process.env.PR_DIFF_FILE)) {
    return fs.readFileSync(process.env.PR_DIFF_FILE, "utf8");
  }
  if (process.env.GITHUB_BASE_REF) {
    try {
      execSync("git fetch origin " + process.env.GITHUB_BASE_REF + " --depth=50", {
        stdio: "pipe",
      });
    } catch {
      /* */
    }
    try {
      return execSync(
        `git diff origin/${process.env.GITHUB_BASE_REF}...HEAD`,
        { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
      );
    } catch (e) {
      return e.stdout?.toString?.() || "";
    }
  }
  try {
    return execSync("git diff main...HEAD", {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch {
    return "";
  }
}

/** @typedef {{ level: 'red'|'yellow'|'green', title: string, detail: string }} Finding */

const HARD = [
  {
    re: /\b(sk-[a-zA-Z0-9]{20,}|xai-[a-zA-Z0-9]{20,}|re_[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{36,}|github_pat_[a-zA-Z0-9_]{20,})\b/,
    title: "Looks like a real API key / token",
    detail: "Secrets must never go in git. Remove them and rotate the key.",
  },
  {
    re: /BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY/,
    title: "Private key material",
    detail: "Private keys cannot be merged. Delete and rotate.",
  },
  {
    re: /^\+.*\b(eval\(|child_process\.exec\(|execSync\([^'"`]*\$\{)/m,
    title: "Dangerous shell / eval pattern",
    detail: "New code runs shell or eval in a risky way. Needs a human look.",
  },
];

const SOFT = [
  {
    re: /^\+.*\.(env|pem|key)\b/m,
    title: "Might be adding a secret-looking file",
    detail: "Check it is only .env.example or docs, not real credentials.",
  },
  {
    re: /^\+.*\b(curl|fetch)\s*\([^)]*https?:\/\//m,
    title: "Talks to the network",
    detail: "New outbound HTTP. Fine if intentional — make sure URLs are safe.",
  },
  {
    re: /^\+.*\b(127\.0\.0\.1|0\.0\.0\.0|::)\b/m,
    title: "Touching bind address / localhost",
    detail: "Daemon should stay on 127.0.0.1 unless you really mean to open it.",
  },
  {
    re: /^\+.*package\.json/m,
    title: "Dependencies may have changed",
    detail: "Review new packages (name typos, unknown authors).",
  },
  {
    re: /^\+.*\b(always-approve|YOLO|bypassPermissions|GROK_ALWAYS_APPROVE)\b/m,
    title: "Permission / auto-approve behavior",
    detail: "Could make the agent more powerful by default. Confirm intent.",
  },
  {
    re: /^\+.*\.(yml|yaml)$/m,
    title: "CI / workflow files changed",
    detail: "Workflows can run with repo tokens. Read carefully.",
  },
];

function analyze(diff) {
  /** @type {Finding[]} */
  const findings = [];
  if (!diff || !diff.trim()) {
    findings.push({
      level: "yellow",
      title: "Empty or missing diff",
      detail: "Could not read the change set. Review the PR in the GitHub UI.",
    });
    return findings;
  }

  const added = diff
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .join("\n");
  const files = [...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]);

  for (const h of HARD) {
    if (h.re.test(added) || h.re.test(diff)) {
      findings.push({ level: "red", title: h.title, detail: h.detail });
    }
  }
  for (const s of SOFT) {
    if (s.re.test(added) || s.re.test(diff)) {
      findings.push({ level: "yellow", title: s.title, detail: s.detail });
    }
  }

  // Huge PR
  const addCount = (diff.match(/^\+[^+]/gm) || []).length;
  if (addCount > 800) {
    findings.push({
      level: "yellow",
      title: "Very large change",
      detail: `${addCount} added lines. Prefer smaller PRs so review stays easy.`,
    });
  }

  // Sensitive paths
  const sensitive = files.filter((f) =>
    /^(daemon\/|scripts\/|\.github\/|desktop\/)/.test(f),
  );
  if (sensitive.length) {
    findings.push({
      level: "yellow",
      title: "Touches core / install paths",
      detail: `Files: ${sensitive.slice(0, 8).join(", ")}${sensitive.length > 8 ? "…" : ""}. These can affect security.`,
    });
  }

  if (!findings.some((f) => f.level === "red") && !findings.some((f) => f.level === "yellow")) {
    findings.push({
      level: "green",
      title: "No automated red flags",
      detail: "Still skim the code — bots miss clever tricks.",
    });
  }

  return findings;
}

function simpleEnglish(findings, meta) {
  const reds = findings.filter((f) => f.level === "red");
  const yellows = findings.filter((f) => f.level === "yellow");
  const greens = findings.filter((f) => f.level === "green");

  let verdict;
  let emoji;
  if (reds.length) {
    verdict = "STOP — do not merge until fixed";
    emoji = "🛑";
  } else if (yellows.length) {
    verdict = "OK to read carefully, then decide";
    emoji = "⚠️";
  } else {
    verdict = "Looks fine to the robot";
    emoji = "✅";
  }

  const lines = [
    `## ${emoji} Auto review (simple English)`,
    ``,
    `**Verdict:** ${verdict}`,
    ``,
    `This is an **automatic** check. It does **not** replace you reading the PR.`,
    ``,
    `### What this PR is trying to do`,
    meta.title ? `- **Title:** ${meta.title}` : `- (no title)`,
    meta.author ? `- **From:** @${meta.author} (fork/PR — they cannot push to your main directly)` : `- **From:** (unknown)`,
    meta.files != null ? `- **Files touched:** ${meta.files}` : ``,
    ``,
    `### Safety notes`,
  ];

  for (const f of [...reds, ...yellows, ...greens]) {
    const tag = f.level === "red" ? "🔴" : f.level === "yellow" ? "🟡" : "🟢";
    lines.push(`- ${tag} **${f.title}** — ${f.detail}`);
  }

  lines.push(
    ``,
    `### Tenth-grader checklist for you`,
    `1. Does this change make sense for Grok Desk?`,
    `2. Any passwords, API keys, or private URLs?`,
    `3. Does it open the app to the public internet by mistake?`,
    `4. Did CI **build** pass?`,
    `5. If unsure → **don't merge** and ask a question on the PR.`,
    ``,
    `<sub>Generated by <code>scripts/pr-safety-review.mjs</code> · Grok Desk</sub>`,
  );

  return lines.filter(Boolean).join("\n");
}

const diff = getDiff();
const findings = analyze(diff);
const files = [...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]);
const meta = {
  title: process.env.PR_TITLE || "",
  author: process.env.PR_AUTHOR || "",
  files: files.length || (diff ? "?" : 0),
};
const body = simpleEnglish(findings, meta);

const outPath = process.env.GITHUB_STEP_SUMMARY;
if (outPath) {
  fs.appendFileSync(outPath, body + "\n");
}
// always print for logs / comment step
console.log(body);

const hard = findings.some((f) => f.level === "red");
if (MODE === "check" && hard) {
  process.exit(2);
}
process.exit(0);
