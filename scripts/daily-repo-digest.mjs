#!/usr/bin/env node
/**
 * Daily autonomous Grok Desk repo pulse + optional PR safety scans.
 * Always produces a plain-text body (even if nothing happened).
 *
 * Env:
 *   GITHUB_TOKEN or GH_TOKEN  (gh auth also works via `gh` CLI)
 *   REPO  default johnatfreecoffee/grok-desk
 *   OUT_BODY / OUT_SUBJECT  optional paths
 *   SKIP_PR_SCAN=1  skip per-PR diff safety (faster)
 */
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = process.env.REPO || "johnatfreecoffee/grok-desk";
const ROOT = path.join(__dirname, "..");

function sh(cmd, opts = {}) {
  try {
    return execSync(cmd, {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      cwd: opts.cwd || ROOT,
      env: { ...process.env, ...opts.env },
    }).trim();
  } catch (e) {
    return (e.stdout || "").toString().trim() || "";
  }
}

function ghJson(args) {
  const raw = sh(`gh api ${args}`, {
    env: process.env.GITHUB_TOKEN
      ? { GH_TOKEN: process.env.GITHUB_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN }
      : process.env,
  });
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function daysAgoIso(n) {
  return new Date(Date.now() - n * 86400000).toISOString();
}

const since = daysAgoIso(1);
const since7 = daysAgoIso(7);

const repo = ghJson(`repos/${REPO}`) || {};
const pullsOpen = ghJson(`repos/${REPO}/pulls?state=open&per_page=20`) || [];
const pullsRecent =
  ghJson(`repos/${REPO}/pulls?state=all&sort=updated&direction=desc&per_page=15`) || [];
const issuesOpen =
  ghJson(`repos/${REPO}/issues?state=open&per_page=20`) || [];
// issues API includes PRs — filter
const issuesOnly = (Array.isArray(issuesOpen) ? issuesOpen : []).filter((i) => !i.pull_request);
const forks = ghJson(`repos/${REPO}/forks?sort=newest&per_page=30`) || [];
const commits =
  ghJson(`repos/${REPO}/commits?since=${encodeURIComponent(since)}&per_page=20`) || [];
const runs =
  ghJson(`repos/${REPO}/actions/runs?per_page=8`) || { workflow_runs: [] };
const workflowRuns = runs.workflow_runs || [];

const newForks24 = forks.filter((f) => f.created_at && f.created_at >= since);
const newForks7 = forks.filter((f) => f.created_at && f.created_at >= since7);
const pullsUpdated24 = pullsRecent.filter((p) => p.updated_at && p.updated_at >= since);
const openPrs = Array.isArray(pullsOpen) ? pullsOpen : [];

// Safety-scan each open PR (checkout not available in pure API mode — use gh pr diff)
const prReviews = [];
if (process.env.SKIP_PR_SCAN !== "1" && openPrs.length) {
  for (const p of openPrs.slice(0, 8)) {
    try {
      const diff = sh(`gh pr diff ${p.number} -R ${REPO}`);
      const diffPath = `/tmp/gd-pr-${p.number}.diff`;
      fs.writeFileSync(diffPath, diff || "");
      let review = "";
      try {
        review = execFileSync("node", [path.join(ROOT, "scripts/pr-safety-review.mjs")], {
          encoding: "utf8",
          env: {
            ...process.env,
            MODE: "comment",
            PR_DIFF_FILE: diffPath,
            PR_TITLE: p.title || "",
            PR_AUTHOR: p.user?.login || "",
          },
          maxBuffer: 5 * 1024 * 1024,
        });
      } catch (e) {
        review = (e.stdout || e.message || "").toString();
      }
      const hard = /STOP|🛑|Looks like a real API key|Private key/i.test(review);
      prReviews.push({
        number: p.number,
        title: p.title,
        author: p.user?.login,
        url: p.html_url,
        hard,
        review: review.slice(0, 2500),
      });
    } catch (e) {
      prReviews.push({
        number: p.number,
        title: p.title,
        author: p.user?.login,
        url: p.html_url,
        hard: false,
        review: `(could not diff: ${e.message})`,
      });
    }
  }
}

const dateStr = new Date().toISOString().slice(0, 10);
const hardCount = prReviews.filter((r) => r.hard).length;
const hasAction =
  openPrs.length > 0 ||
  newForks24.length > 0 ||
  pullsUpdated24.length > 0 ||
  (Array.isArray(commits) && commits.length > 0) ||
  hardCount > 0;

const subjectFlag = hardCount
  ? "STOP"
  : openPrs.length
    ? "ACTION"
    : hasAction
      ? "UPDATE"
      : "QUIET";

const subject = `[Grok Desk daily] ${subjectFlag} · ${dateStr} · ${openPrs.length} open PR(s)`;

const lines = [];
lines.push(`Grok Desk daily digest — ${dateStr}`);
lines.push(`Repo: https://github.com/${REPO}`);
lines.push(`Stars: ${repo.stargazers_count ?? "?"} · Forks: ${repo.forks_count ?? forks.length} · Open issues: ${issuesOnly.length}`);
lines.push("");
lines.push("=== VERDICT (simple) ===");
if (hardCount) {
  lines.push(`🛑 ${hardCount} open PR(s) failed the safety robot — do not merge those.`);
} else if (openPrs.length) {
  lines.push(`⚠️ You have ${openPrs.length} open PR(s) waiting for your eyes.`);
} else if (hasAction) {
  lines.push("✅ No open PRs. Some activity below — skim if curious.");
} else {
  lines.push("✅ Quiet day. Nobody forked or opened a PR. Nothing you must do.");
}
lines.push("");

lines.push("=== OPEN PULL REQUESTS ===");
if (!openPrs.length) {
  lines.push("None. You're caught up.");
} else {
  for (const p of openPrs) {
    lines.push(`#${p.number} ${p.title}`);
    lines.push(`  by @${p.user?.login} · ${p.html_url}`);
    lines.push(`  updated ${p.updated_at}`);
  }
}
lines.push("");

if (prReviews.length) {
  lines.push("=== AUTO REVIEW (each open PR) ===");
  for (const r of prReviews) {
    lines.push(`--- PR #${r.number} @${r.author}: ${r.title} ---`);
    lines.push(r.url);
    lines.push(r.review);
    lines.push("");
  }
}

lines.push("=== LAST 24 HOURS ===");
lines.push(`New forks: ${newForks24.length}`);
if (newForks24.length) {
  for (const f of newForks24) {
    lines.push(`  - @${f.owner?.login} ${f.html_url}`);
  }
}
lines.push(`PRs touched: ${pullsUpdated24.length}`);
lines.push(`Commits on default branch (API since): ${Array.isArray(commits) ? commits.length : 0}`);
if (Array.isArray(commits) && commits.length) {
  for (const c of commits.slice(0, 8)) {
    const msg = (c.commit?.message || "").split("\n")[0].slice(0, 80);
    lines.push(`  - ${c.sha?.slice(0, 7)} ${msg}`);
  }
}
lines.push("");

lines.push("=== LAST 7 DAYS FORKS ===");
lines.push(`Count: ${newForks7.length}`);
if (newForks7.length) {
  for (const f of newForks7.slice(0, 15)) {
    lines.push(`  - @${f.owner?.login} (${f.created_at?.slice(0, 10)})`);
  }
} else {
  lines.push("  None — still early / normal.");
}
lines.push("");

lines.push("=== OPEN ISSUES (non-PR) ===");
if (!issuesOnly.length) lines.push("None.");
else {
  for (const i of issuesOnly.slice(0, 10)) {
    lines.push(`#${i.number} ${i.title} · ${i.html_url}`);
  }
}
lines.push("");

lines.push("=== RECENT CI ===");
for (const w of workflowRuns.slice(0, 6)) {
  lines.push(
    `${w.conclusion || w.status} · ${w.name} · ${w.head_branch} · ${w.html_url}`,
  );
}
lines.push("");

lines.push("=== WHAT YOU SHOULD DO ===");
if (hardCount) {
  lines.push("1. Open any STOP PRs — do not merge until fixed.");
  lines.push("2. Reply to this email if you want Agent Mail to help on the PR.");
} else if (openPrs.length) {
  lines.push("1. Open each PR link, read the auto review, merge if green + sensible.");
  lines.push("2. Or reply here: e.grokdesk@freecoffee.dev (Agent Mail / grok-desk workspace).");
} else {
  lines.push("1. Nothing required. Coffee optional.");
  lines.push("2. Reply to this email anytime to task Agent Mail on the desk repo.");
}
lines.push("");
lines.push("— Grok Desk daily · autonomous · reply to e.grokdesk@freecoffee.dev");

const body = lines.join("\n");

const outBody = process.env.OUT_BODY || "/tmp/gd-daily-body.txt";
const outSubject = process.env.OUT_SUBJECT || "/tmp/gd-daily-subject.txt";
fs.writeFileSync(outBody, body);
fs.writeFileSync(outSubject, subject);
console.log(subject);
console.log(body);
console.log(`\n[wrote ${outBody}]`);
