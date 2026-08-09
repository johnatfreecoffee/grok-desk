#!/usr/bin/env node
/**
 * Send Grok Desk review / pulse email via Resend (Agent Mail domain).
 *
 * Env:
 *   RESEND_API_KEY   (required)
 *   NOTIFY_FROM      default: Grok Desk <e.grokdesk@freecoffee.dev>
 *   NOTIFY_TO        default: johnfrankromanojr@gmail.com
 *   SUBJECT          required unless --subject=
 *   BODY_FILE        path to markdown/plain body (or stdin)
 *   REPLY_TO         optional
 *
 * Usage:
 *   SUBJECT="..." node scripts/mail-notify.mjs < body.md
 *   node scripts/mail-notify.mjs --subject "hi" --body-file /tmp/x.md
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadResendKey() {
  if (process.env.RESEND_API_KEY) return process.env.RESEND_API_KEY.trim();
  for (const p of [
    path.join(os.homedir(), "Library", "AgentMail", "config.env"),
    path.join(os.homedir(), "Documents", "AgentMail", "config.env"),
  ]) {
    try {
      const m = fs.readFileSync(p, "utf8").match(/^RESEND_API_KEY=(.+)$/m);
      if (m) return m[1].trim();
    } catch {
      /* */
    }
  }
  return null;
}

function arg(name, fallback = "") {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const FROM =
  process.env.NOTIFY_FROM ||
  arg("--from", "Grok Desk <e.grokdesk@freecoffee.dev>");
const TO =
  process.env.NOTIFY_TO || arg("--to", "johnfrankromanojr@gmail.com");
const SUBJECT = process.env.SUBJECT || arg("--subject", "");
const bodyFile = process.env.BODY_FILE || arg("--body-file", "");
const REPLY_TO = process.env.REPLY_TO || arg("--reply-to", "e.grokdesk@freecoffee.dev");
const DRY = process.argv.includes("--dry");

let body = "";
if (bodyFile && fs.existsSync(bodyFile)) {
  body = fs.readFileSync(bodyFile, "utf8");
} else if (!process.stdin.isTTY) {
  body = fs.readFileSync(0, "utf8");
}

if (!SUBJECT.trim()) {
  console.error("mail-notify: SUBJECT required");
  process.exit(1);
}
if (!body.trim()) {
  console.error("mail-notify: empty body");
  process.exit(1);
}

const key = loadResendKey();
if (!key) {
  console.error("mail-notify: RESEND_API_KEY missing");
  process.exit(1);
}

// Strip HTML-ish markdown fences for plain text; keep simple markdown readable
const text = body
  .replace(/^##+\s*/gm, "")
  .replace(/\*\*/g, "")
  .replace(/<!--[\s\S]*?-->/g, "")
  .trim();

const payload = {
  from: FROM,
  to: [TO],
  subject: SUBJECT.trim(),
  text,
  reply_to: REPLY_TO,
};

if (DRY) {
  console.log(JSON.stringify({ ...payload, text: text.slice(0, 400) }, null, 2));
  process.exit(0);
}

const res = await fetch("https://api.resend.com/emails", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(payload),
});
const data = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error("mail-notify: send failed", res.status, data);
  process.exit(1);
}
console.log("mail-notify: sent", data.id || data);
