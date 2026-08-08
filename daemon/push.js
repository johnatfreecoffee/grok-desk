/**
 * Web Push for phone PWA — no cloud DB.
 * VAPID + subscriptions live under Application Support.
 */
import fs from "node:fs";
import path from "node:path";
import webpush from "web-push";
import { ensureUserDataMigrated, userDataPath } from "./user-data.js";
import { loadSecrets, saveSecrets } from "./secrets.js";
import { loadSettings } from "./session-store.js";

const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:grok-desk@localhost";

function subsPath() {
  ensureUserDataMigrated();
  return userDataPath("push-subscriptions.json");
}

function loadSubs() {
  try {
    const p = subsPath();
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, "utf8"));
      return Array.isArray(data.subscriptions) ? data.subscriptions : [];
    }
  } catch {
    /* */
  }
  return [];
}

function saveSubs(list) {
  const p = subsPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ subscriptions: list }, null, 2), { mode: 0o600 });
}

/** Ensure VAPID keys exist; return { publicKey, privateKey }. */
export function ensureVapidKeys() {
  const secrets = loadSecrets();
  if (secrets.vapidPublicKey && secrets.vapidPrivateKey) {
    return {
      publicKey: secrets.vapidPublicKey,
      privateKey: secrets.vapidPrivateKey,
    };
  }
  const keys = webpush.generateVAPIDKeys();
  saveSecrets({
    vapidPublicKey: keys.publicKey,
    vapidPrivateKey: keys.privateKey,
  });
  console.log("[push] generated VAPID keys");
  return keys;
}

function configureWebPush() {
  const keys = ensureVapidKeys();
  webpush.setVapidDetails(VAPID_SUBJECT, keys.publicKey, keys.privateKey);
  return keys;
}

export function getVapidPublicKey() {
  return ensureVapidKeys().publicKey;
}

export function pushStatus() {
  const keys = ensureVapidKeys();
  const subs = loadSubs();
  const settings = loadSettings();
  return {
    vapidPublicKey: keys.publicKey,
    subscriberCount: subs.length,
    pushEnabled: settings.pushEnabled !== false,
    pushNotifyOnTurnEnd: settings.pushNotifyOnTurnEnd !== false,
  };
}

/** Save or replace a PushSubscription JSON from the browser. */
export function addSubscription(sub) {
  if (!sub || !sub.endpoint) throw new Error("invalid subscription");
  const list = loadSubs().filter((s) => s.endpoint !== sub.endpoint);
  list.push({
    endpoint: sub.endpoint,
    keys: sub.keys,
    expirationTime: sub.expirationTime ?? null,
    addedAt: new Date().toISOString(),
  });
  // Cap devices
  while (list.length > 10) list.shift();
  saveSubs(list);
  return { ok: true, count: list.length };
}

export function removeSubscription(endpoint) {
  if (!endpoint) throw new Error("endpoint required");
  const list = loadSubs().filter((s) => s.endpoint !== endpoint);
  saveSubs(list);
  return { ok: true, count: list.length };
}

export function clearAllSubscriptions() {
  saveSubs([]);
  return { ok: true, count: 0 };
}

/**
 * Send a notification to all stored phone subscriptions.
 * No-op if disabled or no subs. Never throws to callers.
 */
/**
 * @param {{ title?: string, body?: string, tag?: string, url?: string, status?: string, skipIfLocalClients?: number, skipIfRecentPongMs?: number }} opts
 * skipIfLocalClients: legacy WS count (zombie OPEN can suppress).
 * skipIfRecentPongMs: preferred — only skip if client pinged within window.
 */
export async function notifyPush({
  title,
  body,
  tag,
  url,
  status,
  skipIfLocalClients,
  skipIfRecentPongMs,
} = {}) {
  try {
    if (
      typeof skipIfRecentPongMs === "number" &&
      skipIfRecentPongMs > 0 &&
      typeof globalThis.__deskLastClientPongAge === "function"
    ) {
      try {
        const age = globalThis.__deskLastClientPongAge();
        if (Number.isFinite(age) && age < skipIfRecentPongMs) {
          return { sent: 0, skipped: "recent_pong" };
        }
      } catch {
        /* */
      }
    } else if (
      typeof skipIfLocalClients === "number" &&
      skipIfLocalClients > 0 &&
      typeof globalThis.__deskWsClientCount === "function"
    ) {
      try {
        const n = globalThis.__deskWsClientCount();
        if (n >= skipIfLocalClients) return { sent: 0, skipped: "local_ws" };
      } catch {
        /* */
      }
    }
    const settings = loadSettings();
    if (settings.pushEnabled === false) return { sent: 0, skipped: "disabled" };
    const list = loadSubs();
    if (!list.length) return { sent: 0, skipped: "no_subs" };

    configureWebPush();
    const payload = JSON.stringify({
      title: title || "Grok Desk",
      body: body || "",
      tag: tag || "grok-desk",
      url: url || "/",
      status: status || null, // done | error | working | … — client maps to dots
    });

    let sent = 0;
    const keep = [];
    for (const sub of list) {
      try {
        await webpush.sendNotification(sub, payload, {
          TTL: 60 * 60,
          urgency: "normal",
        });
        keep.push(sub);
        sent += 1;
      } catch (e) {
        const code = e.statusCode || e.statusCode;
        // Gone / expired — drop
        if (code === 404 || code === 410) {
          console.warn("[push] dropping stale sub", sub.endpoint?.slice(0, 48));
          continue;
        }
        console.warn("[push] send failed:", e.message || e);
        keep.push(sub);
      }
    }
    if (keep.length !== list.length) saveSubs(keep);
    return { sent, total: list.length };
  } catch (e) {
    console.warn("[push] notify failed:", e.message || e);
    return { sent: 0, error: e.message || String(e) };
  }
}
