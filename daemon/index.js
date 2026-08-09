/**
 * Grok Desk local daemon
 * - HTTP: serves the PWA, status, voice-token mint
 * - WS /ws: chat bridge to `grok agent stdio` (CLI subscription — no API)
 * Voice hits xAI only when POST /api/voice-token is called.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { loadEnv, ROOT } from "./load-env.js";
import { AcpPool } from "./acp-pool.js";
import { mintVoiceToken } from "./voice-token.js";
import {
  listProjects,
  loadTranscript,
  loadSettings,
  saveSettings,
  findSessionCwd,
  trackDeskSession,
  getDeskSourceDir,
  appendDeskMessage,
  upsertDeskMessage,
  setDeskTitle,
  loadAgentMailTranscript,
  sessionsRoot,
  pruneSubagentsFromDeskIndex,
} from "./session-store.js";
import { hasXaiApiKey, maskXaiKey, saveSecrets, resolveXaiApiKey } from "./secrets.js";
import { saveUpload, isImageMime } from "./uploads.js";
import { ensureUserDataMigrated, userDataDir } from "./user-data.js";
import {
  getVapidPublicKey,
  pushStatus,
  addSubscription,
  removeSubscription,
  clearAllSubscriptions,
  notifyPush,
  ensureVapidKeys,
} from "./push.js";
import { handleBuildApi } from "./routes/build.js";

loadEnv();
ensureUserDataMigrated();

function voiceStatusPayload() {
  const configured = hasXaiApiKey();
  return {
    voiceConfigured: configured,
    voiceKeyMasked: configured ? maskXaiKey() : null,
  };
}

const PORT = Number(process.env.PORT || 8787);
const WEB_DIST = path.join(ROOT, "web", "dist");
const WEB_PUBLIC = path.join(ROOT, "web", "public");

function resolveDeskPermissionMode() {
  // Settings win (Desk UI / mode chip). Env only if settings unset.
  try {
    const st = loadSettings();
    if (st.permissionMode) {
      const m = st.permissionMode;
      if (m === "yolo" || m === "bypassPermissions") return "always-approve";
      return m;
    }
  } catch {
    /* */
  }
  if (process.env.GROK_ALWAYS_APPROVE === "0") return "ask";
  if (process.env.GROK_ALWAYS_APPROVE === "1") return "always-approve";
  return "ask";
}

/** Multi-agent pool (Phase 2). `bridge` = default worker for single-agent compat. */
const _permMode = resolveDeskPermissionMode();
const pool = new AcpPool({
  alwaysApprove: _permMode === "always-approve",
  permissionMode: _permMode,
  maxWorkers: Number(process.env.DESK_MAX_WORKERS || 4),
});
let bridge = pool.bridge;
function syncDefaultBridge() {
  bridge = pool.bridge;
}

// Forward permission cards to all WS clients
pool.on("permission_request", (req) => {
  broadcastJson({ type: "permission_request", ...req });
});

// Forward interactive question / plan-approval cards (x.ai/* ext methods)
function wireWorkerExt(worker) {
  if (!worker?.bridge || worker._extWired) return;
  worker._extWired = true;
  const b = worker.bridge;
  b.on("question_request", (req) => {
    broadcastJson({ type: "question_request", workerId: worker.id, ...req });
  });
  b.on("plan_approval_request", (req) => {
    broadcastJson({ type: "plan_approval_request", workerId: worker.id, ...req });
  });
  b.on("ext_request_cancelled", (req) => {
    broadcastJson({ type: "ext_request_cancelled", workerId: worker.id, ...req });
  });
  b.on("ext_request_resolved", (req) => {
    broadcastJson({ type: "ext_request_resolved", workerId: worker.id, ...req });
  });
}
for (const w of pool.workers.values()) wireWorkerExt(w);
pool.on("worker_spawned", ({ workerId }) => {
  const w = pool.workers.get(workerId);
  if (w) wireWorkerExt(w);
});

// Seed remembered allow patterns
try {
  const st0 = loadSettings();
  const pats = Array.isArray(st0.allowedToolPatterns) ? st0.allowedToolPatterns : [];
  for (const w of pool.workers.values()) {
    w.bridge.setAllowedPatterns(pats);
  }
} catch {
  /* */
}

// Terminal host streams → UI
function wireWorkerTerminal(worker) {
  if (!worker?.bridge || worker._termWired) return;
  worker._termWired = true;
  worker.bridge.on("terminal_output", (ev) => {
    broadcastJson({ type: "terminal_output", workerId: worker.id, ...ev });
  });
  worker.bridge.on("terminal_exit", (ev) => {
    broadcastJson({ type: "terminal_exit", workerId: worker.id, ...ev });
  });
}
for (const w of pool.workers.values()) wireWorkerTerminal(w);
pool.on("worker_spawned", ({ workerId }) => {
  const w = pool.workers.get(workerId);
  if (w) {
    try {
      const st = loadSettings();
      w.bridge.setAllowedPatterns(st.allowedToolPatterns || []);
    } catch {
      /* */
    }
    wireWorkerTerminal(w);
  }
});

/** sessionId → live turn on a *parallel* (non-globalBusy) worker */
const parallelTurns = new Map();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(data),
    "Access-Control-Allow-Origin": "*",
  });
  res.end(data);
}

function serveStatic(req, res) {
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";

  const roots = [WEB_DIST, WEB_PUBLIC].filter((d) => fs.existsSync(d));
  for (const root of roots) {
    const file = path.normalize(path.join(root, rel));
    if (!file.startsWith(root)) continue;
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      const ext = path.extname(file);
      const headers = { "Content-Type": MIME[ext] || "application/octet-stream" };
      // Never cache shell HTML / SW so composer layout fixes ship on restart
      if (ext === ".html" || rel === "/registerSW.js" || rel === "/sw.js") {
        headers["Cache-Control"] = "no-store, no-cache, must-revalidate";
        headers.Pragma = "no-cache";
      } else if (ext === ".js" || ext === ".css") {
        headers["Cache-Control"] = "public, max-age=60";
      }
      res.writeHead(200, headers);
      fs.createReadStream(file).pipe(res);
      return true;
    }
  }

  // SPA fallback
  const index = path.join(WEB_DIST, "index.html");
  if (fs.existsSync(index)) {
    res.writeHead(200, {
      "Content-Type": MIME[".html"],
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Pragma: "no-cache",
    });
    fs.createReadStream(index).pipe(res);
    return true;
  }
  return false;
}

async function handleApi(req, res) {
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return true;
  }

  // Visual Build surface (skills / MCP / models / radar) — never touches turns
  if (url.pathname.startsWith("/api/build")) {
    return handleBuildApi(req, res, sendJson, readBody);
  }

  /** Live multi-agent roster (Phase 2 pool) */
  if (url.pathname === "/api/agents" && req.method === "GET") {
    sendJson(res, 200, {
      ok: true,
      ...pool.status(),
      liveSessionIds: turnSnapshot().liveSessionIds,
      parallelDrafts: parallelDrafts(),
    });
    return true;
  }

  if (url.pathname === "/api/queue" && req.method === "GET") {
    sendJson(res, 200, { ok: true, ...queueSnapshot() });
    return true;
  }

  if (url.pathname === "/api/queue/clear" && req.method === "POST") {
    const body = await readBody(req).catch(() => ({}));
    sendJson(res, 200, { ok: true, ...clearQueue(body.sessionId || null) });
    return true;
  }

  if (url.pathname === "/api/queue/cancel" && req.method === "POST") {
    const body = await readBody(req).catch(() => ({}));
    sendJson(res, 200, { ok: true, ...cancelQueueItem(body.clientMsgId || body.id) });
    return true;
  }

  if (url.pathname === "/api/status" && req.method === "GET") {
    sendJson(res, 200, {
      ok: true,
      port: PORT,
      ...voiceStatusPayload(),
      agent: bridge.status(),
      ...turnSnapshot(),
    });
    return true;
  }

  /** Mobile truth poll — full turn snapshot without WS */
  if (url.pathname === "/api/turn" && req.method === "GET") {
    sendJson(res, 200, {
      ok: true,
      ...turnSnapshot(),
      agent: bridge.status(),
    });
    return true;
  }

  if (url.pathname === "/api/voice-token" && (req.method === "POST" || req.method === "GET")) {
    let body = {};
    if (req.method === "POST") {
      body = await readBody(req).catch(() => ({}));
    }
    const result = await mintVoiceToken({ contextText: body.contextText || null });
    sendJson(res, result.status, result.body);
    return true;
  }

  if (url.pathname === "/api/new-session" && req.method === "POST") {
    try {
      if (globalBusy) {
        sendJson(res, 409, {
          ok: false,
          error: "Turn in progress — stop it or wait before starting a new session",
          turnActive: true,
          activeSessionId: activeTurn?.sessionId || bridge.sessionId || null,
        });
        return true;
      }
      const body = await readBody(req).catch(() => ({}));
      if (body.cwd) bridge.cwd = body.cwd;
      await bridge.ensure();
      const session = await bridge.newSession(body.cwd);
      trackDeskSession(session.sessionId, bridge.cwd);
      sendJson(res, 200, { ok: true, sessionId: session.sessionId, cwd: bridge.cwd });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message || String(e) });
    }
    return true;
  }

  // Full agent process restart (keeps HTTP daemon up)
  if (url.pathname === "/api/restart" && req.method === "POST") {
    try {
      abandonTurn({ restart: true, reason: "api_restart" });
      const status = await bridge.restart();
      sendJson(res, 200, { ok: true, agent: status, ...turnSnapshot() });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message || String(e) });
    }
    return true;
  }

  // Projects + sessions (Claude-Code-style sidebar data)
  if (url.pathname === "/api/projects" && req.method === "GET") {
    try {
      sendJson(res, 200, { ok: true, ...listProjects() });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message || String(e) });
    }
    return true;
  }

  if (url.pathname === "/api/settings" && req.method === "GET") {
    sendJson(res, 200, {
      ok: true,
      settings: loadSettings(),
      deskSourceDir: getDeskSourceDir(),
      userDataDir: userDataDir(),
      ...voiceStatusPayload(),
    });
    return true;
  }

  if (url.pathname === "/api/settings" && req.method === "POST") {
    try {
      const body = await readBody(req).catch(() => ({}));
      // Pull voice key out of settings blob — stored separately in secrets.json
      const { xaiApiKey, clearXaiApiKey, ...settingsPatch } = body;
      if (clearXaiApiKey) {
        saveSecrets({ xaiApiKey: "" });
        delete process.env.XAI_API_KEY;
      } else if (typeof xaiApiKey === "string" && xaiApiKey.trim()) {
        const key = xaiApiKey.trim();
        saveSecrets({ xaiApiKey: key });
        process.env.XAI_API_KEY = key; // live for this process
      }
      const settings = saveSettings(settingsPatch);
      if (settingsPatch.permissionMode != null) {
        try {
          const mode = settings.permissionMode || "ask";
          pool.setPermissionMode(mode);
          // Process flag (--always-approve) only applies on spawn — restart if idle
          if (!globalBusy && parallelTurns.size === 0) {
            await bridge.restart();
            syncDefaultBridge();
          }
        } catch (e) {
          console.warn("[desk] permission mode apply failed", e.message);
        }
      }
      if (settingsPatch.allowedToolPatterns != null) {
        const pats = Array.isArray(settings.allowedToolPatterns)
          ? settings.allowedToolPatterns
          : [];
        for (const w of pool.workers.values()) {
          w.bridge.setAllowedPatterns(pats);
        }
      }
      sendJson(res, 200, {
        ok: true,
        settings,
        ...voiceStatusPayload(),
        agent: bridge.status(),
      });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message || String(e) });
    }
    return true;
  }

  // GET /api/sessions/:id/transcript?cwd=
  const transcriptMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/transcript$/);
  if (transcriptMatch && req.method === "GET") {
    const sessionId = decodeURIComponent(transcriptMatch[1]);
    const cwd = url.searchParams.get("cwd") || findSessionCwd(sessionId) || null;
    try {
      sendJson(res, 200, loadTranscript(sessionId, cwd));
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message || String(e), messages: [] });
    }
    return true;
  }

  // Save attachment (base64) → absolute path the agent can read
  if (url.pathname === "/api/upload" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const sessionId = body.sessionId || bridge.sessionId || "pending";
      const saved = saveUpload({
        sessionId,
        name: body.name || "file",
        mime: body.mime,
        dataBase64: body.dataBase64,
        preferCwd: body.cwd || bridge.cwd,
      });
      sendJson(res, 200, { ok: true, ...saved });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message || String(e) });
    }
    return true;
  }

  if (url.pathname === "/api/load-session" && req.method === "POST") {
    try {
      const body = await readBody(req).catch(() => ({}));
      const sessionId = body.sessionId;
      if (!sessionId) {
        sendJson(res, 400, { ok: false, error: "sessionId required" });
        return true;
      }
      const cwd = body.cwd || findSessionCwd(sessionId);
      const transcript = loadTranscript(sessionId, cwd);
      // Match WS rules: never steal ACP mid-turn via HTTP
      if (globalBusy && bridge.sessionId && String(bridge.sessionId) !== String(sessionId)) {
        sendJson(res, 200, {
          ok: true,
          sessionId,
          cwd,
          messages: transcript.messages || [],
          summary: transcript.summary || null,
          truncated: transcript.truncated || false,
          agentResumed: false,
          viewOnly: true,
          activeSessionId: activeTurn?.sessionId || bridge.sessionId,
        });
        return true;
      }
      const loaded = await bridge.loadSession(sessionId, cwd);
      trackDeskSession(loaded.sessionId, loaded.cwd || cwd);
      sendJson(res, 200, {
        ok: true,
        sessionId: loaded.sessionId,
        cwd: loaded.cwd || cwd,
        messages: transcript.messages || [],
        summary: transcript.summary || null,
        truncated: transcript.truncated || false,
        agentResumed: true,
      });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message || String(e) });
    }
    return true;
  }

  // ── Web Push (phone PWA) ──
  if (url.pathname === "/api/push/vapid" && req.method === "GET") {
    try {
      sendJson(res, 200, { ok: true, publicKey: getVapidPublicKey() });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message || String(e) });
    }
    return true;
  }

  if (url.pathname === "/api/push/status" && req.method === "GET") {
    try {
      sendJson(res, 200, { ok: true, ...pushStatus() });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message || String(e) });
    }
    return true;
  }

  if (url.pathname === "/api/push/subscribe" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const result = addSubscription(body);
      sendJson(res, 200, result);
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message || String(e) });
    }
    return true;
  }

  if (url.pathname === "/api/push/unsubscribe" && req.method === "POST") {
    try {
      const body = await readBody(req).catch(() => ({}));
      if (body.clearAll) {
        sendJson(res, 200, clearAllSubscriptions());
      } else {
        sendJson(res, 200, removeSubscription(body.endpoint));
      }
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message || String(e) });
    }
    return true;
  }

  return false;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (await handleApi(req, res)) return;
    if (serveStatic(req, res)) return;
    sendJson(res, 404, {
      error: "Not found. Run `npm run build` in web/ if the UI is missing.",
    });
  } catch (e) {
    console.error(e);
    sendJson(res, 500, { error: e.message || "server error" });
  }
});

const wss = new WebSocketServer({ server, path: "/ws" });

/** Send JSON to every open Desk client. */
function broadcastJson(obj) {
  const payload = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      try {
        client.send(payload);
      } catch {
        /* */
      }
    }
  }
}

/** Push sidebar refresh to every open Desk client (CLI/fs changes too). */
function broadcastProjectsTick(reason = "change") {
  broadcastJson({ type: "projects_tick", reason, at: Date.now() });
}

/** Watch ~/.grok/sessions so CLI activity shows up in Desk live. */
function startSessionWatcher() {
  const root = sessionsRoot();
  try {
    if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  } catch {
    /* */
  }
  let timer = null;
  const fire = () => {
    clearTimeout(timer);
    timer = setTimeout(() => broadcastProjectsTick("fs"), 500);
  };
  try {
    fs.watch(root, { recursive: true }, (_ev, filename) => {
      // Ignore lock files noise
      if (filename && String(filename).endsWith(".lock")) return;
      fire();
    });
    console.log(`[desk] watching sessions: ${root}`);
  } catch (e) {
    console.warn("[desk] session watch failed:", e.message);
    try {
      fs.watch(root, fire);
    } catch {
      /* */
    }
  }
}

/**
 * GLOBAL turn controller — one ACP process, session-bound prompts/queues.
 * Leaving a chat (viewOnly) never abandons. Only new_session / stop / restart do.
 *
 * Ownership: globalTurnGen is the claim epoch. Only the owner may clear globalBusy.
 * abandonTurn bumps gen so in-flight jobs see mismatch and exit without stealing the lock.
 */
let globalTurnGen = 0;
let globalBusy = false;
/** sessionId → array of {text, attachments, clientMsgId, sessionId} */
const sessionQueues = new Map();
/** Live turn snapshot for late joiners / PWA reload */
let activeTurn = null; // { sessionId, gen, content, thought, tools, plan, phase, startedAt, lastActivityAt, draftId }
/** clientMsgId → ts for short dedupe */
const recentClientMsgIds = new Map();
/** sessionId → already injected project context this process */
const projectCtxInjected = new Set();
/** Pending queue-drain timer — cancelled on abandon */
let queueDrainTimer = null;
/** Wall / stall watchdog timers */
let turnWallTimer = null;
let turnStallTimer = null;
/** Last time any WS client answered pong (push skip needs liveness, not mere OPEN) */
let lastClientPongAt = 0;

const TURN_WALL_MS = Number(process.env.DESK_TURN_WALL_MS || 18 * 60 * 1000);
const TURN_STALL_MS = Number(process.env.DESK_TURN_STALL_MS || 6 * 60 * 1000);

function emitTurn(obj) {
  broadcastJson(obj);
}

function queueTotal() {
  let n = 0;
  for (const q of sessionQueues.values()) n += q.length;
  return n;
}

function queueSessionIds() {
  const ids = [];
  for (const [sid, q] of sessionQueues) {
    if (sid && sid !== "_pending" && q?.length) ids.push(sid);
  }
  return ids;
}

/** Full queue snapshot for UI */
function queueSnapshot() {
  const items = [];
  for (const [sid, q] of sessionQueues) {
    if (!q?.length) continue;
    q.forEach((job, i) => {
      items.push({
        index: i,
        sessionId: sid === "_pending" ? null : sid,
        text: String(job.text || "").slice(0, 500),
        preview: String(job.text || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 100),
        clientMsgId: job.clientMsgId || null,
        hasAttachments: Array.isArray(job.attachments) && job.attachments.length > 0,
      });
    });
  }
  return { remaining: queueTotal(), items, sessionIds: queueSessionIds() };
}

function clearQueue(sessionId = null) {
  if (sessionId) {
    sessionQueues.delete(sessionId);
    sessionQueues.delete(String(sessionId));
  } else {
    sessionQueues.clear();
  }
  const snap = queueSnapshot();
  emitTurn({ type: "queue_update", remaining: snap.remaining, items: snap.items, cleared: true });
  return snap;
}

function cancelQueueItem(clientMsgId) {
  if (!clientMsgId) return queueSnapshot();
  for (const [sid, q] of sessionQueues) {
    const idx = q.findIndex((j) => j.clientMsgId && j.clientMsgId === clientMsgId);
    if (idx >= 0) {
      q.splice(idx, 1);
      if (!q.length) sessionQueues.delete(sid);
      break;
    }
  }
  const snap = queueSnapshot();
  emitTurn({ type: "queue_update", remaining: snap.remaining, items: snap.items });
  return snap;
}

function partialDraftFromActive() {
  if (!activeTurn) return null;
  return {
    id: activeTurn.draftId || undefined,
    sessionId: activeTurn.sessionId,
    content: activeTurn.content || "",
    thought: activeTurn.thought || "",
    tools: activeTurn.tools || [],
    plan: activeTurn.plan || [],
    phase: activeTurn.phase || "thinking",
  };
}

function parallelDrafts() {
  const out = [];
  for (const [sid, t] of parallelTurns) {
    out.push({
      sessionId: sid,
      workerId: t.workerId,
      content: t.content || "",
      thought: t.thought || "",
      tools: t.tools || [],
      plan: t.plan || [],
      phase: t.phase || "thinking",
      startedAt: t.startedAt,
    });
  }
  return out;
}

function isSessionLive(sessionId) {
  if (!sessionId) return false;
  if (globalBusy && (activeTurn?.sessionId === sessionId || bridge.sessionId === sessionId)) {
    return true;
  }
  if (parallelTurns.has(sessionId)) return true;
  const w = pool.findBySession(sessionId);
  return Boolean(w?.busy);
}

/** Single source of truth for hello / status / GET /api/turn */
function turnSnapshot() {
  const agents = pool.list();
  return {
    turnActive: Boolean(globalBusy) || parallelTurns.size > 0,
    turnEpoch: globalTurnGen,
    activeSessionId: activeTurn?.sessionId || (globalBusy ? bridge.sessionId || null : null),
    bridgeSessionId: bridge.sessionId || null,
    phase: activeTurn?.phase || null,
    turnStartedAt: activeTurn?.startedAt || null,
    lastActivityAt: activeTurn?.lastActivityAt || null,
    partialDraft: partialDraftFromActive(),
    parallelDrafts: parallelDrafts(),
    liveSessionIds: [
      ...new Set([
        ...(activeTurn?.sessionId ? [activeTurn.sessionId] : []),
        ...parallelTurns.keys(),
        ...pool.busySessionIds(),
      ]),
    ],
    queueRemaining: queueTotal(),
    queueSessionIds: queueSessionIds(),
    queueItems: queueSnapshot().items,
    agentAlive: Boolean(bridge.status().agentAlive),
    pool: pool.status(),
    agents,
  };
}

function broadcastAgents() {
  broadcastJson({ type: "agents_roster", agents: pool.list(), ...turnSnapshot() });
}

function clearTurnWatchdogs() {
  if (turnWallTimer) {
    clearTimeout(turnWallTimer);
    turnWallTimer = null;
  }
  if (turnStallTimer) {
    clearTimeout(turnStallTimer);
    turnStallTimer = null;
  }
}

function clearQueueDrainTimer() {
  if (queueDrainTimer) {
    clearTimeout(queueDrainTimer);
    queueDrainTimer = null;
  }
}

function touchTurnActivity() {
  if (!activeTurn) return;
  activeTurn.lastActivityAt = new Date().toISOString();
  // Reset stall timer on real stream activity
  if (turnStallTimer) {
    clearTimeout(turnStallTimer);
    turnStallTimer = null;
  }
  if (globalBusy && TURN_STALL_MS > 0) {
    const epoch = activeTurn.gen;
    turnStallTimer = setTimeout(() => {
      if (!globalBusy || activeTurn?.gen !== epoch) return;
      console.warn("[desk] turn stall watchdog — no stream activity", TURN_STALL_MS, "ms");
      abandonTurn({
        restart: true,
        reason: "stall_timeout",
      });
    }, TURN_STALL_MS);
  }
}

function armTurnWatchdogs(epoch) {
  clearTurnWatchdogs();
  if (TURN_WALL_MS > 0) {
    turnWallTimer = setTimeout(() => {
      if (!globalBusy) return;
      // Only fire if still same epoch family (abandon bumps gen)
      console.warn("[desk] turn wall watchdog", TURN_WALL_MS, "ms epoch", epoch);
      abandonTurn({ restart: true, reason: "wall_timeout" });
    }, TURN_WALL_MS);
  }
  touchTurnActivity();
}

/**
 * Claim busy slot for a new turn. Does NOT bump gen (abandon does).
 * Returns claimEpoch (= current globalTurnGen) for ownership checks after await.
 */
function claimBusy(label = "claim") {
  globalBusy = true;
  pool.setBusy(pool.defaultWorker, true);
  const epoch = globalTurnGen;
  console.log("[desk] claimBusy", label, "epoch", epoch);
  return epoch;
}

/**
 * Release busy only if still the owning epoch (post-await safe).
 * Returns true if released.
 */
function releaseBusy(epoch, reason = "release") {
  if (epoch !== globalTurnGen) {
    console.log("[desk] releaseBusy ignored stale", reason, "epoch", epoch, "cur", globalTurnGen);
    return false;
  }
  globalBusy = false;
  activeTurn = null;
  pool.setBusy(pool.defaultWorker, false);
  clearTurnWatchdogs();
  console.log("[desk] releaseBusy", reason, "epoch", epoch);
  return true;
}

function endTurnTerminal(opts = {}) {
  const {
    sessionId = activeTurn?.sessionId || bridge.sessionId || null,
    error = false,
    abandoned = false,
    deduped = false,
    reason = null,
    result = null,
    attachments = null,
    epoch = globalTurnGen,
  } = opts;
  // Only emit + clear if we still own the epoch (or abandon already bumped and wasBusy handled)
  if (epoch === globalTurnGen) {
    clearTurnWatchdogs();
    globalBusy = false;
    activeTurn = null;
    pool.setBusy(pool.defaultWorker, false);
  }
  const payload = {
    type: "turn_end",
    sessionId,
    error: Boolean(error),
    abandoned: Boolean(abandoned),
    deduped: Boolean(deduped),
    reason: reason || undefined,
    result: result ?? null,
    turnEpoch: globalTurnGen,
  };
  if (attachments) payload.attachments = attachments;
  emitTurn(payload);
  console.log(
    "[desk] turn_end",
    reason || (abandoned ? "abandoned" : error ? "error" : deduped ? "deduped" : "ok"),
    sessionId ? String(sessionId).slice(0, 8) : "—",
  );
  broadcastProjectsTick("turn_end");
}

function abandonTurn(opts = {}) {
  const hard = opts.hard !== false; // hard: clear all queues
  const reason = opts.reason || (opts.restart ? "restart" : "abandon");
  const wasBusy = globalBusy || queueTotal() > 0;
  const endedSid = activeTurn?.sessionId || bridge.sessionId || null;
  globalTurnGen += 1;
  clearQueueDrainTimer();
  clearTurnWatchdogs();
  if (hard) sessionQueues.clear();
  globalBusy = false;
  activeTurn = null;
  pool.setBusy(pool.defaultWorker, false);
  try {
    bridge.flushPermissions?.(reason);
  } catch {
    /* */
  }
  bridge.loadToken = (bridge.loadToken || 0) + 1; // invalidate in-flight loads
  if (wasBusy) {
    emitTurn({ type: "queue_update", remaining: 0 });
    emitTurn({
      type: "turn_end",
      abandoned: true,
      sessionId: endedSid,
      reason,
      turnEpoch: globalTurnGen,
    });
    console.log("[desk] turn_end abandoned", reason, endedSid ? String(endedSid).slice(0, 8) : "—");
    broadcastProjectsTick("turn_end");
  }
  // Cancel MUST not wait on hung prompt (cancelSession rejects pending + fires cancel).
  // Soft abandon (new_session switch): cancel only.
  // Hard stop/restart: cancel + kill agent so rpcChain is definitely free.
  if (opts.restart) {
    void (async () => {
      try {
        await bridge.cancelSession();
      } catch {
        /* */
      }
      try {
        console.warn("[desk] abandon hard — restarting agent", reason);
        await bridge.restart();
      } catch (e) {
        console.warn("[desk] restart failed", e.message);
      }
    })();
  } else {
    void bridge.cancelSession().catch(() => {});
  }
}

function enqueuePrompt(job) {
  const sid = job.sessionId || "_pending";
  if (!sessionQueues.has(sid)) sessionQueues.set(sid, []);
  // Ensure every job has an id for cancel
  if (!job.clientMsgId) {
    job.clientMsgId = `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  }
  sessionQueues.get(sid).push(job);
  const remaining = queueTotal();
  const snap = queueSnapshot();
  emitTurn({
    type: "queued",
    position: sessionQueues.get(sid).length,
    remaining,
    text: job.text,
    sessionId: job.sessionId || null,
    clientMsgId: job.clientMsgId || null,
    items: snap.items,
  });
  return remaining;
}

function takeNextJob(preferSessionId) {
  // Prefer more work on the same session, else any non-empty queue
  if (preferSessionId && sessionQueues.get(preferSessionId)?.length) {
    return sessionQueues.get(preferSessionId).shift();
  }
  for (const [sid, q] of sessionQueues) {
    if (q.length) {
      const job = q.shift();
      if (!q.length) sessionQueues.delete(sid);
      return job;
    }
  }
  return null;
}

/**
 * Run one prompt. Callers must either:
 *  - claim via claimTurn() first (opts.claimed), or
 *  - let this set globalBusy (default).
 * Always drains the per-session queue in finally when gen still matches.
 */
async function runPromptJob(text, attachments, opts = {}) {
  const gen = globalTurnGen;
  const clientMsgId = opts.clientMsgId || null;
  if (clientMsgId) {
    const prev = recentClientMsgIds.get(clientMsgId);
    if (prev && Date.now() - prev < 120000) {
      console.log("[desk] dedupe clientMsgId", clientMsgId);
      // Release only if we still own the claim; always notify client with turn_end
      if (opts.claimed && gen === globalTurnGen) {
        const sid = opts.sessionId || bridge.sessionId || null;
        endTurnTerminal({
          sessionId: sid,
          deduped: true,
          reason: "deduped",
          epoch: gen,
        });
        const next = takeNextJob(sid);
        if (next) {
          globalBusy = true; // keep claimed for drain
          queueMicrotask(() => void startQueuedJob(next));
        }
      }
      return;
    }
    recentClientMsgIds.set(clientMsgId, Date.now());
    // prune
    if (recentClientMsgIds.size > 200) {
      const cutoff = Date.now() - 120000;
      for (const [k, t] of recentClientMsgIds) {
        if (t < cutoff) recentClientMsgIds.delete(k);
      }
    }
  }

  if (!opts.claimed) claimBusy("runPromptJob");
  let jobSessionId = opts.sessionId || bridge.sessionId || null;
  const nowIso = new Date().toISOString();
  const draftId = clientMsgId ? `desk_a_${clientMsgId}` : `desk_a_${Date.now()}`;
  activeTurn = {
    sessionId: jobSessionId,
    gen,
    content: "",
    thought: "",
    tools: [],
    plan: [],
    phase: "thinking",
    startedAt: nowIso,
    lastActivityAt: nowIso,
    draftId,
  };
  armTurnWatchdogs(gen);
  console.log(
    "[desk] turn start",
    jobSessionId ? jobSessionId.slice(0, 8) : "pending",
    "q=",
    queueTotal(),
    "epoch",
    gen,
    (text || "").slice(0, 40),
  );
  emitTurn({
    type: "turn_start",
    sessionId: jobSessionId,
    turnEpoch: gen,
    draftId,
  });

  let assistantBuf = "";
  let thoughtBuf = "";
  /** @type {Array<{id:string,title:string,status:string,kind?:string}>} */
  const toolsBuf = [];
  /** @type {Array<{content:string,status:string,priority?:string}>} */
  let planBuf = [];

  try {
    await bridge.ensure();
    if (gen !== globalTurnGen) return;

    // Bind to requested session if idle path asked for a specific id
    if (opts.sessionId && bridge.sessionId && opts.sessionId !== bridge.sessionId) {
      // Should not run wrong session while busy — caller should only start matching jobs
      console.warn(
        "[desk] runPromptJob session mismatch requested=",
        opts.sessionId,
        "bridge=",
        bridge.sessionId,
      );
    }

    if (!bridge.sessionId) {
      const session = await bridge.newSession(bridge.cwd);
      if (gen !== globalTurnGen) return;
      trackDeskSession(session.sessionId, bridge.cwd);
      jobSessionId = session.sessionId;
      if (activeTurn) activeTurn.sessionId = jobSessionId;
      emitTurn({
        type: "session",
        sessionId: session.sessionId,
        cwd: bridge.cwd,
        mode: "new",
        title: "New chat",
      });
      broadcastProjectsTick("new_session");
    }
    jobSessionId = bridge.sessionId;
    if (activeTurn) activeTurn.sessionId = jobSessionId;
    trackDeskSession(jobSessionId, bridge.cwd);

    const saved = [];
    for (const a of attachments || []) {
      if (a.path && fs.existsSync(a.path)) {
        saved.push({
          path: a.path,
          name: a.name || path.basename(a.path),
          mime: a.mime || "application/octet-stream",
        });
        continue;
      }
      if (a.dataBase64) {
        const file = saveUpload({
          sessionId: jobSessionId,
          name: a.name || "attachment",
          mime: a.mime,
          dataBase64: a.dataBase64,
          preferCwd: bridge.cwd,
        });
        saved.push(file);
      }
    }

    if (jobSessionId) {
      const label =
        text ||
        (saved.length ? `Attached ${saved.map((f) => f.name).join(", ")}` : "");
      if (label) {
        appendDeskMessage(jobSessionId, {
          role: "user",
          content: label,
          id: clientMsgId ? `desk_u_${clientMsgId}` : `desk_u_${Date.now()}`,
        });
        const title = setDeskTitle(jobSessionId, label);
        trackDeskSession(jobSessionId, bridge.cwd, title || undefined);
        if (title) {
          emitTurn({ type: "session_title", sessionId: jobSessionId, title });
        }
        broadcastProjectsTick("title");
      }
    }

    const pathLines = saved.map((f) => `- ${f.name} → ${f.path} (${f.mime || "file"})`);
    const attachNote = pathLines.length
      ? `\n\n[ATTACHED FILES — absolute paths on this Mac. Read them with your tools if needed:\n${pathLines.join("\n")}\n]`
      : "";
    const projectCwd = bridge.cwd || "";
    const projectName = projectCwd
      ? projectCwd.replace(/\/+$/, "").split("/").pop()
      : "";
    const needCtx = Boolean(projectCwd && jobSessionId && !projectCtxInjected.has(jobSessionId));
    const projectCtx = needCtx
      ? `[GROK DESK — PROJECT CONTEXT]\nYou are working in this project folder only:\n  cwd: ${projectCwd}\n  project: ${projectName}\nDo NOT switch to another repo (e.g. noknok) unless the user explicitly asks. Use AgentMemory project code for THIS folder. Stay inside this cwd for tools/edits.\n\n`
      : "";
    if (needCtx && jobSessionId) projectCtxInjected.add(jobSessionId);
    const fullText =
      projectCtx +
      (text || (saved.length ? "Please look at the attached file(s)." : "")) +
      attachNote;

    const promptBlocks = [{ type: "text", text: fullText }];
    for (const f of saved) {
      if (!isImageMime(f.mime)) continue;
      try {
        const b64 = fs.readFileSync(f.path).toString("base64");
        promptBlocks.push({ type: "image", mimeType: f.mime, data: b64 });
      } catch (e) {
        console.warn("[upload] image block failed", e.message);
      }
    }

    const emitPhase = () => {
      let status = "working";
      if (planBuf.some((p) => p.status === "in_progress" || p.status === "pending")) {
        status = "planning";
      }
      const waiting = toolsBuf.some(
        (t) =>
          /pending|awaiting|approval|confirm/i.test(t.status || "") ||
          /permission|approval|confirm/i.test(t.title || ""),
      );
      if (waiting) status = "waiting";
      if (activeTurn) activeTurn.phase = status === "planning" ? "tooling" : "thinking";
      touchTurnActivity();
      emitTurn({
        type: "session_activity",
        sessionId: jobSessionId,
        status,
      });
    };

    /** Shadow mid-turn so phone reload / WS flaps still see progress */
    let lastShadowAt = 0;
    let lastShadowLen = 0;
    const shadowPartial = (force = false) => {
      if (!jobSessionId) return;
      const len = assistantBuf.length + thoughtBuf.length + toolsBuf.length * 20;
      const now = Date.now();
      if (!force && now - lastShadowAt < 1500 && len - lastShadowLen < 80) return;
      lastShadowAt = now;
      lastShadowLen = len;
      if (!assistantBuf.trim() && !thoughtBuf.trim() && !toolsBuf.length) return;
      try {
        upsertDeskMessage(jobSessionId, {
          id: draftId,
          role: "assistant",
          content: assistantBuf,
          thought: thoughtBuf || undefined,
          tools: toolsBuf.length ? toolsBuf.map((x) => ({ ...x })) : undefined,
          plan: planBuf.length ? planBuf : undefined,
          streaming: true,
        });
      } catch {
        /* */
      }
    };

    // Throttled partial_draft for mobile HTTP poll fallback (WS flaps)
    let lastPartialBroadcast = 0;
    const broadcastPartial = (force = false) => {
      const now = Date.now();
      if (!force && now - lastPartialBroadcast < 350) return;
      lastPartialBroadcast = now;
      emitTurn({
        type: "partial_draft",
        sessionId: jobSessionId,
        turnEpoch: gen,
        draft: partialDraftFromActive(),
      });
    };

    const result = await bridge.prompt(fullText, {
      promptBlocks,
      onUpdate: (update) => {
        if (gen !== globalTurnGen) return;
        const kind = update?.sessionUpdate || update?.type;
        if (kind === "agent_message_chunk") {
          const t = update.content?.text ?? update.text ?? "";
          if (t) {
            assistantBuf += t;
            if (activeTurn) {
              activeTurn.content = assistantBuf;
              activeTurn.phase = "writing";
            }
            touchTurnActivity();
            shadowPartial();
            broadcastPartial();
          }
        } else if (kind === "agent_thought_chunk") {
          const t = update.content?.text ?? update.text ?? "";
          if (t) {
            thoughtBuf += t;
            if (activeTurn) activeTurn.thought = thoughtBuf;
            touchTurnActivity();
            shadowPartial();
            broadcastPartial();
          }
        } else if (kind === "tool_call") {
          const id = String(
            update.toolCallId || update.tool_call_id || update.id || `t_${toolsBuf.length}`,
          );
          toolsBuf.push({
            id,
            title: String(update.title || update.name || "tool"),
            kind: update.kind ? String(update.kind) : undefined,
            status: String(update.status || "pending"),
          });
          if (activeTurn) activeTurn.tools = toolsBuf.map((x) => ({ ...x }));
          emitPhase();
          shadowPartial(true);
          broadcastPartial(true);
        } else if (kind === "tool_call_update") {
          const id = String(update.toolCallId || update.tool_call_id || update.id || "");
          const t = toolsBuf.find((x) => x.id === id);
          if (t) {
            if (update.status) t.status = String(update.status);
            if (update.title) t.title = String(update.title);
          }
          if (activeTurn) activeTurn.tools = toolsBuf.map((x) => ({ ...x }));
          emitPhase();
          broadcastPartial();
        } else if (kind === "plan" && Array.isArray(update.entries)) {
          planBuf = update.entries.map((e) => ({
            content: String(e.content || ""),
            status: String(e.status || "pending"),
            priority: e.priority ? String(e.priority) : undefined,
          }));
          if (activeTurn) activeTurn.plan = planBuf;
          emitPhase();
          broadcastPartial(true);
        }
        emitTurn({ type: "update", update, sessionId: jobSessionId, turnEpoch: gen });
      },
    });

    const saveAssistant = () => {
      // Always write to jobSessionId captured at start — never live bridge after switch
      if (!jobSessionId) return;
      if (!assistantBuf.trim() && !thoughtBuf.trim() && !toolsBuf.length) return;
      upsertDeskMessage(jobSessionId, {
        role: "assistant",
        content: assistantBuf.trim(),
        thought: thoughtBuf.trim() || undefined,
        tools: toolsBuf.length ? toolsBuf : undefined,
        plan: planBuf.length ? planBuf : undefined,
        id: draftId,
        streaming: false,
      });
    };

    if (gen !== globalTurnGen) {
      // Abandoned via abandonTurn (already emitted turn_end) — still save partial
      saveAssistant();
      return;
    }
    trackDeskSession(jobSessionId, bridge.cwd);
    saveAssistant();
    emitTurn({
      type: "session_activity",
      sessionId: jobSessionId,
      status: "done",
    });
    // Clear activeTurn before turn_end so snapshot is idle for racing status polls
    clearTurnWatchdogs();
    activeTurn = null;
    emitTurn({
      type: "turn_end",
      result: result || null,
      attachments: saved,
      sessionId: jobSessionId,
      turnEpoch: gen,
      reason: "ok",
    });
    console.log("[desk] turn_end ok", jobSessionId ? String(jobSessionId).slice(0, 8) : "—");
    broadcastProjectsTick("turn_end");
    broadcastAgents();
    try {
      const st = loadSettings();
      if (st.pushNotifyOnTurnEnd !== false) {
        const snippet = (assistantBuf || text || "Done").replace(/\s+/g, " ").trim().slice(0, 120);
        void notifyPush({
          title: "● Done · Grok finished",
          body: snippet,
          tag: jobSessionId || "turn",
          url: "/",
          status: "done",
          // Only skip if a client ponged recently (zombie OPEN sockets don't suppress)
          skipIfRecentPongMs: 25000,
        });
      }
    } catch {
      /* */
    }
  } catch (e) {
    if (gen !== globalTurnGen) {
      // still try partial save to job session
      if (jobSessionId && (assistantBuf.trim() || thoughtBuf.trim() || toolsBuf.length)) {
        appendDeskMessage(jobSessionId, {
          role: "assistant",
          content: assistantBuf.trim(),
          thought: thoughtBuf.trim() || undefined,
          tools: toolsBuf.length ? toolsBuf : undefined,
          plan: planBuf.length ? planBuf : undefined,
          id: `desk_a_${Date.now()}`,
        });
      }
      return;
    }
    if (jobSessionId && (assistantBuf.trim() || thoughtBuf.trim() || toolsBuf.length)) {
      appendDeskMessage(jobSessionId, {
        role: "assistant",
        content: assistantBuf.trim(),
        thought: thoughtBuf.trim() || undefined,
        tools: toolsBuf.length ? toolsBuf : undefined,
        plan: planBuf.length ? planBuf : undefined,
        id: `desk_a_${Date.now()}`,
      });
    }
    emitTurn({ type: "error", error: e.message || String(e), sessionId: jobSessionId });
    emitTurn({
      type: "session_activity",
      sessionId: jobSessionId,
      status: "error",
    });
    clearTurnWatchdogs();
    activeTurn = null;
    emitTurn({
      type: "turn_end",
      error: true,
      sessionId: jobSessionId,
      reason: "error",
      turnEpoch: gen,
    });
    console.log("[desk] turn_end error", e.message || e);
    broadcastProjectsTick("turn_end");
    try {
      const st = loadSettings();
      if (st.pushNotifyOnTurnEnd !== false) {
        void notifyPush({
          title: "● Error · Grok",
          body: (e.message || "Turn failed").slice(0, 140),
          tag: "error",
          url: "/",
          status: "error",
          skipIfRecentPongMs: 25000,
        });
      }
    } catch {
      /* */
    }
  } finally {
    if (gen === globalTurnGen) {
      const next = takeNextJob(jobSessionId);
      if (next) {
        // KEEP busy claimed across handoff — no 40ms race window
        globalBusy = true;
        pool.setBusy(pool.defaultWorker, true);
        activeTurn = null;
        clearTurnWatchdogs();
        emitTurn({ type: "queue_update", remaining: queueTotal(), starting: true });
        clearQueueDrainTimer();
        queueDrainTimer = setTimeout(() => {
          queueDrainTimer = null;
          void startQueuedJob(next);
        }, 10);
      } else {
        globalBusy = false;
        pool.setBusy(pool.defaultWorker, false);
        activeTurn = null;
        clearTurnWatchdogs();
        emitTurn({ type: "queue_update", remaining: 0 });
        broadcastAgents();
      }
    }
  }
}

/** Drain one queued job — claims busy before any await so races can't double-start. */
async function startQueuedJob(next) {
  if (!next) return;
  // If already busy with a *running* activeTurn, re-queue; handoff leaves busy true without activeTurn
  if (globalBusy && activeTurn) {
    const sid = next.sessionId || "_pending";
    if (!sessionQueues.has(sid)) sessionQueues.set(sid, []);
    sessionQueues.get(sid).unshift(next);
    return;
  }
  const epoch = claimBusy("queue-drain");
  try {
    if (next.sessionId && bridge.sessionId !== next.sessionId) {
      console.log("[desk] queue drain → load session", next.sessionId?.slice(0, 8));
      const cwd = findSessionCwd(next.sessionId) || bridge.cwd;
      await bridge.loadSession(next.sessionId, cwd);
    }
    // Abandon during load?
    if (epoch !== globalTurnGen) {
      console.log("[desk] queue drain aborted after load — epoch mismatch");
      return;
    }
    // Re-assert busy after await
    globalBusy = true;
    await runPromptJob(next.text, next.attachments, {
      sessionId: next.sessionId || bridge.sessionId,
      clientMsgId: next.clientMsgId,
      claimed: true,
    });
  } catch (e) {
    console.warn("[desk] queue drain failed", e.message);
    if (epoch === globalTurnGen) {
      endTurnTerminal({
        sessionId: next.sessionId,
        error: true,
        reason: "queue_drain_error",
        epoch,
      });
      const more = takeNextJob(next.sessionId);
      if (more) {
        globalBusy = true;
        queueMicrotask(() => void startQueuedJob(more));
      }
    }
  }
}

/**
 * Run a prompt on a dedicated pool worker in parallel with the primary turn.
 * Does NOT use globalBusy — worker.busy + parallelTurns track it.
 */
async function runParallelPrompt(worker, text, attachments, opts = {}) {
  const b = worker.bridge;
  let jobSessionId = opts.sessionId || b.sessionId || null;
  const clientMsgId = opts.clientMsgId || null;
  const draftId = clientMsgId ? `desk_a_${clientMsgId}` : `desk_a_${Date.now()}`;
  const nowIso = new Date().toISOString();

  pool.setBusy(worker, true);
  const turn = {
    workerId: worker.id,
    sessionId: jobSessionId,
    content: "",
    thought: "",
    tools: [],
    plan: [],
    phase: "thinking",
    startedAt: nowIso,
    lastActivityAt: nowIso,
    draftId,
  };
  if (jobSessionId) parallelTurns.set(jobSessionId, turn);

  console.log(
    "[desk] parallel turn start",
    worker.id,
    jobSessionId ? String(jobSessionId).slice(0, 8) : "pending",
    (text || "").slice(0, 40),
  );
  emitTurn({
    type: "turn_start",
    sessionId: jobSessionId,
    workerId: worker.id,
    parallel: true,
    draftId,
  });
  broadcastAgents();

  let assistantBuf = "";
  let thoughtBuf = "";
  const toolsBuf = [];
  let planBuf = [];

  try {
    await b.ensure();
    if (!b.sessionId) {
      const session = await b.newSession(opts.cwd || b.cwd);
      jobSessionId = session.sessionId;
      pool.bindSession(worker, jobSessionId, b.cwd);
      turn.sessionId = jobSessionId;
      parallelTurns.set(jobSessionId, turn);
      trackDeskSession(jobSessionId, b.cwd);
      emitTurn({
        type: "session",
        sessionId: jobSessionId,
        cwd: b.cwd,
        mode: "new",
        title: "New chat",
        workerId: worker.id,
        parallel: true,
      });
      broadcastProjectsTick("new_session");
    } else {
      jobSessionId = b.sessionId;
      pool.bindSession(worker, jobSessionId, b.cwd);
      turn.sessionId = jobSessionId;
      parallelTurns.set(jobSessionId, turn);
    }

    const saved = [];
    for (const a of attachments || []) {
      if (a.path && fs.existsSync(a.path)) {
        saved.push({
          path: a.path,
          name: a.name || path.basename(a.path),
          mime: a.mime || "application/octet-stream",
        });
        continue;
      }
      if (a.dataBase64) {
        saved.push(
          saveUpload({
            sessionId: jobSessionId,
            name: a.name || "attachment",
            mime: a.mime,
            dataBase64: a.dataBase64,
            preferCwd: b.cwd,
          }),
        );
      }
    }

    if (jobSessionId) {
      const label =
        text || (saved.length ? `Attached ${saved.map((f) => f.name).join(", ")}` : "");
      if (label) {
        appendDeskMessage(jobSessionId, {
          role: "user",
          content: label,
          id: clientMsgId ? `desk_u_${clientMsgId}` : `desk_u_${Date.now()}`,
        });
        const title = setDeskTitle(jobSessionId, label);
        trackDeskSession(jobSessionId, b.cwd, title || undefined);
        if (title) emitTurn({ type: "session_title", sessionId: jobSessionId, title });
      }
    }

    const pathLines = saved.map((f) => `- ${f.name} → ${f.path} (${f.mime || "file"})`);
    const attachNote = pathLines.length
      ? `\n\n[ATTACHED FILES — absolute paths on this Mac. Read them with your tools if needed:\n${pathLines.join("\n")}\n]`
      : "";
    const projectCwd = b.cwd || "";
    const projectName = projectCwd ? projectCwd.replace(/\/+$/, "").split("/").pop() : "";
    const needCtx = Boolean(projectCwd && jobSessionId && !projectCtxInjected.has(jobSessionId));
    const projectCtx = needCtx
      ? `[GROK DESK — PROJECT CONTEXT]\nYou are working in this project folder only:\n  cwd: ${projectCwd}\n  project: ${projectName}\nDo NOT switch to another repo unless the user explicitly asks. Stay inside this cwd.\n\n`
      : "";
    if (needCtx && jobSessionId) projectCtxInjected.add(jobSessionId);
    const fullText =
      projectCtx +
      (text || (saved.length ? "Please look at the attached file(s)." : "")) +
      attachNote;
    const promptBlocks = [{ type: "text", text: fullText }];
    for (const f of saved) {
      if (!isImageMime(f.mime)) continue;
      try {
        promptBlocks.push({
          type: "image",
          mimeType: f.mime,
          data: fs.readFileSync(f.path).toString("base64"),
        });
      } catch {
        /* */
      }
    }

    const result = await b.prompt(fullText, {
      promptBlocks,
      onUpdate: (update) => {
        const kind = update?.sessionUpdate || update?.type;
        if (kind === "agent_message_chunk") {
          const t = update.content?.text ?? update.text ?? "";
          if (t) {
            assistantBuf += t;
            turn.content = assistantBuf;
            turn.phase = "writing";
          }
        } else if (kind === "agent_thought_chunk") {
          const t = update.content?.text ?? update.text ?? "";
          if (t) {
            thoughtBuf += t;
            turn.thought = thoughtBuf;
          }
        } else if (kind === "tool_call") {
          toolsBuf.push({
            id: String(update.toolCallId || update.id || `t_${toolsBuf.length}`),
            title: String(update.title || update.name || "tool"),
            kind: update.kind ? String(update.kind) : undefined,
            status: String(update.status || "pending"),
          });
          turn.tools = toolsBuf.map((x) => ({ ...x }));
        } else if (kind === "tool_call_update") {
          const id = String(update.toolCallId || update.id || "");
          const row = toolsBuf.find((x) => x.id === id);
          if (row) {
            if (update.status) row.status = String(update.status);
            if (update.title) row.title = String(update.title);
          }
          turn.tools = toolsBuf.map((x) => ({ ...x }));
        } else if (kind === "plan" && Array.isArray(update.entries)) {
          planBuf = update.entries.map((e) => ({
            content: String(e.content || ""),
            status: String(e.status || "pending"),
            priority: e.priority ? String(e.priority) : undefined,
          }));
          turn.plan = planBuf;
        }
        turn.lastActivityAt = new Date().toISOString();
        emitTurn({
          type: "update",
          update,
          sessionId: jobSessionId,
          workerId: worker.id,
          parallel: true,
        });
      },
    });

    if (jobSessionId && (assistantBuf.trim() || thoughtBuf.trim() || toolsBuf.length)) {
      appendDeskMessage(jobSessionId, {
        role: "assistant",
        content: assistantBuf.trim(),
        thought: thoughtBuf.trim() || undefined,
        tools: toolsBuf.length ? toolsBuf : undefined,
        plan: planBuf.length ? planBuf : undefined,
        id: draftId,
      });
    }

    emitTurn({
      type: "session_activity",
      sessionId: jobSessionId,
      status: "done",
      workerId: worker.id,
    });
    emitTurn({
      type: "turn_end",
      result: result || null,
      attachments: saved,
      sessionId: jobSessionId,
      workerId: worker.id,
      parallel: true,
      reason: "ok",
    });
    broadcastProjectsTick("turn_end");
    try {
      const st = loadSettings();
      if (st.pushNotifyOnTurnEnd !== false) {
        const snippet = (assistantBuf || text || "Done").replace(/\s+/g, " ").trim().slice(0, 120);
        void notifyPush({
          title: "● Done · Grok finished",
          body: snippet,
          tag: jobSessionId || "turn",
          url: "/",
          status: "done",
          skipIfRecentPongMs: 25000,
        });
      }
    } catch {
      /* */
    }
  } catch (e) {
    console.warn("[desk] parallel turn error", e.message || e);
    if (jobSessionId && assistantBuf.trim()) {
      appendDeskMessage(jobSessionId, {
        role: "assistant",
        content: assistantBuf.trim(),
        thought: thoughtBuf.trim() || undefined,
        id: draftId,
      });
    }
    emitTurn({
      type: "turn_end",
      sessionId: jobSessionId,
      workerId: worker.id,
      parallel: true,
      error: true,
      reason: e.message || String(e),
    });
  } finally {
    if (jobSessionId) parallelTurns.delete(jobSessionId);
    pool.setBusy(worker, false);
    broadcastAgents();
    // Drain queue for this session onto same worker if possible
    const next = takeNextJob(jobSessionId);
    if (next) {
      queueMicrotask(() => {
        void (async () => {
          try {
            if (next.sessionId && b.sessionId !== next.sessionId) {
              const cwd = findSessionCwd(next.sessionId) || b.cwd;
              await b.loadSession(next.sessionId, cwd);
              pool.bindSession(worker, next.sessionId, cwd);
            }
            await runParallelPrompt(worker, next.text, next.attachments, {
              sessionId: next.sessionId || b.sessionId,
              clientMsgId: next.clientMsgId,
            });
          } catch (err) {
            console.warn("[desk] parallel queue drain failed", err.message);
          }
        })();
      });
    }
  }
}

/** Local connected WS count (legacy). Prefer recent pong for push skip. */
globalThis.__deskWsClientCount = () => {
  let n = 0;
  try {
    for (const c of wss.clients) {
      if (c.readyState === 1) n += 1;
    }
  } catch {
    /* */
  }
  return n;
};

/** Age of last client ping (ms); Infinity if never. Zombie OPEN sockets don't count. */
globalThis.__deskLastClientPongAge = () => {
  if (!lastClientPongAt) return Number.POSITIVE_INFINITY;
  return Date.now() - lastClientPongAt;
};

// Pool agent death — primary worker uses global abandon; parallel ends that turn only
pool.on("agent_exit", (info) => {
  console.warn("[desk] agent_exit pool", info);
  const wid = info.workerId;
  const sid = info.sessionId || null;
  if (wid === pool.defaultId || (!wid && globalBusy)) {
    if (globalBusy || queueTotal() > 0) {
      abandonTurn({
        restart: false,
        reason: "agent_exit",
        hard: true,
      });
    }
  } else if (sid && parallelTurns.has(sid)) {
    parallelTurns.delete(sid);
    const w = pool.workers.get(wid);
    if (w) pool.setBusy(w, false);
    emitTurn({
      type: "turn_end",
      sessionId: sid,
      workerId: wid,
      parallel: true,
      abandoned: true,
      reason: "agent_exit",
    });
  }
  syncDefaultBridge();
  broadcastJson({ type: "agent_exit", ...info });
  broadcastAgents();
});

wss.on("connection", (ws) => {
  console.log("[ws] client connected");
  /** Bumped on load/new so a late ACP resume can't clobber the active session. */
  let loadGen = 0;

  const send = (obj) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  };

  const queueSessionIds = [];
  for (const [sid, q] of sessionQueues) {
    if (sid && sid !== "_pending" && q?.length) queueSessionIds.push(sid);
  }
  send({
    type: "hello",
    agent: bridge.status(),
    ...voiceStatusPayload(),
    ...turnSnapshot(),
  });
  // Reconnecting mid-turn: client stays in working state; updates are broadcast
  if (globalBusy) {
    send({
      type: "turn_start",
      sessionId: activeTurn?.sessionId || bridge.sessionId || null,
      resume: true,
      turnEpoch: globalTurnGen,
    });
  }

  // Per-socket agent_exit notify (pool handler also ends busy turns)
  const onExit = (info) => send({ type: "agent_exit", ...info });
  pool.on("agent_exit", onExit);

  ws.on("close", () => {
    pool.off("agent_exit", onExit);
    // Do NOT abandon ACP turn — phone WS flaps constantly.
    console.log("[ws] client disconnected (turn continues if active)", {
      globalBusy,
      parallel: parallelTurns.size,
      queue: queueTotal(),
      activeSessionId: activeTurn?.sessionId || null,
    });
  });

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      send({ type: "error", error: "bad json" });
      return;
    }

    if (msg.type === "ping") {
      lastClientPongAt = Date.now(); // client is alive (they ping us; we pong)
      send({ type: "pong", t: Date.now() });
      return;
    }

    if (msg.type === "status") {
      send({
        type: "status",
        agent: bridge.status(),
        ...voiceStatusPayload(),
        ...turnSnapshot(),
      });
      return;
    }

    if (msg.type === "ensure") {
      try {
        await bridge.ensure();
        send({
          type: "ready",
          agent: bridge.status(),
          ...turnSnapshot(),
        });
      } catch (e) {
        send({ type: "error", error: e.message || String(e) });
      }
      return;
    }

    if (msg.type === "stop") {
      console.log("[desk] stop requested");
      abandonTurn({ restart: true, reason: "stop" });
      send({ type: "queue_update", remaining: 0, items: [] });
      return;
    }

    if (msg.type === "queue_clear") {
      const snap = clearQueue(msg.sessionId || null);
      send({ type: "queue_update", remaining: snap.remaining, items: snap.items, cleared: true });
      return;
    }

    if (msg.type === "queue_cancel") {
      const snap = cancelQueueItem(msg.clientMsgId || msg.id);
      send({ type: "queue_update", remaining: snap.remaining, items: snap.items });
      return;
    }

    if (msg.type === "queue_list") {
      send({ type: "queue_update", ...queueSnapshot() });
      return;
    }

    if (msg.type === "permission_response") {
      const requestId = msg.requestId ? String(msg.requestId) : "";
      if (!requestId) {
        send({ type: "error", error: "requestId required" });
        return;
      }
      const choice = {
        decision: msg.decision ? String(msg.decision) : undefined,
        optionId: msg.optionId ? String(msg.optionId) : undefined,
        reason: msg.reason ? String(msg.reason) : undefined,
      };
      // Remember pattern when always-allow
      if (choice.decision === "allow_always" && msg.pattern) {
        try {
          const st = loadSettings();
          const pats = Array.isArray(st.allowedToolPatterns) ? [...st.allowedToolPatterns] : [];
          const p = String(msg.pattern).trim().toLowerCase();
          if (p && !pats.includes(p)) {
            pats.push(p);
            saveSettings({ allowedToolPatterns: pats.slice(0, 100) });
            for (const w of pool.workers.values()) w.bridge.setAllowedPatterns(pats);
          }
        } catch {
          /* */
        }
      }
      let ok = false;
      // Try every worker (requestId is unique)
      for (const w of pool.workers.values()) {
        if (w.bridge.resolvePermission(requestId, choice)) {
          ok = true;
          break;
        }
      }
      send({ type: "permission_resolved", requestId, ok, ...choice });
      return;
    }

    /** Answer ask_user_question card */
    if (msg.type === "question_response") {
      const requestId = msg.requestId ? String(msg.requestId) : "";
      if (!requestId) {
        send({ type: "error", error: "requestId required" });
        return;
      }
      let result;
      const action = String(msg.action || "accept").toLowerCase();
      if (action === "skip" || action === "skip_interview") {
        result = { type: "SkipInterview" };
      } else if (action === "chat" || action === "chat_about_this") {
        result = { type: "ChatAboutThis" };
      } else {
        // answers: string | string[] per question index
        const answers = Array.isArray(msg.answers) ? msg.answers : [];
        result = {
          type: "Accepted",
          answers,
          partial_answers: msg.partial_answers ?? msg.partialAnswers ?? null,
        };
      }
      let ok = false;
      for (const w of pool.workers.values()) {
        if (w.bridge.resolveExtRequest(requestId, result)) {
          ok = true;
          break;
        }
      }
      send({ type: "question_resolved", requestId, ok, result });
      return;
    }

    /** Approve / reject exit_plan_mode card */
    if (msg.type === "plan_approval_response") {
      const requestId = msg.requestId ? String(msg.requestId) : "";
      if (!requestId) {
        send({ type: "error", error: "requestId required" });
        return;
      }
      const action = String(msg.action || "approve").toLowerCase();
      let result;
      if (action === "approve" || action === "accepted" || action === "accept") {
        result = {
          type: "Accepted",
          planContent: msg.planContent || msg.plan || undefined,
        };
      } else {
        result = {
          type: "Rejected",
          reason: msg.reason ? String(msg.reason) : "user rejected",
        };
      }
      let ok = false;
      for (const w of pool.workers.values()) {
        if (w.bridge.resolveExtRequest(requestId, result)) {
          ok = true;
          break;
        }
      }
      send({ type: "plan_approval_resolved", requestId, ok, result });
      return;
    }

    /** Mobile client announces itself — apply phoneAlwaysApprove */
    if (msg.type === "client_info") {
      const isMobile = Boolean(msg.isMobile || msg.mobile || msg.phone);
      try {
        const st = loadSettings();
        if (isMobile && st.phoneAlwaysApprove !== false) {
          pool.setPermissionMode("always-approve");
          if (!globalBusy && parallelTurns.size === 0) {
            await bridge.restart();
            syncDefaultBridge();
          }
          send({
            type: "permission_mode",
            mode: "always-approve",
            alwaysApprove: true,
            note: "Phone default: always-approve (settings.phoneAlwaysApprove)",
          });
        } else if (!isMobile && st.permissionMode) {
          pool.setPermissionMode(st.permissionMode);
          send({
            type: "permission_mode",
            mode: pool.permissionMode,
            alwaysApprove: pool.alwaysApprove,
          });
        } else {
          send({ type: "client_info_ack", isMobile });
        }
      } catch (e) {
        send({ type: "error", error: e.message || String(e) });
      }
      return;
    }

    if (msg.type === "set_permission_mode") {
      const mode = String(msg.mode || "ask");
      try {
        saveSettings({ permissionMode: mode });
        pool.setPermissionMode(mode);
        // Restart default agent so spawn flags match (always-approve flag is process-level)
        if (!globalBusy && parallelTurns.size === 0) {
          await bridge.restart();
          syncDefaultBridge();
        }
        send({
          type: "permission_mode",
          mode: pool.permissionMode,
          alwaysApprove: pool.alwaysApprove,
          note: globalBusy
            ? "Mode saved; applies fully after restart / next worker"
            : "Mode applied",
        });
        broadcastJson({
          type: "permission_mode",
          mode: pool.permissionMode,
          alwaysApprove: pool.alwaysApprove,
        });
      } catch (e) {
        send({ type: "error", error: e.message || String(e) });
      }
      return;
    }

    if (msg.type === "new_session") {
      try {
        const cwd = msg.cwd ? path.resolve(String(msg.cwd)) : bridge.cwd;
        // Phase 2: if any turn is live, spawn a parallel worker instead of killing it
        if (globalBusy || parallelTurns.size > 0 || pool.anyBusy()) {
          console.log("[desk] new_session while busy — parallel worker");
          let worker;
          try {
            worker = pool.spawn(cwd);
          } catch (e) {
            send({ type: "error", error: e.message || String(e), code: e.code || "POOL_FULL" });
            return;
          }
          send({ type: "session_status", state: "creating", cwd, parallel: true, workerId: worker.id });
          await worker.bridge.ensure();
          if (cwd) worker.bridge.cwd = cwd;
          const session = await worker.bridge.newSession(cwd);
          pool.bindSession(worker, session.sessionId, cwd);
          trackDeskSession(session.sessionId, cwd);
          console.log(`[desk] parallel new_session → ${session.sessionId} @ ${cwd} (${worker.id})`);
          send({
            type: "session",
            sessionId: session.sessionId,
            cwd,
            mode: "new",
            title: "New chat",
            workerId: worker.id,
            parallel: true,
          });
          send({
            type: "session_status",
            state: "ready",
            sessionId: session.sessionId,
            cwd,
            workerId: worker.id,
          });
          broadcastProjectsTick("new_session");
          broadcastAgents();
          return;
        }

        // Idle primary path (unchanged)
        abandonTurn({ restart: false, hard: true });
        const gen = ++loadGen;
        if (msg.cwd) bridge.cwd = path.resolve(String(msg.cwd));
        send({ type: "session_status", state: "creating", cwd: bridge.cwd });
        await bridge.ensure();
        if (gen !== loadGen) return;
        const session = await bridge.newSession(bridge.cwd);
        console.log(`[desk] new_session → ${session.sessionId} @ ${bridge.cwd}`);
        if (gen !== loadGen) return;
        pool.bindSession(pool.defaultWorker, session.sessionId, bridge.cwd);
        trackDeskSession(session.sessionId, bridge.cwd);
        send({
          type: "session",
          sessionId: session.sessionId,
          cwd: bridge.cwd,
          mode: "new",
          title: "New chat",
        });
        send({ type: "session_status", state: "ready", sessionId: session.sessionId, cwd: bridge.cwd });
        broadcastProjectsTick("new_session");
        broadcastAgents();
      } catch (e) {
        send({ type: "session_status", state: "error", error: e.message || String(e) });
        send({ type: "error", error: e.message || String(e) });
      }
      return;
    }

    /** Dashboard: dispatch a new parallel agent (always tries pool spawn when busy) */
    if (msg.type === "dispatch") {
      try {
        const cwd = msg.cwd ? path.resolve(String(msg.cwd)) : bridge.cwd;
        const promptText = String(msg.text || msg.prompt || "").trim();
        let worker;
        if (!globalBusy && parallelTurns.size === 0 && !pool.anyBusy()) {
          // Use primary when fully idle
          if (msg.cwd) bridge.cwd = cwd;
          await bridge.ensure();
          const session = await bridge.newSession(cwd);
          pool.bindSession(pool.defaultWorker, session.sessionId, cwd);
          trackDeskSession(session.sessionId, cwd);
          send({
            type: "session",
            sessionId: session.sessionId,
            cwd,
            mode: "new",
            title: promptText ? promptText.slice(0, 72) : "New chat",
            dispatched: true,
          });
          broadcastProjectsTick("new_session");
          if (promptText) {
            void runPromptJob(promptText, [], {
              sessionId: session.sessionId,
              clientMsgId: msg.clientMsgId || null,
            });
          }
          broadcastAgents();
          return;
        }
        worker = pool.spawn(cwd);
        await worker.bridge.ensure();
        worker.bridge.cwd = cwd;
        const session = await worker.bridge.newSession(cwd);
        pool.bindSession(worker, session.sessionId, cwd);
        trackDeskSession(session.sessionId, cwd);
        send({
          type: "session",
          sessionId: session.sessionId,
          cwd,
          mode: "new",
          title: promptText ? promptText.slice(0, 72) : "New chat",
          workerId: worker.id,
          parallel: true,
          dispatched: true,
        });
        broadcastProjectsTick("new_session");
        broadcastAgents();
        if (promptText) {
          void runParallelPrompt(worker, promptText, [], {
            sessionId: session.sessionId,
            clientMsgId: msg.clientMsgId || null,
            cwd,
          });
        }
      } catch (e) {
        send({ type: "error", error: e.message || String(e), code: e.code || undefined });
      }
      return;
    }

    if (msg.type === "load_session") {
      const sessionId = msg.sessionId;
      if (!sessionId) {
        send({ type: "error", error: "sessionId required" });
        return;
      }
      try {
        send({ type: "session_status", state: "loading", sessionId });

        if (String(sessionId).startsWith("mail:")) {
          const transcript = loadAgentMailTranscript(sessionId);
          const cwd = transcript.summary?.cwd || msg.cwd || null;
          send({
            type: "session_loaded",
            sessionId,
            cwd,
            messages: transcript.messages || [],
            summary: transcript.summary || null,
            truncated: false,
            agentResumed: false,
            mailOnly: true,
            loadError: undefined,
          });
          send({
            type: "session_status",
            state: "history_only",
            sessionId,
            cwd,
          });
          return;
        }

        const cwd = msg.cwd ? path.resolve(String(msg.cwd)) : findSessionCwd(sessionId);
        const transcript = loadTranscript(sessionId, cwd);

        // CRITICAL: never abandon an in-flight turn just to browse another chat.
        // Phase 2: attach if this session is live on any worker.
        const liveWorker = pool.findBySession(sessionId);
        const sameLive =
          isSessionLive(sessionId) ||
          (globalBusy && bridge.sessionId && String(bridge.sessionId) === String(sessionId));
        const otherBusy =
          (globalBusy && bridge.sessionId && String(bridge.sessionId) !== String(sessionId)) ||
          [...parallelTurns.keys()].some((id) => id !== sessionId);
        const viewOnly = Boolean(msg.viewOnly) || (otherBusy && !sameLive && !liveWorker);

        if (sameLive) {
          const draft =
            (activeTurn?.sessionId === sessionId && partialDraftFromActive()) ||
            (parallelTurns.get(sessionId)
              ? {
                  id: parallelTurns.get(sessionId).draftId,
                  sessionId,
                  content: parallelTurns.get(sessionId).content || "",
                  thought: parallelTurns.get(sessionId).thought || "",
                  tools: parallelTurns.get(sessionId).tools || [],
                  plan: parallelTurns.get(sessionId).plan || [],
                  phase: parallelTurns.get(sessionId).phase || "thinking",
                }
              : null);
          trackDeskSession(sessionId, cwd || liveWorker?.cwd || bridge.cwd);
          send({
            type: "session_loaded",
            sessionId,
            cwd: cwd || liveWorker?.cwd || bridge.cwd,
            messages: transcript.messages || [],
            summary: transcript.summary || null,
            truncated: transcript.truncated || false,
            agentResumed: true,
            turnActive: true,
            partialDraft: draft,
            activeSessionId: sessionId,
            workerId: liveWorker?.id || pool.defaultId,
          });
          send({
            type: "session_status",
            state: "ready",
            sessionId,
            cwd: cwd || liveWorker?.cwd || bridge.cwd,
          });
          send({
            type: "turn_start",
            sessionId,
            resume: true,
            workerId: liveWorker?.id,
            parallel: Boolean(liveWorker && liveWorker.id !== pool.defaultId),
          });
          return;
        }

        if (viewOnly) {
          trackDeskSession(sessionId, cwd);
          send({
            type: "session_loaded",
            sessionId,
            cwd,
            messages: transcript.messages || [],
            summary: transcript.summary || null,
            truncated: transcript.truncated || false,
            agentResumed: false,
            viewOnly: true,
            backgroundTurnSessionId: activeTurn?.sessionId || bridge.sessionId || null,
            activeSessionId: activeTurn?.sessionId || null,
            liveSessionIds: turnSnapshot().liveSessionIds,
            partialDraft: null,
          });
          send({
            type: "session_status",
            state: "history_only",
            sessionId,
            cwd,
          });
          return;
        }

        // Full ACP resume — prefer free worker if primary is busy elsewhere
        let loadBridge = bridge;
        let loadWorker = pool.defaultWorker;
        if (globalBusy || pool.anyBusy()) {
          const free = pool.acquire({ sessionId, cwd, preferFree: true });
          if (free && !free.busy && free.id !== pool.defaultId) {
            loadWorker = free;
            loadBridge = free.bridge;
            console.log("[desk] load_session on parallel worker", free.id);
          } else if (globalBusy) {
            // No free worker — viewOnly fallback rather than kill live turn
            trackDeskSession(sessionId, cwd);
            send({
              type: "session_loaded",
              sessionId,
              cwd,
              messages: transcript.messages || [],
              summary: transcript.summary || null,
              truncated: transcript.truncated || false,
              agentResumed: false,
              viewOnly: true,
              backgroundTurnSessionId: activeTurn?.sessionId || bridge.sessionId || null,
              partialDraft: null,
            });
            send({ type: "session_status", state: "history_only", sessionId, cwd });
            return;
          }
        } else {
          abandonTurn({ restart: false });
        }

        const gen = ++loadGen;
        let loaded = null;
        let loadError = null;
        const RESUME_MS = 12000;
        try {
          loaded = await Promise.race([
            loadBridge.loadSession(sessionId, cwd),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("Session resume timed out")), RESUME_MS),
            ),
          ]);
          if (gen !== loadGen) return;
          if (loaded) {
            trackDeskSession(loaded.sessionId, loaded.cwd || cwd);
            pool.bindSession(loadWorker, loaded.sessionId, loaded.cwd || cwd);
          }
        } catch (e) {
          if (gen !== loadGen) return;
          loadError = e.message || String(e);
          console.warn("[desk] loadSession ACP failed/timeout, still showing transcript:", loadError);
          trackDeskSession(sessionId, cwd);
          if (cwd) loadBridge.cwd = cwd;
          loadBridge.sessionId = null;
          try {
            projectCtxInjected.delete(sessionId);
          } catch {
            /* */
          }
        }
        if (gen !== loadGen) return;
        send({
          type: "session_loaded",
          sessionId: loaded?.sessionId || sessionId,
          cwd: loaded?.cwd || cwd,
          messages: transcript.messages || [],
          summary: transcript.summary || null,
          truncated: transcript.truncated || false,
          loadError: loadError || undefined,
          agentResumed: Boolean(loaded),
          workerId: loadWorker.id,
        });
        send({
          type: "session_status",
          state: loaded ? "ready" : "history_only",
          sessionId: loaded?.sessionId || sessionId,
          cwd: loaded?.cwd || cwd,
          error: loadError || undefined,
        });
        broadcastAgents();
      } catch (e) {
        send({ type: "session_status", state: "error", sessionId, error: e.message || String(e) });
        send({ type: "error", error: e.message || String(e) });
      }
      return;
    }

    if (msg.type === "prompt") {
      const text = String(msg.text || "").trim();
      const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
      const sessionId = msg.sessionId ? String(msg.sessionId) : bridge.sessionId || null;
      const clientMsgId = msg.clientMsgId ? String(msg.clientMsgId) : null;
      if (!text && attachments.length === 0) {
        send({ type: "error", error: "Empty prompt" });
        return;
      }
      const job = { text, attachments, sessionId, clientMsgId };

      // This session already mid-turn (primary or parallel) → enqueue
      if (isSessionLive(sessionId) || (globalBusy && (!sessionId || sessionId === bridge.sessionId || sessionId === activeTurn?.sessionId))) {
        if (isSessionLive(sessionId) || globalBusy) {
          // Same session busy → queue; different session → parallel
          const same =
            (activeTurn?.sessionId && sessionId === activeTurn.sessionId) ||
            (bridge.sessionId && sessionId === bridge.sessionId) ||
            parallelTurns.has(sessionId);
          if (same || !sessionId) {
            enqueuePrompt(job);
            return;
          }
        }
      }

      // Primary busy on another session → run parallel worker for this session
      if ((globalBusy || pool.anyBusy()) && sessionId && !isSessionLive(sessionId)) {
        let worker = pool.findBySession(sessionId);
        if (!worker || worker.busy) {
          worker = pool.acquire({ sessionId, cwd: findSessionCwd(sessionId) || bridge.cwd });
        }
        if (!worker || worker.busy) {
          // Try hard spawn
          try {
            worker = pool.spawn(findSessionCwd(sessionId) || bridge.cwd);
          } catch {
            enqueuePrompt(job);
            return;
          }
        }
        try {
          if (worker.bridge.sessionId !== sessionId) {
            const cwd = findSessionCwd(sessionId) || worker.bridge.cwd;
            console.log("[desk] parallel prompt → load", sessionId.slice(0, 8), worker.id);
            await worker.bridge.loadSession(sessionId, cwd);
            pool.bindSession(worker, sessionId, cwd);
          }
          void runParallelPrompt(worker, text, attachments, {
            sessionId,
            clientMsgId,
          });
        } catch (e) {
          send({ type: "error", error: e.message || String(e) });
        }
        return;
      }

      // Idle path — primary worker
      if (globalBusy) {
        enqueuePrompt(job);
        return;
      }

      // Claim slot synchronously so a second prompt on this tick enqueues
      const claimEpoch = claimBusy("prompt");

      // Idle but prompt targets a different session → load then run
      if (sessionId && bridge.sessionId && sessionId !== bridge.sessionId) {
        try {
          const cwd = findSessionCwd(sessionId) || bridge.cwd;
          console.log("[desk] prompt bind → load", sessionId.slice(0, 8));
          await bridge.loadSession(sessionId, cwd);
          pool.bindSession(pool.defaultWorker, sessionId, cwd);
        } catch (e) {
          // Only release if we still own the claim (abandon may have transferred ownership)
          if (claimEpoch === globalTurnGen) {
            endTurnTerminal({
              sessionId,
              error: true,
              reason: "load_failed",
              epoch: claimEpoch,
            });
          }
          send({ type: "error", error: e.message || String(e) });
          return;
        }
        // Abandon during load?
        if (claimEpoch !== globalTurnGen) {
          console.log("[desk] prompt aborted after load — epoch mismatch");
          return;
        }
        globalBusy = true; // re-assert after await
      }

      void runPromptJob(text, attachments, {
        sessionId: sessionId || bridge.sessionId,
        clientMsgId,
        claimed: true,
      });
      return;
    }

    send({ type: "error", error: `unknown message type: ${msg.type}` });
  });
});

function onListenError(err) {
  if (err && err.code === "EADDRINUSE") {
    console.error(
      `[desk] port ${PORT} already in use — another Grok Desk is running. Exiting this instance.`,
    );
    process.exit(0); // don't crash-loop launchd with unhandled 'error'
  }
  console.error("[desk] server error:", err);
  process.exit(1);
}
server.on("error", onListenError);
wss.on("error", onListenError);

server.listen(PORT, "127.0.0.1", async () => {
  console.log(`\n  Grok Desk  →  http://127.0.0.1:${PORT}`);
  console.log(`  Text chat  →  Grok CLI agent (no API key needed)`);
  console.log(
    `  Voice      →  ${resolveXaiApiKey() ? "xAI key set (Settings or .env)" : "add key in Settings to enable"}`,
  );
  console.log(`  Prefs      →  ${userDataDir()}`);
  console.log(`  Source     →  ${getDeskSourceDir()}\n`);
  // Clean subagent ids that polluted desk-index from earlier builds
  try {
    pruneSubagentsFromDeskIndex();
  } catch {
    /* */
  }
  startSessionWatcher();
  try {
    ensureVapidKeys();
  } catch (e) {
    console.warn("[push] VAPID init failed:", e.message);
  }
  // Warm the agent process only — no orphan session/new
  bridge.ensure().catch((e) => console.warn("[acp] warm start failed:", e.message));
});

function shutdown() {
  console.log("\n[desk] shutting down");
  bridge.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
