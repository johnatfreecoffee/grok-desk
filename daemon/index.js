/**
 * Grok Desk local daemon
 * - HTTP: serves the PWA, status, voice-token mint
 * - WS /ws: chat bridge to `grok agent stdio` (CLI subscription — no API)
 * Voice hits xAI only when POST /api/voice-token is called.
 * Speak (TTS) uses grok-speak + subscription OAuth — no API key.
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
  speakStatusPayload,
  synthesizeSpeak,
  readClip,
  isClipId,
  loadSpeakSettings,
  saveSpeakSettings,
  installSpeakTui,
} from "./speak.js";
import {
  status as foldersStatus,
  setEnabled as setFoldersEnabled,
  saveState as saveFoldersState,
} from "./folders.js";
import { transcribeAudio } from "./stt.js";
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
  warmSessionScan,
  bumpSessionScan,
} from "./session-store.js";
import {
  read as readSessionFeed,
  subscribe as feedSubscribe,
  unsubscribe as feedUnsubscribe,
  poll as feedPoll,
  subscribedSessions,
  sessionOwner,
  ownerSignature,
  ownerCoverage,
  activeSessionsPath,
} from "./session-feed.js";
import { SessionWatchers, startRootWatcher } from "./session-watch.js";
import { hasXaiApiKey, maskXaiKey, saveSecrets } from "./secrets.js";
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
import {
  status as phoneMcpStatus,
  setEnabled as setPhoneMcpEnabled,
  rotateToken as rotatePhoneMcpToken,
  savePublicUrl as savePhoneMcpPublicUrl,
  readToken as readPhoneMcpToken,
} from "./phone-mcp.js";
import { handleBuildApi } from "./routes/build.js";
import {
  runDueAutomations,
  setAutomationFireHandler,
} from "./automations.js";
import {
  handleAuthApi,
  requireSession,
  sessionFromRequest,
  authConfigured,
} from "./local-auth.js";

loadEnv();
ensureUserDataMigrated();

function voiceStatusPayload() {
  const configured = hasXaiApiKey();
  return {
    voiceConfigured: configured,
    voiceKeyMasked: configured ? maskXaiKey() : null,
    ...speakStatusPayload(),
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
  broadcastJson({ type: "permission_request", ...req, sessionId: req?.sessionId ?? null });
});

/** The session a pool worker is bound to right now, or null. */
function workerSessionId(worker) {
  if (!worker) return null;
  return worker.sessionId || worker.bridge?.sessionId || null;
}

// Forward interactive question / plan-approval cards (x.ai/* ext methods)
function wireWorkerExt(worker) {
  if (!worker?.bridge || worker._extWired) return;
  worker._extWired = true;
  const b = worker.bridge;
  // P2: ext_request_cancelled / ext_request_resolved carried no sessionId, so
  // a client with two live chats could not route them. The bridge stays
  // untouched; the sessionId is stamped here from the worker binding.
  const stamp = (type) => (req) =>
    broadcastJson({
      type,
      workerId: worker.id,
      ...req,
      sessionId: req?.sessionId ?? workerSessionId(worker),
    });
  b.on("question_request", stamp("question_request"));
  b.on("plan_approval_request", stamp("plan_approval_request"));
  b.on("ext_request_cancelled", stamp("ext_request_cancelled"));
  b.on("ext_request_resolved", stamp("ext_request_resolved"));
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
    broadcastJson({
      type: "terminal_output",
      workerId: worker.id,
      ...ev,
      sessionId: ev?.sessionId ?? workerSessionId(worker),
    });
  });
  worker.bridge.on("terminal_exit", (ev) => {
    broadcastJson({
      type: "terminal_exit",
      workerId: worker.id,
      ...ev,
      sessionId: ev?.sessionId ?? workerSessionId(worker),
    });
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
/** Load generation for POST /api/load-session (the WS handler has its own). */
let httpLoadGen = 0;

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

  if (url.pathname.startsWith("/api/auth")) {
    return handleAuthApi(req, res);
  }

  // Liveness for Electron / launchd / phone-serve — must stay 200 even when locked.
  if (url.pathname === "/api/health" && req.method === "GET") {
    sendJson(res, 200, { ok: true });
    return true;
  }
  if (url.pathname === "/api/status" && req.method === "GET") {
    const sess = sessionFromRequest(req);
    if (authConfigured() && !sess) {
      sendJson(res, 200, { ok: true, locked: true, port: PORT });
      return true;
    }
    sendJson(res, 200, {
      ok: true,
      port: PORT,
      ...voiceStatusPayload(),
      agent: bridge.status(),
      ...turnSnapshot(),
    });
    return true;
  }

  if (url.pathname.startsWith("/api/") && !requireSession(req, res)) {
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
          activeSessionId: primaryTurnSessionId(),
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
      // P5 — Restart means the whole pool, not just the default worker.
      // `restartAll` existed and was called from nowhere, so every extra worker
      // (and its `grok agent`) survived the user pressing Restart.
      await pool.restartAll();
      syncDefaultBridge();
      const status = bridge.status();
      broadcastAgents();
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

  if (url.pathname === "/api/speak/settings" && req.method === "GET") {
    sendJson(res, 200, { ok: true, settings: loadSpeakSettings(), ...speakStatusPayload() });
    return true;
  }

  if (url.pathname === "/api/speak/settings" && req.method === "POST") {
    try {
      const body = await readBody(req).catch(() => ({}));
      const settings = saveSpeakSettings(body || {});
      sendJson(res, 200, { ok: true, settings, ...speakStatusPayload() });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message || String(e) });
    }
    return true;
  }

  if (url.pathname === "/api/speak/install-tui" && req.method === "POST") {
    try {
      const result = await installSpeakTui();
      sendJson(res, 200, { ...result, ...speakStatusPayload() });
    } catch (e) {
      sendJson(res, e.status || 500, { ok: false, error: e.message || String(e) });
    }
    return true;
  }

  if (url.pathname === "/api/folders" && req.method === "GET") {
    sendJson(res, 200, { ok: true, ...foldersStatus() });
    return true;
  }

  if (url.pathname === "/api/folders" && req.method === "POST") {
    try {
      const body = await readBody(req).catch(() => ({}));
      const patch = {};
      if (body.openOnHover != null) patch.openOnHover = body.openOnHover;
      if (body.defaultOpen != null) patch.defaultOpen = body.defaultOpen;
      if (body.lastPath != null) patch.lastPath = body.lastPath;
      if (Object.keys(patch).length) saveFoldersState(patch);
      if (typeof body.enabled === "boolean") setFoldersEnabled(body.enabled);
      sendJson(res, 200, { ok: true, ...foldersStatus() });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message || String(e) });
    }
    return true;
  }

  if (url.pathname === "/api/stt" && req.method === "POST") {
    try {
      const body = await readBody(req).catch(() => ({}));
      const b64 = String(body.audioBase64 || "").replace(/\s/g, "");
      if (!b64) {
        sendJson(res, 400, { ok: false, error: "No audio" });
        return true;
      }
      const result = await transcribeAudio({
        buffer: Buffer.from(b64, "base64"),
        mime: body.mime,
      });
      sendJson(res, 200, result);
    } catch (e) {
      sendJson(res, e.status || 500, { ok: false, error: e.message || String(e) });
    }
    return true;
  }

  if (url.pathname === "/api/speak" && req.method === "POST") {
    try {
      const body = await readBody(req).catch(() => ({}));
      const result = await synthesizeSpeak({
        text: body.text,
        mode: body.mode,
        voice: body.voice,
      });
      sendJson(res, 200, result);
    } catch (e) {
      sendJson(res, e.status || 500, { ok: false, error: e.message || String(e) });
    }
    return true;
  }

  const clipMatch = url.pathname.match(/^\/api\/speak\/clip\/([^/]+?)(?:\.mp3)?$/);
  if (clipMatch && req.method === "GET") {
    const id = decodeURIComponent(clipMatch[1]).replace(/\.mp3$/i, "");
    const clip = isClipId(id) ? readClip(id) : null;
    if (!clip?.audioPath || !fs.existsSync(clip.audioPath)) {
      sendJson(res, 404, { ok: false, error: "clip not found" });
      return true;
    }
    const stat = fs.statSync(clip.audioPath);
    res.writeHead(200, {
      "Content-Type": "audio/mpeg",
      "Content-Length": stat.size,
      "Cache-Control": "private, max-age=86400",
    });
    fs.createReadStream(clip.audioPath).pipe(res);
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

  // GET /api/sessions/:id/feed?from=<seq>&to=<seq>&limit=<n>&cwd=
  //
  // Without `to` this is the plain projector read (P1).
  // With `to` it is P5's "load earlier": one bounded WINDOW of older history,
  // `from` exclusive → `to` inclusive. See `readFeedWindow`.
  const feedMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/feed$/);
  if (feedMatch && req.method === "GET") {
    const sessionId = decodeURIComponent(feedMatch[1]);
    const cwd = url.searchParams.get("cwd") || undefined;
    const fromRaw = Number(url.searchParams.get("from"));
    const toRaw = Number(url.searchParams.get("to"));
    const limitRaw = Number(url.searchParams.get("limit"));
    try {
      if (Number.isFinite(toRaw) && toRaw > 0) {
        sendJson(
          res,
          200,
          readFeedWindow(sessionId, {
            from: Number.isFinite(fromRaw) ? fromRaw : 0,
            to: toRaw,
            cwd,
          }),
        );
        return true;
      }
      sendJson(
        res,
        200,
        readSessionFeed(sessionId, {
          from: Number.isFinite(fromRaw) ? fromRaw : 0,
          limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined,
          cwd,
        }),
      );
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message || String(e), events: [] });
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

      // P4 — a live `grok` owns this session: serve the transcript, attach
      // nothing. Same refusal the WS handler makes; this route used to be the
      // unguarded way in.
      const blocked = ownershipBlock(sessionId);
      if (blocked) {
        console.log(
          `[own] refusing POST /api/load-session ${String(sessionId).slice(0, 8)} — ${blocked.message}`,
        );
        trackDeskSession(sessionId, cwd || blocked.owner.cwd);
        sendJson(res, 200, {
          ok: true,
          sessionId,
          cwd: cwd || blocked.owner.cwd || null,
          messages: transcript.messages || [],
          summary: transcript.summary || null,
          truncated: transcript.truncated || false,
          agentResumed: false,
          viewOnly: true,
          readOnly: true,
          owner: blocked.owner,
          ownerCoverage: ownerCoverage(),
          activeSessionId: primaryTurnSessionId(),
        });
        return true;
      }

      // Match the WS rules. This used to look at `globalBusy` alone, so a
      // parallel-worker turn on another session was invisible here and the HTTP
      // route would happily steal the primary worker out from under it.
      const liveWorker = pool.findBySession(sessionId);
      const sameLive =
        isSessionLive(sessionId) ||
        (globalBusy && bridge.sessionId && String(bridge.sessionId) === String(sessionId));
      const otherBusy =
        (globalBusy && bridge.sessionId && String(bridge.sessionId) !== String(sessionId)) ||
        [...parallelTurns.keys()].some((id) => String(id) !== String(sessionId));
      if (!sameLive && !liveWorker && otherBusy) {
        sendJson(res, 200, {
          ok: true,
          sessionId,
          cwd,
          messages: transcript.messages || [],
          summary: transcript.summary || null,
          truncated: transcript.truncated || false,
          agentResumed: false,
          viewOnly: true,
          activeSessionId: primaryTurnSessionId(),
          liveSessionIds: turnSnapshot().liveSessionIds,
        });
        return true;
      }

      // Load-generation guard, which this route never had: a second HTTP load
      // that starts while this ACP resume is in flight wins, and this response
      // must not then re-bind the worker to a session already left behind.
      // (The WS handler keeps its own per-socket generation.)
      const gen = ++httpLoadGen;
      const loaded = await bridge.loadSession(sessionId, cwd);
      if (gen !== httpLoadGen) {
        sendJson(res, 200, {
          ok: true,
          sessionId,
          cwd,
          messages: transcript.messages || [],
          summary: transcript.summary || null,
          truncated: transcript.truncated || false,
          agentResumed: false,
          superseded: true,
          activeSessionId: primaryTurnSessionId(),
        });
        return true;
      }
      trackDeskSession(loaded.sessionId, loaded.cwd || cwd);
      pool.bindSession(pool.defaultWorker, loaded.sessionId, loaded.cwd || cwd);
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

  if (url.pathname === "/api/phone-mcp" && req.method === "GET") {
    try {
      sendJson(res, 200, { ok: true, ...(await phoneMcpStatus()) });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message || String(e) });
    }
    return true;
  }

  if (url.pathname === "/api/phone-mcp" && req.method === "POST") {
    try {
      const body = await readBody(req).catch(() => ({}));
      if (typeof body.publicUrl === "string") savePhoneMcpPublicUrl(body.publicUrl);
      if (typeof body.enabled === "boolean") await setPhoneMcpEnabled(body.enabled);
      sendJson(res, 200, { ok: true, ...(await phoneMcpStatus()) });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message || String(e) });
    }
    return true;
  }

  if (url.pathname === "/api/phone-mcp/rotate" && req.method === "POST") {
    try {
      sendJson(res, 200, { ok: true, ...(await rotatePhoneMcpToken()) });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message || String(e) });
    }
    return true;
  }

  if (url.pathname === "/api/phone-mcp/token" && req.method === "GET") {
    try {
      const token = readPhoneMcpToken();
      if (!token) {
        sendJson(res, 404, { ok: false, error: "no token" });
        return true;
      }
      sendJson(res, 200, { token });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message || String(e) });
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

/* ------------------------------------------------------------- feed wire */

/** Hard cap on one `feed` frame — a client that has been away paginates. */
const FEED_MAX_EVENTS = Number(process.env.DESK_FEED_MAX_EVENTS || 500);

/* -------------------------------------------------- P5 "load earlier" */

/**
 * `read({from: 0})` means "the tail window", so seq 1 is unreachable with any
 * positive integer cursor. A fractional cursor below 1 asks for everything
 * from the very first event without tripping the tail-window branch.
 */
const FEED_HISTORY_START = 0.5;
/**
 * Scan budget for a history window.
 *
 * The projector keeps a bounded ring; paging into evicted history makes it
 * rescan from byte 0 with `maxBuffer = max(limit, 3000)`. With the default
 * limit that ring evicts the OLDEST matches — exactly the ones "load earlier"
 * is asking for — so the window has to name a budget big enough to hold the
 * whole scan. The window itself is then sliced to `to`, so what crosses the
 * wire stays bounded by the page the client asked for.
 */
const FEED_SCAN_LIMIT = Number(process.env.DESK_FEED_SCAN_LIMIT || 500_000);

/** How often idle ACP workers are reaped. */
const POOL_REAP_TICK_MS = Number(process.env.DESK_POOL_REAP_MS || 60_000);
/** SIGTERM → SIGKILL grace for the pool's `grok agent` children. */
const SHUTDOWN_GRACE_MS = Number(process.env.DESK_SHUTDOWN_GRACE_MS || 700);
/** Minimum gap between two phase markers on the wire. */
const FEED_PHASE_MIN_MS = Number(process.env.DESK_FEED_PHASE_MS || 250);

/**
 * One bounded window of older history: events with `from < seq <= to`.
 *
 * This is what backs "load earlier". The client folds the window through a
 * throwaway reducer and prepends the rows it produces; its live cursor and its
 * live subscription are untouched.
 *
 * @param {string} sessionId
 * @param {{from?:number, to:number, cwd?:string}} opts
 */
function readFeedWindow(sessionId, { from = 0, to, cwd } = {}) {
  const toSeq = Math.floor(Number(to));
  if (!Number.isFinite(toSeq) || toSeq <= 0) {
    return { ok: false, error: "to required", sessionId, events: [] };
  }
  const wanted = Number(from);
  const fromSeq =
    Number.isFinite(wanted) && wanted > FEED_HISTORY_START ? wanted : FEED_HISTORY_START;
  // Always scan from the very first event. Paging into evicted history rescans
  // the whole log anyway, and the full scan is the only way to know the
  // session's oldest seq — which is what tells the client it has reached the
  // start instead of guessing from an empty page.
  const payload = readSessionFeed(sessionId, {
    from: FEED_HISTORY_START,
    limit: FEED_SCAN_LIMIT,
    cwd,
  });
  if (!payload.ok) {
    return { ok: false, error: payload.error || "session not found", sessionId, events: [] };
  }
  const all = Array.isArray(payload.events) ? payload.events : [];
  const oldestSeq = all.length ? Number(all[0].seq) : 0;
  // `phase` is 88% of all events and drives nothing but the live indicator —
  // history has no live indicator, so it never goes on the wire here.
  const events = all.filter(
    (e) => Number(e.seq) > fromSeq && Number(e.seq) <= toSeq && e.kind !== "phase",
  );
  return {
    ok: true,
    sessionId: payload.sessionId,
    cwd: payload.cwd,
    from: fromSeq,
    to: toSeq,
    /** Seq of the very first event on disk — the client's stop condition. */
    oldestSeq,
    /** This window already reaches the first event of the session. */
    atStart: fromSeq <= oldestSeq,
    events,
    count: events.length,
    /** Cheap proof the scan itself was not truncated by the projector's ring. */
    scanned: all.length,
    firstSeq: events.length ? Number(events[0].seq) : null,
    lastSeq: events.length ? Number(events[events.length - 1].seq) : null,
  };
}

/**
 * Collapse consecutive identical `phase` events and rate-limit what is left.
 *
 * `phase_changed` is 88% of everything the CLI writes (163,785 of 186,302
 * events swept; one session alone had 2,527). Left alone it drowns real
 * content. Nothing is lost: the `feed` frame's own top-level `phase` always
 * carries the latest value, and a superseded marker is only ever replaced by a
 * NEWER one at the same position, so seq stays monotonic and no non-phase event
 * is ever reordered.
 *
 * @param {object[]} events
 * @param {{ lastPhase: string|null, lastPhaseAt: number, dropped: number }} st
 */
function coalescePhaseEvents(events, st) {
  const out = [];
  for (const ev of events) {
    if (ev.kind !== "phase") {
      out.push(ev);
      continue;
    }
    if (ev.phase === st.lastPhase) {
      st.dropped += 1; // consecutive identical phase — pure noise
      continue;
    }
    st.lastPhase = ev.phase;
    const at = Number(ev.at) || Date.now();
    const prev = out[out.length - 1];
    if (prev && prev.kind === "phase" && at - st.lastPhaseAt < FEED_PHASE_MIN_MS) {
      out[out.length - 1] = ev; // supersede in place — never reorder
      st.dropped += 1;
      continue;
    }
    st.lastPhaseAt = at;
    out.push(ev);
  }
  return out;
}

/** Push sidebar refresh to every open Desk client (CLI/fs changes too). */
function broadcastProjectsTick(reason = "change") {
  broadcastJson({ type: "projects_tick", reason, at: Date.now() });
}

/**
 * P2: fs watchers for the sessions that at least one socket is tailing.
 * Membership comes from session-feed's own subscriber map — nothing else
 * decides what is watched, so a watcher dies with the last subscriber.
 */
const sessionWatchers = new SessionWatchers({
  onFire: (sessionId) => feedPoll(sessionId),
});

/** Reconcile watchers after any subscribe / unsubscribe / socket close. */
function syncSessionWatchers() {
  try {
    return sessionWatchers.sync(subscribedSessions());
  } catch (e) {
    console.warn("[watch] sync failed:", e.message);
    return sessionWatchers.stats();
  }
}

/* ------------------------------------------------------- P4 · ownership */

/**
 * The clobber guard.
 *
 * `chat_history.jsonl` is whole-file rewritten by the CLI, not appended: at the
 * end of a turn each process serialises ITS OWN view of the conversation. If a
 * terminal `grok` and a Desk ACP worker both hold the same session, the last
 * writer wins and the other process's turns are gone. Desk therefore never
 * attaches an ACP worker to a session a live `grok` owns — it projects the
 * transcript from disk instead and says so.
 *
 * @returns {{owner:object, message:string}|null} null = safe to attach
 */
function ownershipBlock(sessionId) {
  if (!sessionId) return null;
  let owner = null;
  try {
    owner = sessionOwner(sessionId);
  } catch (e) {
    console.warn("[own] probe failed:", e.message);
    return null;
  }
  if (!owner) return null;
  const where = owner.kind === "headless" ? "a headless grok run" : "a terminal grok";
  return {
    owner,
    message:
      `Open in ${where} (pid ${owner.pid}) — read-only here until it exits. ` +
      `Attaching would let the two processes overwrite each other's turns.`,
  };
}

/**
 * Auto-takeover: push ownership transitions without waiting for a page reload.
 *
 * Ownership lives in ~/.grok/active_sessions.json and in the process table.
 * Neither touches the session directory, so the owner exiting fires no fs event
 * and produces no new seq — `poll()` would have nothing to send and the
 * composer would stay locked until the user reloaded.
 *
 * A tick, deliberately, not an fs.watch: on macOS Node's fs.watch is
 * FSEvents-backed and a watch on ~/.grok reports changes from deep inside
 * ~/.grok/sessions too, so it would wake on every append of every one of ~950
 * sessions. This costs one small JSON read per SUBSCRIBED session per tick and
 * nothing at all when nobody is tailing anything. It also catches the case a
 * file watch cannot see: a headless run whose pid simply vanished, leaving its
 * row (or no row at all) behind.
 *
 * Only sessions whose owner actually changed are pushed.
 */
const OWNER_TICK_MS = Number(process.env.DESK_OWNER_TICK_MS || 1000);
/** sessionId → last seen owner signature ("" = nobody). */
const ownerSigs = new Map();
let ownerTimer = null;

function ownershipTick(reason = "tick") {
  let changed = 0;
  const seen = new Set();
  for (const sid of subscribedSessions()) {
    seen.add(sid);
    let sig = "";
    try {
      sig = ownerSignature(sid);
    } catch {
      continue;
    }
    if (ownerSigs.get(sid) === sig) continue;
    const had = ownerSigs.has(sid);
    ownerSigs.set(sid, sig);
    if (!had) continue; // first sighting: subscribe() already sent the truth
    changed += 1;
    console.log(
      `[own] ${sid.slice(0, 8)} owner → ${sig || "none"} (${reason}) — pushing takeover`,
    );
    try {
      feedPoll(sid, { force: true });
    } catch (e) {
      console.warn("[own] force poll failed:", e.message);
    }
  }
  for (const sid of [...ownerSigs.keys()]) if (!seen.has(sid)) ownerSigs.delete(sid);
  return changed;
}

function startOwnershipWatcher() {
  const cov = ownerCoverage();
  console.log(
    `[own] ownership from ${activeSessionsPath()} + the process table — registry:${cov.registry} ` +
      `resumed-headless:${cov.resumedHeadless} new-headless:${cov.newHeadless} ` +
      `(a headless run that opened its own session id is not attributable to it)`,
  );
  ownerTimer = setInterval(() => ownershipTick("tick"), OWNER_TICK_MS);
  if (typeof ownerTimer.unref === "function") ownerTimer.unref();
}

/**
 * Watch ~/.grok/sessions so CLI activity shows up in Desk live.
 *
 * P2 retired the recursive tree watch over ~950 session dirs. This is now ONE
 * non-recursive watcher: it notices project groups appearing / disappearing and
 * keeps feeding the sidebar's `projects_tick`. Live conversation tail is a
 * per-session watcher instead (see sessionWatchers above), so a busy turn no
 * longer makes every client re-scan the whole sidebar.
 */
function startSessionWatcher() {
  const root = sessionsRoot();
  try {
    if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  } catch {
    /* */
  }
  const w = startRootWatcher({
    root,
    onChange: () => {
      // P7: the group-level tick is the invalidation seam for session-store's
      // shared directory snapshot. Drop it here rather than rescanning per id.
      bumpSessionScan();
      broadcastProjectsTick("fs");
      // A session dir a client is already subscribed to may have just appeared.
      syncSessionWatchers();
    },
  });
  console.log(
    `[desk] watching sessions root${w.ok ? "" : " (FAILED — sidebar falls back to client poll)"}: ${root}`,
  );
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
/**
 * The session a primary claim is FOR, from claimBusy() until activeTurn exists.
 * loadSession() in that window can take seconds; without this the snapshot has
 * to guess (it used to guess `bridge.sessionId` — the previous chat).
 */
let claimSessionId = null;
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
/** Last time any WS client answered pong (push skip needs liveness, not mere OPEN) */
let lastClientPongAt = 0;

/**
 * P5 — NO TIMER MAY EVER END A TURN.
 *
 * There used to be two: an 18-minute wall clock and a 6-minute stall watchdog,
 * both firing `abandonTurn({ restart: true })` — they killed the turn AND
 * restarted the agent. A factory phase runs far longer than 18 minutes and a
 * single long tool call is quiet for far longer than 6, so both fired on
 * healthy turns and destroyed real work.
 *
 * `turn_ended` in `events.jsonl` is ground truth now and P4's ownership probe
 * says whether the process is still alive. A turn that has genuinely gone
 * quiet surfaces as a badge (`lastActivityAt` in `turnSnapshot()`) next to the
 * Stop button — a decision the user makes, never a silent kill.
 */
const QUIET_BADGE_MS = 6 * 60 * 1000;

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

/**
 * Queue snapshot for UI.
 *
 * P2: pass a `sessionId` and the snapshot is scoped to that chat — `remaining`
 * and `items` describe THAT session, not an aggregate across every session.
 * `sessionIds` / `totalRemaining` still carry the global picture for the
 * sidebar. Passing null keeps the old aggregate shape (hello / status / a
 * legacy `queue_list`).
 */
function queueSnapshot(sessionId = null) {
  const want = sessionId == null ? null : String(sessionId);
  const items = [];
  for (const [sid, q] of sessionQueues) {
    if (!q?.length) continue;
    const rowSid = sid === "_pending" ? null : sid;
    if (want != null && String(rowSid) !== want) continue;
    q.forEach((job, i) => {
      items.push({
        index: i,
        sessionId: rowSid,
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
  const total = queueTotal();
  return {
    sessionId: want,
    remaining: want == null ? total : items.length,
    totalRemaining: total,
    items,
    sessionIds: queueSessionIds(),
  };
}

/** Broadcast one session's queue state. P2: never an aggregate across sessions. */
function emitQueueUpdate(sessionId, extra = {}) {
  const snap = queueSnapshot(sessionId ?? null);
  emitTurn({ type: "queue_update", ...snap, ...extra });
  return snap;
}

function clearQueue(sessionId = null) {
  if (sessionId) {
    sessionQueues.delete(sessionId);
    sessionQueues.delete(String(sessionId));
  } else {
    sessionQueues.clear();
  }
  return emitQueueUpdate(sessionId ?? null, { cleared: true });
}

function cancelQueueItem(clientMsgId) {
  if (!clientMsgId) return queueSnapshot(null);
  let hitSid = null;
  for (const [sid, q] of sessionQueues) {
    const idx = q.findIndex((j) => j.clientMsgId && j.clientMsgId === clientMsgId);
    if (idx >= 0) {
      q.splice(idx, 1);
      hitSid = sid === "_pending" ? null : sid;
      if (!q.length) sessionQueues.delete(sid);
      break;
    }
  }
  return emitQueueUpdate(hitSid);
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

/**
 * The session the PRIMARY turn is for, or null when the primary is idle.
 *
 * P2: this used to fall back to `bridge.sessionId`, so a parallel-only turn —
 * or the claim window between claimBusy() and activeTurn existing — named a
 * session that was not live and the client marked the wrong chat "working".
 * `claimSessionId` covers the load window honestly instead of guessing.
 */
function primaryTurnSessionId() {
  if (!globalBusy) return null;
  return activeTurn?.sessionId || claimSessionId || null;
}

/** The sessions that really have a turn in flight right now. */
function liveSessionIdSet() {
  const primary = primaryTurnSessionId();
  const defaultSid =
    pool.defaultWorker?.sessionId || pool.defaultWorker?.bridge?.sessionId || null;
  const ids = new Set();
  if (primary) ids.add(String(primary));
  for (const sid of parallelTurns.keys()) if (sid) ids.add(String(sid));
  for (const sid of pool.busySessionIds()) {
    if (!sid) continue;
    // The primary worker keeps its last binding while idle-but-claimed; only
    // trust it when the primary turn actually names that session.
    if (defaultSid && String(sid) === String(defaultSid)) {
      if (primary && String(primary) === String(sid)) ids.add(String(sid));
      continue;
    }
    ids.add(String(sid));
  }
  return [...ids];
}

/** Single source of truth for hello / status / GET /api/turn */
function turnSnapshot() {
  const agents = pool.list();
  return {
    turnActive: Boolean(globalBusy) || parallelTurns.size > 0,
    turnEpoch: globalTurnGen,
    activeSessionId: primaryTurnSessionId(),
    bridgeSessionId: bridge.sessionId || null,
    phase: activeTurn?.phase || null,
    turnStartedAt: activeTurn?.startedAt || null,
    lastActivityAt: activeTurn?.lastActivityAt || null,
    // P5 — the badge that replaced the stall watchdog. It reports; it never acts.
    turnQuiet: turnQuietMs() >= QUIET_BADGE_MS,
    turnQuietMs: turnQuietMs(),
    partialDraft: partialDraftFromActive(),
    parallelDrafts: parallelDrafts(),
    liveSessionIds: liveSessionIdSet(),
    queueRemaining: queueTotal(),
    queueSessionIds: queueSessionIds(),
    queueItems: queueSnapshot(null).items,
    agentAlive: Boolean(bridge.status().agentAlive),
    pool: pool.status(),
    agents,
  };
}

function broadcastAgents() {
  broadcastJson({ type: "agents_roster", agents: pool.list(), ...turnSnapshot() });
}

function clearQueueDrainTimer() {
  if (queueDrainTimer) {
    clearTimeout(queueDrainTimer);
    queueDrainTimer = null;
  }
}

/**
 * Stamp real stream activity on the live turn.
 *
 * This used to also (re)arm the stall watchdog. It no longer arms anything:
 * the stamp is read by `turnSnapshot()` so the UI can badge a quiet turn.
 */
function touchTurnActivity() {
  if (!activeTurn) return;
  activeTurn.lastActivityAt = new Date().toISOString();
}

/** How long the live turn has been silent, in ms. 0 when no turn is running. */
function turnQuietMs() {
  if (!globalBusy || !activeTurn) return 0;
  const last = Date.parse(activeTurn.lastActivityAt || activeTurn.startedAt || "");
  if (!Number.isFinite(last)) return 0;
  return Math.max(0, Date.now() - last);
}

/**
 * Claim busy slot for a new turn. Does NOT bump gen (abandon does).
 * Returns claimEpoch (= current globalTurnGen) for ownership checks after await.
 */
function claimBusy(label = "claim", sessionId = null) {
  globalBusy = true;
  claimSessionId = sessionId ? String(sessionId) : null;
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
  claimSessionId = null;
  pool.setBusy(pool.defaultWorker, false);
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
    globalBusy = false;
    activeTurn = null;
    claimSessionId = null;
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
  if (hard) sessionQueues.clear();
  globalBusy = false;
  activeTurn = null;
  claimSessionId = null;
  pool.setBusy(pool.defaultWorker, false);
  try {
    bridge.flushPermissions?.(reason);
  } catch {
    /* */
  }
  bridge.loadToken = (bridge.loadToken || 0) + 1; // invalidate in-flight loads
  if (wasBusy) {
    emitQueueUpdate(endedSid, { cleared: hard });
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

/**
 * Stop exactly ONE session.
 *
 * P2: `stop` used to be global and untargeted — a phone pressing Stop killed
 * the Mac's turn and cleared every queue. Now it drops only that session's
 * queued work and cancels only the process actually running it:
 *   - parallel turn  → cancel that worker's session (its own agent process)
 *   - primary turn   → abandon the primary turn, soft, so other queues survive
 *   - neither        → just drop that session's queue
 *
 * @returns {{ sessionId: string, stopped: boolean, scope: string, queued: number }}
 */
function stopSession(sessionId) {
  const sid = String(sessionId);
  const queued = sessionQueues.get(sid)?.length || 0;
  const out = { sessionId: sid, stopped: false, scope: "none", queued };
  if (queued) {
    sessionQueues.delete(sid);
    out.stopped = true;
    out.scope = "queue";
  }

  const parallel = parallelTurns.get(sid);
  if (parallel) {
    const worker = pool.workers.get(parallel.workerId) || pool.findBySession(sid);
    if (worker) {
      try {
        worker.bridge.flushPermissions?.("stop");
      } catch {
        /* */
      }
      // runParallelPrompt's catch/finally emits turn_end for THIS session only.
      void worker.bridge.cancelSession().catch(() => {});
    }
    out.stopped = true;
    out.scope = "parallel";
    console.log("[desk] stop → parallel", sid.slice(0, 8), parallel.workerId);
    emitQueueUpdate(sid, { cleared: Boolean(queued) });
    return out;
  }

  const primaryLive =
    (activeTurn?.sessionId && String(activeTurn.sessionId) === sid) ||
    (globalBusy && claimSessionId && String(claimSessionId) === sid) ||
    (globalBusy && bridge.sessionId && String(bridge.sessionId) === sid);
  if (primaryLive) {
    console.log("[desk] stop → primary", sid.slice(0, 8));
    // hard:false — never clear another session's queue.
    abandonTurn({ restart: true, reason: "stop", hard: false });
    out.stopped = true;
    out.scope = "primary";
    return out;
  }

  console.log("[desk] stop → nothing live for", sid.slice(0, 8), `(queued ${queued})`);
  emitQueueUpdate(sid, { cleared: Boolean(queued) });
  return out;
}

function enqueuePrompt(job) {
  const sid = job.sessionId || "_pending";
  if (!sessionQueues.has(sid)) sessionQueues.set(sid, []);
  // Ensure every job has an id for cancel
  if (!job.clientMsgId) {
    job.clientMsgId = `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  }
  sessionQueues.get(sid).push(job);
  const snap = queueSnapshot(job.sessionId || null);
  emitTurn({
    type: "queued",
    position: sessionQueues.get(sid).length,
    remaining: snap.remaining,
    totalRemaining: snap.totalRemaining,
    text: job.text,
    sessionId: job.sessionId || null,
    clientMsgId: job.clientMsgId || null,
    items: snap.items,
    sessionIds: snap.sessionIds,
  });
  return snap.totalRemaining;
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
          claimSessionId = next.sessionId ? String(next.sessionId) : null;
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

  if (!opts.claimed) claimBusy("runPromptJob", opts.sessionId || null);
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
  claimSessionId = null; // activeTurn now names the session honestly
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

    // Named session → load it. Never session/new for a real CLI/Desk id.
    if (opts.sessionId) {
      if (bridge.sessionId !== opts.sessionId) {
        const cwd = findSessionCwd(opts.sessionId) || bridge.cwd;
        console.log("[desk] runPromptJob load", String(opts.sessionId).slice(0, 8));
        await bridge.loadSession(opts.sessionId, cwd);
        pool.bindSession(pool.defaultWorker, opts.sessionId, cwd);
      }
    } else if (!bridge.sessionId) {
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

    /*
     * P5 — the mid-turn shadow write is gone.
     *
     * `shadowPartial()` re-serialised the whole `desk-messages.json` on every
     * chunk so a phone reload could see progress. The feed does that from
     * `updates.jsonl` now, at the cursor, with no third copy to keep honest.
     */

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
            broadcastPartial();
          }
        } else if (kind === "agent_thought_chunk") {
          const t = update.content?.text ?? update.text ?? "";
          if (t) {
            thoughtBuf += t;
            if (activeTurn) activeTurn.thought = thoughtBuf;
            touchTurnActivity();
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
        claimSessionId = next.sessionId ? String(next.sessionId) : null;
        pool.setBusy(pool.defaultWorker, true);
        activeTurn = null;
        emitQueueUpdate(next.sessionId || null, { starting: true });
        clearQueueDrainTimer();
        queueDrainTimer = setTimeout(() => {
          queueDrainTimer = null;
          void startQueuedJob(next);
        }, 10);
      } else {
        globalBusy = false;
        claimSessionId = null;
        pool.setBusy(pool.defaultWorker, false);
        activeTurn = null;
        emitQueueUpdate(jobSessionId || null);
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
  const epoch = claimBusy("queue-drain", next.sessionId || null);
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
    claimSessionId = next.sessionId ? String(next.sessionId) : claimSessionId;
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
        claimSessionId = more.sessionId ? String(more.sessionId) : null;
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
  broadcastJson({ type: "agent_exit", ...info, sessionId: info?.sessionId ?? null });
  broadcastAgents();
});

wss.on("connection", (ws, req) => {
  if (!sessionFromRequest(req)) {
    ws.close(4401, "auth required");
    return;
  }
  console.log("[ws] client connected");
  /** Bumped on load/new so a late ACP resume can't clobber the active session. */
  let loadGen = 0;

  const send = (obj) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  };

  /**
   * Every WS-level error names the session it is about. `sessionId: null` means
   * genuinely unknowable (a frame we could not even parse), never "didn't try".
   */
  const sendError = (error, opts = {}) => {
    const frame = {
      type: "error",
      sessionId: opts.sessionId ? String(opts.sessionId) : null,
      error: error instanceof Error ? error.message || String(error) : String(error),
    };
    if (opts.code) frame.code = opts.code;
    send(frame);
  };

  /* ------------------------------------------------- P2 feed subscriptions */

  /**
   * Subscriptions are PER SOCKET. Mac and phone can tail the same session at
   * different cursors; each keeps its own handle and its own phase state.
   *
   * `lastSeq` belongs to the projector (it moves it on every read). `sentSeq`
   * belongs to us: the last seq this socket actually shipped for this session.
   * @type {Map<string, {id:number,sessionId:string,lastSeq:number,sentSeq:number}>}
   */
  const feedSubs = new Map();
  /** sessionId → phase coalescing state for THIS socket. */
  const feedPhase = new Map();

  /**
   * Send one `feed` frame and advance this socket's cursor.
   *
   * Cursor arithmetic uses the RAW event list so phase coalescing can never
   * make the client skip an event: we advance to the last raw seq we saw and
   * only then drop the phase noise from what goes on the wire.
   *
   * P5 — `fromSeq` is the label that tells the client what this frame CONTINUES
   * FROM, so it is computed from the events the frame carries, not from
   * `handle.lastSeq` at send time. `handle.lastSeq` is owned by the projector:
   * `subscribe()` and `poll()` both slam it to the file's newest seq BEFORE
   * calling us, which is routinely ahead of the events in this frame. Labelling
   * from it manufactured a phantom gap on every catch-up and on every capped
   * delta. `sentSeq` is ours: the last seq this socket actually put on the wire
   * for this session, so a label that is ahead of the client's cursor is now
   * real evidence of loss. (The client keeps its own defensive check.)
   */
  const deliverFeed = (sessionId, handle, payload, extra = {}) => {
    if (ws.readyState !== ws.OPEN) return;
    const baseline = Number.isFinite(handle.sentSeq) ? handle.sentSeq : handle.lastSeq;
    if (!payload || payload.ok === false) {
      const fromSeq = baseline;
      send({
        type: "feed",
        sessionId,
        fromSeq,
        seq: fromSeq,
        events: [],
        live: false,
        phase: null,
        owner: payload?.owner ?? null,
        context: null,
        subagents: [],
        sessionKind: null,
        turn: null,
        truncated: false,
        hasMore: false,
        working: false,
        error: payload?.error || "session not found",
        ...extra,
      });
      return;
    }
    // Cap the frame BEFORE coalescing so the cursor is exact: we advance to the
    // last RAW seq we are shipping, then drop phase noise from that window.
    // A client that has been away pages forward instead of taking a 50 MB frame.
    let raw = Array.isArray(payload.events) ? payload.events : [];
    let capped = false;
    if (raw.length > FEED_MAX_EVENTS) {
      raw = raw.slice(0, FEED_MAX_EVENTS);
      capped = true;
    }
    const cursorSeq = raw.length ? raw[raw.length - 1].seq : payload.seq;
    // The label the client judges continuity by: never ahead of the first event
    // this frame actually carries.
    const fromSeq = raw.length
      ? Math.min(baseline, Number(raw[0].seq) - 1)
      : Math.min(baseline, Number(payload.seq) || baseline);
    let st = feedPhase.get(sessionId);
    if (!st) {
      st = { lastPhase: null, lastPhaseAt: 0, dropped: 0 };
      feedPhase.set(sessionId, st);
    }
    const before = st.dropped;
    const events = coalescePhaseEvents(raw, st);
    handle.lastSeq = cursorSeq;
    handle.sentSeq = cursorSeq;
    const live = Boolean(payload.live);
    const owner = payload.owner ?? null;
    const hasMore = Boolean(payload.hasMore) || capped;
    send({
      type: "feed",
      sessionId,
      fromSeq,
      seq: cursorSeq,
      events,
      live,
      phase: payload.phase ?? null,
      owner,
      context: payload.context ?? null,
      subagents: payload.subagents || [],
      // P6 — `summary.sessionKind` already comes back from the projector; the
      // frame just never carried it, so a headless `grok -p` chat looked like
      // any other conversation in the chat pane. One field, no new read.
      sessionKind: payload.summary?.sessionKind ?? null,
      turn: payload.turn ?? null,
      truncated: Boolean(payload.truncated),
      hasMore,
      // `live && owner` — computed once inside the projector so this frame and
      // GET /api/sessions/:id/feed carry the same value, not two copies of the
      // same rule that can drift. (56 of 958 sessions carry a turn_started with
      // no turn_ended from a CLI that died mid-turn; `live` alone over-reports.)
      working: payload.working != null ? Boolean(payload.working) : live && Boolean(owner),
      ...extra,
    });
    if (st.dropped > before) {
      console.log(
        `[feed] ${sessionId.slice(0, 8)} coalesced ${st.dropped - before} phase events (${events.length}/${raw.length} on wire)`,
      );
    }
    // Paged: drain the rest without waiting for another fs event.
    if (hasMore) {
      setTimeout(() => {
        if (ws.readyState !== ws.OPEN) return;
        if (feedSubs.get(sessionId) !== handle) return;
        try {
          feedPoll(sessionId);
        } catch {
          /* */
        }
      }, 10);
    }
  };

  const dropFeedSub = (sessionId) => {
    const handle = feedSubs.get(sessionId);
    if (!handle) return false;
    feedUnsubscribe(handle);
    feedSubs.delete(sessionId);
    feedPhase.delete(sessionId);
    return true;
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
      sessionId: primaryTurnSessionId(),
      resume: true,
      turnEpoch: globalTurnGen,
    });
  }

  // Per-socket agent_exit notify (pool handler also ends busy turns)
  const onExit = (info) =>
    send({ type: "agent_exit", ...info, sessionId: info?.sessionId ?? null });
  pool.on("agent_exit", onExit);

  ws.on("close", () => {
    pool.off("agent_exit", onExit);
    // Tear down every feed subscription this socket owned, then let the watcher
    // pool drop any session nobody is tailing any more.
    for (const sid of [...feedSubs.keys()]) dropFeedSub(sid);
    syncSessionWatchers();
    // Do NOT abandon ACP turn — phone WS flaps constantly.
    console.log("[ws] client disconnected (turn continues if active)", {
      globalBusy,
      parallel: parallelTurns.size,
      queue: queueTotal(),
      activeSessionId: primaryTurnSessionId(),
      watchers: sessionWatchers.stats(),
    });
  });

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      // Nothing was parsed, so there is genuinely no session to name.
      sendError("bad json");
      return;
    }

    if (msg.type === "ping") {
      lastClientPongAt = Date.now(); // client is alive (they ping us; we pong)
      send({ type: "pong", t: Date.now() });
      return;
    }

    /**
     * P2 — tail one session's on-disk truth.
     *   client → daemon: subscribe   {sessionId, fromSeq}
     *   client → daemon: unsubscribe {sessionId}
     *   daemon → client: feed {sessionId, fromSeq, seq, events[], live, phase,
     *                          owner, context, subagents, sessionKind, turn,
     *                          truncated, hasMore, working}
     * fromSeq 0 = tail window (newest events, `truncated` if older exist).
     * fromSeq > 0 = resume: page forward from that cursor, `hasMore` when the
     * batch was capped at FEED_MAX_EVENTS.
     */
    if (msg.type === "subscribe") {
      const sessionId = msg.sessionId ? String(msg.sessionId) : "";
      if (!sessionId) {
        sendError("sessionId required");
        return;
      }
      const rawFrom = Number(msg.fromSeq);
      const fromSeq = Number.isFinite(rawFrom) && rawFrom > 0 ? Math.floor(rawFrom) : 0;
      dropFeedSub(sessionId); // re-subscribe at a new cursor replaces the old one

      // session-feed's subscribe() fires an uncapped catch-up of its own; we
      // swallow that one and send a capped catch-up right after instead.
      let primed = false;
      const handle = feedSubscribe(sessionId, fromSeq, (payload) => {
        if (!primed) {
          primed = true;
          return;
        }
        deliverFeed(sessionId, handle, payload);
      });
      feedSubs.set(sessionId, handle);
      handle.lastSeq = fromSeq;
      // Our own cursor — the projector's `subscribe()` has already slammed
      // `lastSeq` to the file's newest seq, which is not what we have sent.
      handle.sentSeq = fromSeq;
      const stats = syncSessionWatchers();
      console.log(
        `[feed] subscribe ${sessionId.slice(0, 8)} from ${fromSeq} — watching ${stats.sessions} session(s)`,
      );
      deliverFeed(
        sessionId,
        handle,
        readSessionFeed(sessionId, {
          from: fromSeq,
          limit: FEED_MAX_EVENTS,
          cwd: msg.cwd ? String(msg.cwd) : undefined,
        }),
        { catchUp: true },
      );
      return;
    }

    if (msg.type === "unsubscribe") {
      const sessionId = msg.sessionId ? String(msg.sessionId) : "";
      if (!sessionId) {
        sendError("sessionId required");
        return;
      }
      const ok = dropFeedSub(sessionId);
      const stats = syncSessionWatchers();
      console.log(
        `[feed] unsubscribe ${sessionId.slice(0, 8)} — watching ${stats.sessions} session(s)`,
      );
      send({ type: "unsubscribed", sessionId, ok });
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
          sessionId: bridge.sessionId || null,
          agent: bridge.status(),
          ...turnSnapshot(),
        });
      } catch (e) {
        sendError(e, { sessionId: msg.sessionId || bridge.sessionId || null });
      }
      return;
    }

    /**
     * P2 — `stop` stops ONE session. It used to be global: a phone pressing
     * Stop killed the Mac's live turn and cleared every queue.
     */
    if (msg.type === "stop") {
      const sessionId = msg.sessionId ? String(msg.sessionId) : null;
      if (!sessionId) {
        // Legacy client (pre-P3) — keep the old global behaviour, but say so.
        console.warn(
          "[desk] stop without sessionId — legacy GLOBAL stop; client should send {sessionId}",
        );
        abandonTurn({ restart: true, reason: "stop" });
        send({ type: "queue_update", ...queueSnapshot(null), cleared: true, legacy: true });
        return;
      }
      const res = stopSession(sessionId);
      send({ type: "queue_update", ...queueSnapshot(sessionId), cleared: true });
      send({ type: "stopped", ...res });
      return;
    }

    if (msg.type === "queue_clear") {
      const sid = msg.sessionId ? String(msg.sessionId) : null;
      clearQueue(sid);
      send({ type: "queue_update", ...queueSnapshot(sid), cleared: true });
      return;
    }

    if (msg.type === "queue_cancel") {
      const snap = cancelQueueItem(msg.clientMsgId || msg.id);
      send({ type: "queue_update", ...snap });
      return;
    }

    if (msg.type === "queue_list") {
      send({
        type: "queue_update",
        ...queueSnapshot(msg.sessionId ? String(msg.sessionId) : null),
      });
      return;
    }

    if (msg.type === "permission_response") {
      const requestId = msg.requestId ? String(msg.requestId) : "";
      if (!requestId) {
        sendError("requestId required", { sessionId: msg.sessionId || null });
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
      let owner = null;
      // Try every worker (requestId is unique)
      for (const w of pool.workers.values()) {
        if (w.bridge.resolvePermission(requestId, choice)) {
          ok = true;
          owner = w;
          break;
        }
      }
      send({
        type: "permission_resolved",
        sessionId: workerSessionId(owner) || msg.sessionId || null,
        requestId,
        ok,
        ...choice,
      });
      return;
    }

    /** Answer ask_user_question card */
    if (msg.type === "question_response") {
      const requestId = msg.requestId ? String(msg.requestId) : "";
      if (!requestId) {
        sendError("requestId required", { sessionId: msg.sessionId || null });
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
      let owner = null;
      for (const w of pool.workers.values()) {
        if (w.bridge.resolveExtRequest(requestId, result)) {
          ok = true;
          owner = w;
          break;
        }
      }
      send({
        type: "question_resolved",
        sessionId: workerSessionId(owner) || msg.sessionId || null,
        requestId,
        ok,
        result,
      });
      return;
    }

    /** Approve / reject exit_plan_mode card */
    if (msg.type === "plan_approval_response") {
      const requestId = msg.requestId ? String(msg.requestId) : "";
      if (!requestId) {
        sendError("requestId required", { sessionId: msg.sessionId || null });
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
      let owner = null;
      for (const w of pool.workers.values()) {
        if (w.bridge.resolveExtRequest(requestId, result)) {
          ok = true;
          owner = w;
          break;
        }
      }
      send({
        type: "plan_approval_resolved",
        sessionId: workerSessionId(owner) || msg.sessionId || null,
        requestId,
        ok,
        result,
      });
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
            sessionId: msg.sessionId || null,
            mode: "always-approve",
            alwaysApprove: true,
            note: "Phone default: always-approve (settings.phoneAlwaysApprove)",
          });
        } else if (!isMobile && st.permissionMode) {
          pool.setPermissionMode(st.permissionMode);
          send({
            type: "permission_mode",
            sessionId: msg.sessionId || null,
            mode: pool.permissionMode,
            alwaysApprove: pool.alwaysApprove,
          });
        } else {
          // Announcing a client is not about any session — no sessionId to give.
          send({ type: "client_info_ack", isMobile });
        }
      } catch (e) {
        sendError(e, { sessionId: msg.sessionId || null });
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
          sessionId: msg.sessionId || null,
          mode: pool.permissionMode,
          alwaysApprove: pool.alwaysApprove,
          note: globalBusy
            ? "Mode saved; applies fully after restart / next worker"
            : "Mode applied",
        });
        // Permission mode is process-wide, not per chat: sessionId is null on
        // the broadcast because there genuinely is not one.
        broadcastJson({
          type: "permission_mode",
          sessionId: null,
          mode: pool.permissionMode,
          alwaysApprove: pool.alwaysApprove,
        });
      } catch (e) {
        sendError(e, { sessionId: msg.sessionId || null });
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
            send({
              type: "session_status",
              // no session exists yet — null, not a guess
              sessionId: null,
              state: "error",
              error: e.message || String(e),
              code: e.code || "POOL_FULL",
            });
            sendError(e, { sessionId: null, code: e.code || "POOL_FULL" });
            return;
          }
          send({
            type: "session_status",
            sessionId: null,
            state: "creating",
            cwd,
            parallel: true,
            workerId: worker.id,
          });
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
        send({ type: "session_status", sessionId: null, state: "creating", cwd: bridge.cwd });
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
        send({
          type: "session_status",
          sessionId: null,
          state: "error",
          error: e.message || String(e),
        });
        sendError(e, { sessionId: null });
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
        sendError(e, { sessionId: msg.sessionId || null, code: e.code || undefined });
      }
      return;
    }

    if (msg.type === "load_session") {
      const sessionId = msg.sessionId;
      if (!sessionId) {
        sendError("sessionId required");
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

        // P4 — CRITICAL: a live `grok` owns this session. Do NOT attach the ACP
        // worker at all: serve the transcript from disk and mark it read-only.
        // This is the one thing that stops chat_history.jsonl being clobbered.
        const blocked = ownershipBlock(sessionId);
        if (blocked) {
          console.log(
            `[own] refusing session/load ${String(sessionId).slice(0, 8)} — ${blocked.message}`,
          );
          trackDeskSession(sessionId, cwd || blocked.owner.cwd);
          send({
            type: "session_loaded",
            sessionId,
            cwd: cwd || blocked.owner.cwd || null,
            messages: transcript.messages || [],
            summary: transcript.summary || null,
            truncated: transcript.truncated || false,
            agentResumed: false,
            viewOnly: true,
            readOnly: true,
            owner: blocked.owner,
            ownerCoverage: ownerCoverage(),
            activeSessionId: primaryTurnSessionId(),
            liveSessionIds: turnSnapshot().liveSessionIds,
            partialDraft: null,
          });
          send({
            type: "session_status",
            state: "history_only",
            sessionId,
            cwd: cwd || blocked.owner.cwd || null,
            owner: blocked.owner,
            readOnly: true,
          });
          return;
        }

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
            backgroundTurnSessionId: primaryTurnSessionId(),
            activeSessionId: primaryTurnSessionId(),
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
              backgroundTurnSessionId: primaryTurnSessionId(),
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
        const RESUME_MS = 30000;
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
        sendError(e, { sessionId });
      }
      return;
    }

    if (msg.type === "prompt") {
      const text = String(msg.text || "").trim();
      const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
      const sessionId = msg.sessionId ? String(msg.sessionId) : bridge.sessionId || null;
      const clientMsgId = msg.clientMsgId ? String(msg.clientMsgId) : null;
      if (!text && attachments.length === 0) {
        sendError("Empty prompt", { sessionId });
        return;
      }
      // Same guard as load_session: sending would load the session onto an ACP
      // worker, and two processes rewriting chat_history.jsonl lose each other's
      // turns. A stale client that missed the read-only frame is refused here.
      const promptBlocked = ownershipBlock(sessionId);
      if (promptBlocked) {
        sendError(promptBlocked.message, { sessionId, code: "session_owned" });
        send({
          type: "session_status",
          state: "history_only",
          sessionId,
          readOnly: true,
          owner: promptBlocked.owner,
        });
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
          sendError(e, { sessionId });
        }
        return;
      }

      // Idle path — primary worker
      if (globalBusy) {
        enqueuePrompt(job);
        return;
      }

      // Claim slot synchronously so a second prompt on this tick enqueues
      const claimEpoch = claimBusy("prompt", sessionId || bridge.sessionId || null);

      // Idle — load the named session even if the worker has no bound id yet
      if (sessionId && sessionId !== bridge.sessionId) {
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
          sendError(e, { sessionId });
          return;
        }
        // Abandon during load?
        if (claimEpoch !== globalTurnGen) {
          console.log("[desk] prompt aborted after load — epoch mismatch");
          return;
        }
        globalBusy = true; // re-assert after await
        claimSessionId = sessionId ? String(sessionId) : claimSessionId;
      }

      void runPromptJob(text, attachments, {
        sessionId: sessionId || bridge.sessionId,
        clientMsgId,
        claimed: true,
      });
      return;
    }

    sendError(`unknown message type: ${msg.type}`, { sessionId: msg.sessionId || null });
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
    `  Speak      →  ${speakStatusPayload().speakReady ? "subscription TTS ready" : "grok login + grok-speak"}`,
  );
  console.log("  Dictate    →  TUI /voice (Grok STT, subscription login)");
  console.log(`  Prefs      →  ${userDataDir()}`);
  console.log(`  Lock       →  ${authConfigured() ? "on" : "off"}`);
  console.log(`  Source     →  ${getDeskSourceDir()}\n`);
  // Clean subagent ids that polluted desk-index from earlier builds
  try {
    pruneSubagentsFromDeskIndex();
  } catch {
    /* */
  }
  try {
    const w = warmSessionScan();
    console.log(`[scan] warmed ${w.sessions} sessions in ${w.groups} groups (${w.ms}ms)`);
  } catch (e) {
    console.warn("[scan] warm failed:", e.message);
  }
  startSessionWatcher();
  startOwnershipWatcher();
  try {
    ensureVapidKeys();
  } catch (e) {
    console.warn("[push] VAPID init failed:", e.message);
  }
  setAutomationFireHandler(async (job) => {
    const cwd = job.cwd ? path.resolve(String(job.cwd)) : bridge.cwd;
    const text = String(job.prompt || "").trim();
    if (!text) throw new Error("empty automation prompt");
    let worker = pool.acquire({ cwd, preferFree: true });
    if (!worker) {
      const err = new Error("agent pool busy");
      err.code = "BUSY";
      throw err;
    }
    await worker.bridge.ensure();
    worker.bridge.cwd = cwd;
    const session = await worker.bridge.newSession(cwd);
    pool.bindSession(worker, session.sessionId, cwd);
    trackDeskSession(session.sessionId, cwd);
    broadcastProjectsTick("automation");
    broadcastAgents();
    void runParallelPrompt(worker, text, [], {
      sessionId: session.sessionId,
      cwd,
      clientMsgId: `auto_${job.id}_${Date.now().toString(36)}`,
    });
    if (job.notify) {
      void notifyPush({
        title: "Scheduled · Grok Desk",
        body: (job.title || "Automation").slice(0, 140),
        tag: `auto-${job.id}`,
        url: "/",
        status: "info",
      }).catch(() => {});
    }
    return { sessionId: session.sessionId };
  });
  setInterval(() => {
    const busy = pool.anyBusy() && pool.size() >= pool.max;
    void runDueAutomations({ busy }).catch((e) =>
      console.warn("[auto] tick failed:", e.message),
    );
  }, 30_000);
  /*
   * P5 — reap idle ACP workers.
   *
   * `pool.stopWorker` existed but was called from nowhere, so a parallel
   * dispatch's worker (and its `grok agent` child) lived until the daemon was
   * restarted. Three or four survivors after a test run was normal, and each
   * one pinned a session.
   */
  setInterval(() => {
    void pool
      .reapIdle()
      .then((ids) => {
        if (ids.length) broadcastAgents();
      })
      .catch((e) => console.warn("[pool] reap failed:", e.message || e));
  }, POOL_REAP_TICK_MS);
  // Warm the agent process only — no orphan session/new
  bridge.ensure().catch((e) => console.warn("[acp] warm start failed:", e.message));
});

/**
 * P5 — the daemon takes its `grok agent` children with it.
 *
 * `bridge.stop()` only ever touched the DEFAULT worker, so every other pool
 * worker's agent was orphaned on SIGTERM. One of those survivors held a stale
 * `active_sessions.json` entry for 16 hours and made a dead session look owned.
 * `pool.stopAll()` SIGTERMs all of them; anything still alive after the grace
 * window gets SIGKILL before we exit.
 */
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\n[desk] shutting down");
  let pids = [];
  try {
    pids = pool.stopAll();
  } catch (e) {
    console.warn("[desk] pool stopAll failed", e.message || e);
  }
  try {
    server.close();
  } catch {
    /* */
  }
  setTimeout(() => {
    for (const pid of pids) {
      try {
        process.kill(pid, 0);
      } catch {
        continue; // already reaped by SIGTERM
      }
      try {
        console.warn(`[desk] SIGKILL leftover agent pid ${pid}`);
        process.kill(pid, "SIGKILL");
      } catch {
        /* */
      }
    }
    process.exit(0);
  }, SHUTDOWN_GRACE_MS);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
