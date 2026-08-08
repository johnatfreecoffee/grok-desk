#!/usr/bin/env node
/**
 * Weekly Feature Radar digest → Resend email
 *
 * Env (required for send):
 *   RESEND_API_KEY
 *   RADAR_DIGEST_TO
 * Optional:
 *   RADAR_DIGEST_FROM  (default: "Grok Desk Radar <onboarding@resend.dev>")
 *
 * Usage: node daemon/radar/digest.mjs [--dry]
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DRY = process.argv.includes("--dry");
const APP_SUPPORT = path.join(os.homedir(), "Library", "Application Support", "GrokDesk", "radar");
const TO = process.env.RADAR_DIGEST_TO || "";
const FROM = process.env.RADAR_DIGEST_FROM || "Grok Desk Radar <onboarding@resend.dev>";

function weekId(d = new Date()) {
  const onejan = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil(((d - onejan) / 86400000 + onejan.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${String(week).padStart(2, "0")}`;
}

function loadResendKey() {
  if (process.env.RESEND_API_KEY) return process.env.RESEND_API_KEY;
  for (const p of [
    path.join(os.homedir(), "Library", "AgentMail", "config.env"),
    path.join(os.homedir(), "Documents", "AgentMail", "config.env"),
  ]) {
    try {
      const text = fs.readFileSync(p, "utf8");
      const m = text.match(/^RESEND_API_KEY=(.+)$/m);
      if (m) return m[1].trim();
    } catch {
      /* */
    }
  }
  return null;
}

function latestSnapshot() {
  if (!fs.existsSync(APP_SUPPORT)) return null;
  const files = fs
    .readdirSync(APP_SUPPORT)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .reverse();
  if (!files.length) return null;
  return JSON.parse(fs.readFileSync(path.join(APP_SUPPORT, files[0]), "utf8"));
}

function buildBody(snap, week) {
  const props = snap?.desk_gap_proposals || [];
  const lines = [
    `GD weekly · ${week}`,
    ``,
    `Grok Build: ${snap?.local_version || snap?.binary_version || "unknown"}`,
    `Scan: ${snap?.summary || "n/a"}`,
    ``,
  ];
  if (!props.length) {
    lines.push("No proposals this week.");
  } else {
    props.forEach((p, i) => {
      lines.push(`${i + 1}. [${p.priority || "P1"}] ${p.text}`);
    });
  }
  lines.push(``);
  lines.push(`Reply: BUILD 1 3   or   BUILD all P0   or   SKIP`);
  lines.push(`(DIGEST: ${week})`);
  lines.push(``);
  lines.push(`— Grok Desk Radar`);
  return lines.join("\n");
}

async function main() {
  const week = weekId();
  const snap = latestSnapshot();
  if (!snap) {
    console.error("[digest] no radar snapshot — run scanner first");
    process.exit(1);
  }
  const subject = `GD weekly · ${week} · (DIGEST: ${week})`;
  const body = buildBody(snap, week);
  console.log(subject);
  console.log(body);

  if (DRY) {
    console.log("[digest] dry-run — not sent");
    return;
  }

  if (!TO) {
    console.error("[digest] RADAR_DIGEST_TO missing (set env to your inbox)");
    process.exit(1);
  }

  const key = loadResendKey();
  if (!key) {
    console.error("[digest] RESEND_API_KEY missing");
    process.exit(1);
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM,
      to: [TO],
      subject,
      text: body,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("[digest] send failed", res.status, data);
    process.exit(1);
  }
  console.log("[digest] sent", data.id || data);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
