/**
 * Local lock for Grok Desk (username + password + 9-digit PIN).
 * Hashes live only in Application Support. Never log secrets.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { userDataDir, userDataPath } from "./user-data.js";

const AUTH_FILE = "auth.json";
const SESSIONS_FILE = "auth-sessions.json";
const BOOTSTRAP_FILE = "bootstrap-once.json";
const COOKIE = "gd_session";
const TICKET_MS = 2 * 60 * 1000;
const SESSION_MS = 14 * 24 * 60 * 60 * 1000;
const FAIL_WINDOW_MS = 45 * 1000;
const FAIL_MAX = 6;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

/** @type {{ username: string, password: object, pin: object } | null} */
let auth = null;
const tickets = new Map();
const sessions = new Map();
const fails = new Map();

function authPath() {
  return userDataPath(AUTH_FILE);
}

function sessionsPath() {
  return userDataPath(SESSIONS_FILE);
}

function bootstrapPath() {
  return userDataPath(BOOTSTRAP_FILE);
}

function writePrivate(file, obj) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    /* */
  }
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* */
  }
}

function hashSecret(plain) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(plain), salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  });
  return {
    salt: salt.toString("hex"),
    hash: hash.toString("hex"),
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    keylen: SCRYPT.keylen,
  };
}

function verifySecret(plain, rec) {
  if (!rec || typeof rec !== "object" || !rec.salt || !rec.hash) return false;
  try {
    const salt = Buffer.from(rec.salt, "hex");
    const expected = Buffer.from(rec.hash, "hex");
    if (!salt.length || !expected.length) return false;
    const keylen = Number(rec.keylen) || expected.length;
    const got = crypto.scryptSync(String(plain), salt, keylen, {
      N: Number(rec.N) || SCRYPT.N,
      r: Number(rec.r) || SCRYPT.r,
      p: Number(rec.p) || SCRYPT.p,
    });
    if (got.length !== expected.length) return false;
    return crypto.timingSafeEqual(got, expected);
  } catch {
    return false;
  }
}

function normalizeUser(u) {
  return String(u || "").trim().toLowerCase();
}

function safeStrEq(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function loadAuthFile() {
  try {
    const p = authPath();
    if (!fs.existsSync(p)) return null;
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!j || typeof j !== "object") return null;
    if (!j.username || !j.password || !j.pin) return null;
    return {
      username: normalizeUser(j.username),
      password: j.password,
      pin: j.pin,
    };
  } catch {
    return null;
  }
}

function persistSessions() {
  const out = {};
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (s.expiresAt > now) out[id] = s;
  }
  try {
    writePrivate(sessionsPath(), { sessions: out });
  } catch {
    /* */
  }
}

function loadSessionsFile() {
  sessions.clear();
  try {
    const p = sessionsPath();
    if (!fs.existsSync(p)) return;
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    const now = Date.now();
    const bag = j?.sessions && typeof j.sessions === "object" ? j.sessions : {};
    for (const [id, s] of Object.entries(bag)) {
      if (!id || !s || typeof s !== "object") continue;
      const expiresAt = Number(s.expiresAt) || 0;
      if (expiresAt <= now) continue;
      sessions.set(id, {
        username: String(s.username || ""),
        createdAt: Number(s.createdAt) || now,
        expiresAt,
      });
    }
  } catch {
    /* */
  }
}

function writeAuthRecord({ username, password, pin }) {
  const user = normalizeUser(username);
  if (!user) throw new Error("username required");
  if (!password) throw new Error("password required");
  if (!/^\d{9}$/.test(String(pin || ""))) throw new Error("pin must be 9 digits");
  const rec = {
    username: user,
    password: hashSecret(password),
    pin: hashSecret(String(pin)),
    createdAt: new Date().toISOString(),
  };
  writePrivate(authPath(), rec);
  auth = { username: rec.username, password: rec.password, pin: rec.pin };
}

function consumeBootstrap() {
  const p = bootstrapPath();
  if (!fs.existsSync(p)) return;
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    raw = null;
  }
  try {
    fs.unlinkSync(p);
  } catch {
    /* always drop plaintext bootstrap */
  }
  if (!raw || typeof raw !== "object") {
    console.warn("[auth] bootstrap present but unreadable — deleted");
    return;
  }
  try {
    writeAuthRecord(raw);
    console.log("[auth] lock configured from bootstrap");
  } catch (e) {
    console.warn("[auth] bootstrap rejected:", e.message || e);
  }
}

function clientKey(req) {
  const xf = req?.headers?.["x-forwarded-for"];
  if (typeof xf === "string" && xf.trim()) return xf.split(",")[0].trim();
  return req?.socket?.remoteAddress || "local";
}

function pruneFails(now) {
  for (const [k, arr] of fails) {
    const next = arr.filter((t) => now - t < FAIL_WINDOW_MS);
    if (next.length) fails.set(k, next);
    else fails.delete(k);
  }
}

function rateLimited(req) {
  const now = Date.now();
  pruneFails(now);
  const key = clientKey(req);
  const arr = fails.get(key) || [];
  return arr.length >= FAIL_MAX;
}

function noteFail(req) {
  const now = Date.now();
  pruneFails(now);
  const key = clientKey(req);
  const arr = fails.get(key) || [];
  arr.push(now);
  fails.set(key, arr);
}

function isSecureRequest(req) {
  if (req?.socket?.encrypted) return true;
  const proto = req?.headers?.["x-forwarded-proto"];
  if (typeof proto === "string" && proto.split(",")[0].trim().toLowerCase() === "https") {
    return true;
  }
  return false;
}

function parseCookies(req) {
  const header = req?.headers?.cookie;
  if (!header || typeof header !== "string") return {};
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function cookieHeader(token, req, { clear = false } = {}) {
  const parts = [`${COOKIE}=${clear ? "" : token}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (clear) {
    parts.push("Max-Age=0");
  } else {
    parts.push(`Max-Age=${Math.floor(SESSION_MS / 1000)}`);
  }
  if (isSecureRequest(req)) parts.push("Secure");
  return parts.join("; ");
}

function newToken() {
  return crypto.randomBytes(32).toString("hex");
}

function pruneTickets() {
  const now = Date.now();
  for (const [id, t] of tickets) {
    if (t.expiresAt <= now) tickets.delete(id);
  }
}

function pruneSessions() {
  const now = Date.now();
  let changed = false;
  for (const [id, s] of sessions) {
    if (s.expiresAt <= now) {
      sessions.delete(id);
      changed = true;
    }
  }
  if (changed) persistSessions();
}

function sendAuthJson(res, status, body, extraHeaders = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(data),
    ...extraHeaders,
  });
  res.end(data);
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

export function authConfigured() {
  return Boolean(auth?.username && auth?.password && auth?.pin);
}

export function sessionFromRequest(req) {
  if (!authConfigured()) return { open: true };
  pruneSessions();
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const s = sessions.get(token);
  if (!s || s.expiresAt <= Date.now()) {
    if (s) {
      sessions.delete(token);
      persistSessions();
    }
    return null;
  }
  return { username: s.username, token };
}

/** If locked and no session, write 401 and return false. */
export function requireSession(req, res) {
  if (!authConfigured()) return true;
  if (sessionFromRequest(req)) return true;
  sendAuthJson(res, 401, { ok: false, error: "auth required" });
  return false;
}

export async function handleAuthApi(req, res) {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const p = url.pathname;

  if (p === "/api/auth/status" && req.method === "GET") {
    const configured = authConfigured();
    const sess = sessionFromRequest(req);
    sendAuthJson(res, 200, {
      ok: true,
      configured,
      authenticated: !configured || Boolean(sess && !sess.open),
    });
    return true;
  }

  if (p === "/api/auth/login" && req.method === "POST") {
    if (!authConfigured()) {
      sendAuthJson(res, 503, { ok: false, error: "auth not configured" });
      return true;
    }
    if (rateLimited(req)) {
      sendAuthJson(res, 429, { ok: false, error: "too many attempts" });
      return true;
    }
    let body = {};
    try {
      body = await readJson(req);
    } catch {
      sendAuthJson(res, 400, { ok: false, error: "invalid json" });
      return true;
    }
    const user = normalizeUser(body.username);
    const password = String(body.password || "");
    const userOk = safeStrEq(user, auth.username);
    const passOk = verifySecret(password, auth.password);
    if (!userOk || !passOk) {
      noteFail(req);
      sendAuthJson(res, 401, { ok: false, error: "invalid credentials" });
      return true;
    }
    pruneTickets();
    const ticket = newToken();
    tickets.set(ticket, { username: auth.username, expiresAt: Date.now() + TICKET_MS });
    sendAuthJson(res, 200, { ok: true, ticket });
    return true;
  }

  if (p === "/api/auth/pin" && req.method === "POST") {
    if (!authConfigured()) {
      sendAuthJson(res, 503, { ok: false, error: "auth not configured" });
      return true;
    }
    if (rateLimited(req)) {
      sendAuthJson(res, 429, { ok: false, error: "too many attempts" });
      return true;
    }
    let body = {};
    try {
      body = await readJson(req);
    } catch {
      sendAuthJson(res, 400, { ok: false, error: "invalid json" });
      return true;
    }
    pruneTickets();
    const ticket = String(body.ticket || "");
    const pin = String(body.pin || "");
    const t = tickets.get(ticket);
    if (!t || t.expiresAt <= Date.now()) {
      if (ticket) tickets.delete(ticket);
      noteFail(req);
      sendAuthJson(res, 401, { ok: false, error: "ticket expired" });
      return true;
    }
    if (!/^\d{9}$/.test(pin) || !verifySecret(pin, auth.pin)) {
      noteFail(req);
      sendAuthJson(res, 401, { ok: false, error: "invalid pin" });
      return true;
    }
    tickets.delete(ticket);
    const token = newToken();
    const now = Date.now();
    sessions.set(token, {
      username: t.username,
      createdAt: now,
      expiresAt: now + SESSION_MS,
    });
    persistSessions();
    sendAuthJson(res, 200, { ok: true }, { "Set-Cookie": cookieHeader(token, req) });
    return true;
  }

  if (p === "/api/auth/logout" && req.method === "POST") {
    const token = parseCookies(req)[COOKIE];
    if (token && sessions.has(token)) {
      sessions.delete(token);
      persistSessions();
    }
    sendAuthJson(res, 200, { ok: true }, { "Set-Cookie": cookieHeader("", req, { clear: true }) });
    return true;
  }

  sendAuthJson(res, 404, { ok: false, error: "not found" });
  return true;
}

// Load + one-shot bootstrap on import.
userDataDir();
consumeBootstrap();
auth = loadAuthFile();
loadSessionsFile();
