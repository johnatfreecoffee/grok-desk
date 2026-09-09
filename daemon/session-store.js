/**
 * Read Grok CLI sessions from ~/.grok/sessions/<encoded-cwd>/<session-id>/
 * Same on-disk layout the TUI uses — group by project folder, dip into sessions.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureUserDataMigrated, userDataPath, deskSourceDir } from "./user-data.js";
// Cycle by design: session-feed reads THIS module's paths, and deleteSession
// needs its ownership probe. Both sides only ever call each other lazily (never
// at module-eval time) and both exports are hoisted function declarations, so
// the ESM cycle resolves cleanly whichever module is entered first.
import { sessionOwner } from "./session-feed.js";

const DEFAULT_SETTINGS = {
  maxSessionsPerProject: 40,
  maxProjectsShown: 80,
  showHomeSessions: false,
  /** false = only sessions opened/created in Grok Desk (not entire CLI history) */
  showAllCliSessions: false,
  /**
   * Show subagent worker sessions (`session_kind: subagent*`) as peer chats.
   * P6: this key was read by `listProjects` but never declared here and had no
   * UI, so it was permanently off unless someone hand-edited settings.json.
   */
  showSubagentSessions: false,
  collapsedProjects: {}, // cwd → true
  pinnedCwds: [],
  /** sessionId → true — pinned chats float to top within their folder */
  pinnedSessions: {},
  defaultCwd: os.homedir(),
  /** Phone PWA: allow Web Push sends from this Mac */
  pushEnabled: true,
  /** Notify when a text turn finishes (success or error) */
  pushNotifyOnTurnEnd: true,
  /**
   * Permission mode for new ACP workers:
   * always-approve | ask | auto
   * Desktop default ask; phone can force yolo via phoneAlwaysApprove.
   */
  permissionMode: "ask",
  /** When true (default), mobile clients keep always-approve even if permissionMode is ask */
  phoneAlwaysApprove: true,
  /** Remembered allow substrings (title/detail match) for ask mode */
  allowedToolPatterns: [],
  /** Compact density (message/composer chrome) */
  compactMode: false,
  /** Show timestamps on chat messages */
  showTimestamps: false,
};

function settingsPath() {
  ensureUserDataMigrated();
  return userDataPath("settings.json");
}

function deskIndexPath() {
  ensureUserDataMigrated();
  return userDataPath("desk-index.json");
}

/** In-memory desk-index + serialized writes (avoid lost titles under concurrent RMW). */
let deskIndexCache = null;
let deskIndexWriteChain = Promise.resolve();

/**
 * P7 — sidebar sort-key freeze, in memory only.
 *
 * sessionId → `{ lastInteractionAt, chatHash, chatBytes }`. Written by
 * `resolveInteractionAt` (a READ path — it must never touch disk), cleared by
 * every path that records a real interaction so the persisted record wins.
 */
const interactionFreeze = new Map();

/** Sessions/projects this Desk app has actually used. */
function loadDeskIndex() {
  if (deskIndexCache) return deskIndexCache;
  try {
    const p = deskIndexPath();
    if (fs.existsSync(p)) {
      deskIndexCache = JSON.parse(fs.readFileSync(p, "utf8"));
      return deskIndexCache;
    }
  } catch {
    /* */
  }
  deskIndexCache = { sessionIds: {}, projectCwds: {} };
  return deskIndexCache;
}

function saveDeskIndex(idx) {
  deskIndexCache = idx;
  const snapshot = JSON.stringify(idx, null, 2);
  deskIndexWriteChain = deskIndexWriteChain
    .then(() => {
      const p = deskIndexPath();
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const tmp = `${p}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, snapshot);
      fs.renameSync(tmp, p);
    })
    .catch((e) => {
      console.warn("[desk-index] write failed", e.message || e);
    });
}

/** Await the serialized desk-index write chain (tests / delete verification). */
export function flushDeskIndex() {
  return deskIndexWriteChain;
}

/** True when a summary.json describes a subagent session (not a user chat). */
export function isSubagentKind(s) {
  if (!s || typeof s !== "object") return false;
  if (s.is_subagent === true) return true;
  const k = String(s.session_kind || s.kind || "").toLowerCase();
  return k === "subagent" || k === "subagent_resume" || k.startsWith("subagent");
}

/* ------------------------------------------------ P7 — one shared dir scan */

/**
 * P7. `~/.grok/sessions` was walked from scratch by three different hot paths,
 * per session id, on a 2.5 s poll:
 *
 *   - `isSubagentSession()` did a full nested `readdirSync` of EVERY session dir
 *     to look for a `subagents/<id>` link — O(indexed x on-disk). With 664
 *     indexed ids and 1025 dirs on disk that is ~390 000 `existsSync` calls per
 *     `GET /api/projects`, and `pruneSubagentsFromDeskIndex()` ran it for every
 *     id on every call.
 *   - `findSessionDir()` / `findSessionCwd()` fell back to a readdir of all 89
 *     project groups on every prompt, queue drain and load.
 *
 * All three now share ONE snapshot: id -> group key, plus the set of ids linked
 * under some parent's `subagents/`. Building it costs one readdir per group and
 * one probe per session dir — the same walk `listProjects` already performs.
 *
 * Invalidation is generation-based, never a rescan-per-lookup:
 *   - `bumpSessionScan()` — the root watcher's group-level tick, and every
 *     Desk-initiated write (session created, session deleted).
 *   - `SCAN_TTL_MS` — a session dir appearing inside an existing group does not
 *     move the group set, so the snapshot also ages out on its own.
 *   - a lookup that misses forces exactly one rebuild, then gives up.
 */
const SCAN_TTL_MS = Number(process.env.DESK_SCAN_TTL_MS || 4000);
/** How stale a snapshot must be before a lookup miss is allowed to force a rebuild. */
const SCAN_MISS_REFRESH_MS = Number(process.env.DESK_SCAN_MISS_MS || 250);

/** @type {{ root: string, gen: number, at: number, ids: Map<string,string>, subagentIds: Set<string>, groups: string[] } | null} */
let scanCache = null;
let scanGen = 1;

/**
 * Drop the session-directory snapshot. Called by the daemon's root watcher when
 * project groups appear or disappear, and by this module's own writes.
 */
export function bumpSessionScan() {
  scanGen += 1;
  return scanGen;
}

function buildSessionScan(root) {
  const ids = new Map();
  const subagentIds = new Set();
  const groups = [];
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const ent of entries) {
    if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
    groups.push(ent.name);
    const groupDir = path.join(root, ent.name);
    let sEntries = [];
    try {
      sEntries = fs.readdirSync(groupDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sEnt of sEntries) {
      if (!sEnt.isDirectory()) continue;
      if (!ids.has(sEnt.name)) ids.set(sEnt.name, ent.name);
      // One readdir attempt instead of existsSync + readdir; ENOENT is the
      // common case (most sessions spawn no subagents) and costs one syscall.
      let kids = null;
      try {
        kids = fs.readdirSync(path.join(groupDir, sEnt.name, "subagents"), {
          withFileTypes: true,
        });
      } catch {
        continue;
      }
      for (const kid of kids) {
        if (kid.name && kid.name[0] !== ".") subagentIds.add(kid.name);
      }
    }
  }
  return { root, gen: scanGen, at: Date.now(), ids, subagentIds, groups };
}

/** Current snapshot, rebuilt only when the generation moved or the TTL expired. */
/**
 * Build the scan up front so the first sidebar load does not pay for it.
 * Called once at boot; everything after rides the cache or a watcher bump.
 */
export function warmSessionScan() {
  const t = Date.now();
  const scan = sessionScan({ force: true });
  return { sessions: scan.ids.size, groups: scan.groups.length, ms: Date.now() - t };
}

function sessionScan({ force = false } = {}) {
  const root = sessionsRoot();
  if (
    !force &&
    scanCache &&
    scanCache.root === root &&
    scanCache.gen === scanGen &&
    Date.now() - scanCache.at < SCAN_TTL_MS
  ) {
    return scanCache;
  }
  scanCache = buildSessionScan(root);
  return scanCache;
}

/**
 * Project-group directory name that holds `sessionId`, or null.
 * A miss on a stale snapshot buys exactly one rebuild.
 */
function scanGroupFor(sessionId) {
  const id = String(sessionId);
  const scan = sessionScan();
  const group = scan.ids.get(id);
  if (group) return group;
  // Miss — the dir may have been created since the snapshot (a brand-new chat,
  // a group the CLI just made). Fall back to the exact probe this replaced:
  // one readdir of the root plus one existsSync per group. That is ~90 syscalls
  // for ONE lookup, where the old code paid it for every id on every poll.
  const root = scan.root;
  let groups = scan.groups;
  try {
    groups = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name);
  } catch {
    /* root gone — the snapshot's list is as good as it gets */
  }
  for (const g of groups) {
    if (fs.existsSync(path.join(root, g, id))) return g;
  }
  return null;
}

/**
 * Subagent-ness is sticky: a session that is a subagent never becomes a user
 * chat. `true` is therefore memoized for the life of the process; `false` is
 * only memoized against the current snapshot, because a link can still appear.
 */
const subagentMemo = new Map(); // sessionId -> true
const notSubagentMemo = new Map(); // sessionId -> scan generation the answer came from

/** True when this on-disk session is a Grok Build subagent (not a user chat). */
export function isSubagentSession(sessionId, cwd) {
  if (!sessionId || String(sessionId).startsWith("mail:")) return false;
  const id = String(sessionId);
  if (subagentMemo.has(id)) return true;
  let scan = sessionScan();
  if (scan.subagentIds.has(id)) {
    subagentMemo.set(id, true);
    return true;
  }
  if (!scan.ids.has(id) && Date.now() - scan.at > SCAN_MISS_REFRESH_MS) {
    // The id is newer than the snapshot (brand-new session, or a link the CLI
    // wrote since the last tick). Pay for at most one rebuild — the freshness
    // guard keeps a loop over many unknown ids (boot-time prune of an index
    // full of deleted sessions) from rebuilding once per id.
    scan = sessionScan({ force: true });
    if (scan.subagentIds.has(id)) {
      subagentMemo.set(id, true);
      return true;
    }
  }
  if (notSubagentMemo.get(id) === scan.gen) return false;
  const dir = findSessionDir(id, cwd);
  if (!dir) return false;
  if (isSubagentKind(readSummary(dir))) {
    subagentMemo.set(id, true);
    return true;
  }
  notSubagentMemo.set(id, scan.gen);
  return false;
}

/** Drop subagent ids that accidentally landed in desk-index. */
export function pruneSubagentsFromDeskIndex() {
  const idx = loadDeskIndex();
  let changed = false;
  for (const id of Object.keys(idx.sessionIds || {})) {
    const cwd = idx.sessionIds[id]?.cwd || null;
    if (isSubagentSession(id, cwd)) {
      delete idx.sessionIds[id];
      changed = true;
    }
  }
  if (changed) saveDeskIndex(idx);
  return changed;
}

/**
 * Remember a session so it appears in the sidebar without dumping all CLI history.
 * Open/select only — does NOT bump lastInteractionAt (sort key).
 */
export function trackDeskSession(sessionId, cwd, title) {
  if (!sessionId) return;
  // Never promote subagent workers into the main chat list
  if (isSubagentSession(sessionId, cwd)) return;
  const idx = loadDeskIndex();
  const prev = idx.sessionIds[sessionId] || {};
  idx.sessionIds[sessionId] = {
    ...prev,
    cwd: cwd || prev.cwd || null,
    // `at` = last opened (bookkeeping only — never used for sidebar sort)
    at: new Date().toISOString(),
    title: title || prev.title || undefined,
  };
  if (cwd) {
    idx.projectCwds[cwd] = new Date().toISOString();
  }
  saveDeskIndex(idx);
}

/**
 * Real chat activity (user send / assistant reply) — bumps sidebar sort key.
 * Call from appendDeskMessage / prompt paths only — never from load_session.
 */
export function touchSessionInteraction(sessionId, cwd, extra = {}) {
  if (!sessionId) return;
  interactionFreeze.delete(sessionId); // a real turn beats the read-path memo
  const idx = loadDeskIndex();
  const prev = idx.sessionIds[sessionId] || {};
  const now = new Date().toISOString();
  idx.sessionIds[sessionId] = {
    ...prev,
    cwd: cwd || prev.cwd || null,
    at: now,
    lastInteractionAt: now,
    title: extra.title || prev.title || undefined,
    chatHash: extra.chatHash !== undefined ? extra.chatHash : prev.chatHash,
    chatBytes: extra.chatBytes !== undefined ? extra.chatBytes : prev.chatBytes,
  };
  if (cwd) idx.projectCwds[cwd] = now;
  saveDeskIndex(idx);
}

/** Instant sidebar rename from first user prompt (before CLI summary exists). */
export function setDeskTitle(sessionId, title, { force = false } = {}) {
  if (!sessionId || !title) return null;
  const clean = String(title).trim().replace(/\s+/g, " ").slice(0, 80);
  if (!clean) return null;
  const idx = loadDeskIndex();
  const prev = idx.sessionIds[sessionId] || {};
  // Don't clobber a real title with later prompts unless forced
  if (
    !force &&
    prev.title &&
    prev.title !== "New chat" &&
    !/^[0-9a-f]{8}$/i.test(prev.title)
  ) {
    return null; // unchanged
  }
  const now = new Date().toISOString();
  idx.sessionIds[sessionId] = {
    ...prev,
    title: clean,
    // First real prompt renames AND counts as interaction.
    // P7: the sidebar's freeze is no longer persisted by the read path, so fall
    // back to it here — a rename must not float an old chat to the top.
    lastInteractionAt:
      prev.lastInteractionAt || interactionFreeze.get(sessionId)?.lastInteractionAt || now,
    at: now,
  };
  saveDeskIndex(idx);
  return clean;
}

export function getDeskTitle(sessionId) {
  if (!sessionId) return null;
  const idx = loadDeskIndex();
  return idx.sessionIds?.[sessionId]?.title || null;
}

export function sessionsRoot() {
  const home = process.env.GROK_HOME || path.join(os.homedir(), ".grok");
  return path.join(home, "sessions");
}

export function loadSettings() {
  try {
    const p = settingsPath();
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, "utf8"));
      // User file wins for every key present — never force-reset booleans on load
      return { ...DEFAULT_SETTINGS, ...raw };
    }
  } catch {
    /* */
  }
  return { ...DEFAULT_SETTINGS };
}

/**
 * Merge patch into settings and persist.
 * Only defined keys in `patch` are applied (undefined is ignored — avoids wipe).
 * NEVER rewrite prefs during app rebuilds — only this path writes settings.
 */
export function saveSettings(patch = {}) {
  const current = loadSettings();
  const next = { ...current };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === undefined) continue;
    next[k] = v;
  }
  // Always keep desk source pinned so it's easy to open for improvements
  const desk = deskSourceDir();
  if (!Array.isArray(next.pinnedCwds)) next.pinnedCwds = [];
  if (desk && !next.pinnedCwds.includes(desk)) {
    next.pinnedCwds = [desk, ...next.pinnedCwds];
  }
  const p = settingsPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // P5 — atomic, like `saveDeskIndex`. A bare writeFileSync truncates first, so
  // a crash (or two writers) between truncate and write leaves invalid JSON and
  // `loadSettings` silently falls back to DEFAULT_SETTINGS — every preference
  // gone, including the permission mode.
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, p);
  return next;
}

export function getDeskSourceDir() {
  return deskSourceDir();
}

function decodeCwdKey(key) {
  try {
    return decodeURIComponent(key);
  } catch {
    return key;
  }
}

function projectName(cwd) {
  if (!cwd || cwd === "/") return cwd || "unknown";
  const parts = cwd.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || cwd;
}

/** Parse `<sessionDir>/summary.json`, or null. */
export function readSummary(sessionDir) {
  const p = path.join(sessionDir, "summary.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Where the session came from — Desk UI vs CLI/TUI vs Agent Mail vs a machine run.
 *
 * P6 honesty fix: `session_kind` was never surfaced, so the 80 headless
 * `grok -p` runs on this machine listed as ordinary "CLI" chats and the
 * subagent workers (visible only with `showSubagentSessions`) were
 * indistinguishable from real conversations. Both now say what they are.
 *
 * @returns {{ source: 'desk'|'cli'|'mail'|'headless'|'subagent', label: string, projectLabel: string }}
 */
function classifyOrigin(id, cwd, _agentName, deskSessionIds, sessionKind) {
  const projectLabel = projectName(cwd);
  if (String(id).startsWith("mail:")) {
    return { source: "mail", label: "Mail", projectLabel };
  }
  const kind = String(sessionKind || "").toLowerCase();
  if (kind.startsWith("subagent")) {
    return { source: "subagent", label: "Subagent", projectLabel };
  }
  if (kind === "headless") {
    return { source: "headless", label: "Headless", projectLabel };
  }
  if (deskSessionIds?.has(id)) {
    return { source: "desk", label: "Desk", projectLabel };
  }
  return { source: "cli", label: "CLI", projectLabel };
}

/** Agent Mail worker sessions (email → a.*@freecoffee.dev → grok). */
export function agentMailRoot() {
  return path.join(os.homedir(), "Library", "AgentMail");
}

export function loadAgentMailSessions() {
  const sessionsPath = path.join(agentMailRoot(), "state", "sessions.json");
  if (!fs.existsSync(sessionsPath)) return [];
  let data;
  try {
    data = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));
  } catch {
    return [];
  }
  const byId = data.by_id || {};
  const out = [];
  for (const [sid, rec] of Object.entries(byId)) {
    if (!rec || !rec.workspace) continue;
    const cwd = rec.workspace;
    const title =
      rec.base_subject ||
      rec.display_name ||
      `Mail session ${sid}`;
    // History length ≈ turns
    let numMessages = 0;
    const hist = path.join(agentMailRoot(), "state", "session_history", `${sid}.jsonl`);
    if (fs.existsSync(hist)) {
      try {
        numMessages = fs.readFileSync(hist, "utf8").split("\n").filter(Boolean).length;
      } catch {
        /* */
      }
    }
    out.push({
      id: `mail:${sid}`,
      cwd,
      title: String(title).slice(0, 120),
      updatedAt: rec.updated_at || rec.created_at || null,
      createdAt: rec.created_at || null,
      numMessages,
      model: null,
      agentName: rec.display_name || rec.agent_local || null,
      branch: null,
      source: "mail",
      sourceLabel: "Mail",
      projectLabel: projectName(cwd),
      mailSessionId: Number(sid),
      mailAgent: rec.agent_local || null,
      mailStatus: rec.status || "open",
      usedK: rec.used_k || null,
    });
  }
  return out;
}

export function loadAgentMailTranscript(mailId) {
  const sid = String(mailId).replace(/^mail:/, "");
  const hist = path.join(agentMailRoot(), "state", "session_history", `${sid}.jsonl`);
  const sessionsPath = path.join(agentMailRoot(), "state", "sessions.json");
  let rec = null;
  try {
    const data = JSON.parse(fs.readFileSync(sessionsPath, "utf8"));
    rec = data.by_id?.[sid] || null;
  } catch {
    /* */
  }
  if (!fs.existsSync(hist)) {
    return {
      ok: Boolean(rec),
      messages: [],
      summary: rec
        ? {
            id: `mail:${sid}`,
            cwd: rec.workspace,
            title: rec.base_subject || "Mail session",
          }
        : null,
      error: rec ? undefined : "mail session not found",
    };
  }
  const messages = [];
  let n = 0;
  for (const line of fs.readFileSync(hist, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const role = row.role === "assistant" || row.role === "agent" ? "assistant" : "user";
    const content = String(row.text || row.content || "").trim();
    if (!content) continue;
    messages.push({ id: `mail_${sid}_${n++}`, role, content });
  }
  return {
    ok: true,
    messages,
    summary: {
      id: `mail:${sid}`,
      cwd: rec?.workspace || null,
      title: rec?.base_subject || `Mail session ${sid}`,
      agentName: rec?.display_name || null,
    },
    truncated: false,
    mailOnly: true,
  };
}

function firstDeskUserTitle(sessionId) {
  const named = getDeskTitle(sessionId);
  if (named) return named;
  const msgs = loadDeskMessages(sessionId);
  const u = msgs.find((m) => m.role === "user" && m.content?.trim());
  if (!u) return null;
  const t = u.content.trim().replace(/\s+/g, " ");
  return t.length > 72 ? `${t.slice(0, 72)}…` : t;
}

function looksLikeIdTitle(title, id) {
  if (!title) return true;
  const t = String(title).trim();
  if (t === "New chat") return true;
  if (t === id.slice(0, 8)) return true;
  if (/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(t)) return true;
  return false;
}

/** ISO mtime of a file, or null. */
function fileMtimeIso(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return new Date(fs.statSync(filePath).mtimeMs).toISOString();
  } catch {
    return null;
  }
}

/**
 * Content fingerprint of chat_history.jsonl.
 * ACP session/load rewrites the file (mtime → now) with the same bytes —
 * hash stays stable so open/select does not reorder the sidebar.
 */
function chatHistoryFingerprint(sessionDir) {
  const p = path.join(sessionDir, "chat_history.jsonl");
  try {
    if (!fs.existsSync(p)) return { bytes: 0, hash: "", mtimeIso: null };
    const st = fs.statSync(p);
    const size = st.size;
    // Hash whole file if small; else head+tail (open rewrite keeps both)
    let buf;
    if (size <= 65536) {
      buf = fs.readFileSync(p);
    } else {
      const fd = fs.openSync(p, "r");
      try {
        const head = Buffer.alloc(4096);
        const tail = Buffer.alloc(4096);
        fs.readSync(fd, head, 0, 4096, 0);
        fs.readSync(fd, tail, 0, 4096, Math.max(0, size - 4096));
        buf = Buffer.concat([head, Buffer.from(String(size)), tail]);
      } finally {
        fs.closeSync(fd);
      }
    }
    const hash = crypto.createHash("sha1").update(buf).digest("hex").slice(0, 20);
    return {
      bytes: size,
      hash,
      mtimeIso: new Date(st.mtimeMs).toISOString(),
    };
  } catch {
    return { bytes: 0, hash: "", mtimeIso: null };
  }
}

/** Last ACP updates.jsonl timestamp — real chat, not session/load mtime. */
function lastUpdatesTimestampIso(sessionDir) {
  const p = path.join(sessionDir, "updates.jsonl");
  try {
    if (!fs.existsSync(p)) return null;
    const st = fs.statSync(p);
    if (!st.size) return null;
    const fd = fs.openSync(p, "r");
    try {
      const n = Math.min(st.size, 32768);
      const buf = Buffer.alloc(n);
      fs.readSync(fd, buf, 0, n, st.size - n);
      const text = buf.toString("utf8");
      let last = null;
      const re = /"timestamp"\s*:\s*(\d+(?:\.\d+)?)/g;
      let m;
      while ((m = re.exec(text))) {
        last = Number(m[1]);
      }
      if (!Number.isFinite(last) || last <= 0) return null;
      const ms = last < 1e12 ? last * 1000 : last;
      return new Date(ms).toISOString();
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function lastActivityIso(sessionDir, fp) {
  return lastUpdatesTimestampIso(sessionDir) || fp?.mtimeIso || null;
}

/** sessionId → last desk message `at` (one JSON read for whole list). */
function deskLastMessageAtMap() {
  const store = loadDeskMessagesStore();
  const map = Object.create(null);
  for (const [sid, list] of Object.entries(store || {})) {
    if (!Array.isArray(list) || !list.length) continue;
    const at = list[list.length - 1]?.at;
    if (at) map[sid] = at;
  }
  return map;
}

/**
 * Last real chat interaction — never mere open/select.
 * Sources (max):
 *  1. desk-messages last `at`
 *  2. desk-index lastInteractionAt (frozen; only bumps on real chat / hash change)
 *  3. bootstrap freeze from chat_history when content first seen
 *
 * Hash guard: if chat_history content unchanged since last list, keep frozen time
 * even when mtime jumped (session/load rewrite).
 */
function resolveInteractionAt(sessionDir, sessionId, deskLastAt, deskRec, createdAtFallback) {
  const candidates = [];
  if (deskLastAt) candidates.push(String(deskLastAt));

  const fp = chatHistoryFingerprint(sessionDir);
  const prevHash = deskRec?.chatHash || "";
  const prevIx = deskRec?.lastInteractionAt || null;
  let freeze = null; // { lastInteractionAt, chatHash, chatBytes }

  if (fp.hash) {
    const created = createdAtFallback ? String(createdAtFallback) : "";
    const frozenAtCreated =
      Boolean(prevIx && created) &&
      (prevIx === created ||
        (Number.isFinite(Date.parse(prevIx)) &&
          Number.isFinite(Date.parse(created)) &&
          Math.abs(Date.parse(prevIx) - Date.parse(created)) < 2000));
    const activity = lastActivityIso(sessionDir, fp);

    if (prevHash && prevHash === fp.hash && prevIx && !frozenAtCreated) {
      // Content unchanged (open rewrite) — keep frozen interaction time
      candidates.push(String(prevIx));
    } else if (prevHash && prevHash !== fp.hash) {
      // Real new messages — content changed
      const t = activity || fp.mtimeIso || new Date().toISOString();
      candidates.push(t);
      freeze = { lastInteractionAt: t, chatHash: fp.hash, chatBytes: fp.bytes };
    } else {
      // First observation, or poisoned freeze-at-created_at (CLI chat then stuck at 1d).
      // Use last updates.jsonl time — not created_at, not a fresh open mtime.
      const t =
        activity || prevIx || fp.mtimeIso || created || new Date().toISOString();
      candidates.push(String(t));
      freeze = {
        lastInteractionAt: String(t),
        chatHash: fp.hash,
        chatBytes: fp.bytes,
      };
    }
  } else if (prevIx) {
    candidates.push(String(prevIx));
  } else if (createdAtFallback) {
    candidates.push(String(createdAtFallback));
  } else {
    const dirT = fileMtimeIso(sessionDir);
    if (dirT) candidates.push(dirT);
  }

  if (freeze && sessionId) {
    // P7 — remember the freeze IN MEMORY, never on disk.
    //
    // This used to `saveDeskIndex()` from inside a read. On this machine that
    // was ~187 rewrites of a 148 KB file per `GET /api/projects`, on a 2.5 s
    // poll, forever: sessions listed with `showAllCliSessions` are not in
    // desk-index, so `prev` was always `{}` and the "only write if changed"
    // guard never held. It also silently grew desk-index by 187 ids per poll.
    //
    // Nothing is lost. Every input the freeze is derived from is on disk
    // (`updates.jsonl` timestamps, the chat_history fingerprint), so a restart
    // recomputes exactly the same value; the freeze only has to survive
    // *between polls*, which is what this map does.
    interactionFreeze.set(sessionId, freeze);
  }

  if (!candidates.length) return null;
  candidates.sort();
  return candidates[candidates.length - 1];
}

function sessionMeta(sessionDir, fallbackCwd, deskSessionIds, deskLastAtMap, deskIdx, pinnedSessions) {
  const id = path.basename(sessionDir);
  const s = readSummary(sessionDir);
  const deskTitle = firstDeskUserTitle(id);
  const deskLastAt = deskLastAtMap?.[id] || null;
  // P7: desk-index record, overlaid with this process's in-memory freeze (see
  // `resolveInteractionAt`). A real interaction drops the freeze, so a
  // `touchSessionInteraction` write always wins over a stale memo.
  const persisted = deskIdx?.sessionIds?.[id] || null;
  const frozen = interactionFreeze.get(id) || null;
  const deskRec = frozen ? { ...persisted, ...frozen } : persisted;
  const pinned = Boolean(pinnedSessions?.[id]);
  const isSub = isSubagentKind(s);
  const sessionKind = s?.session_kind ? String(s.session_kind) : null;
  if (!s) {
    const origin = classifyOrigin(id, fallbackCwd, null, deskSessionIds, null);
    return {
      id,
      cwd: fallbackCwd,
      title: deskTitle || "New chat",
      updatedAt: resolveInteractionAt(sessionDir, id, deskLastAt, deskRec, null),
      createdAt: null,
      numMessages: 0,
      model: null,
      agentName: null,
      source: origin.source,
      sourceLabel: origin.label,
      projectLabel: origin.projectLabel,
      isSubagent: false,
      sessionKind: null,
      pinned,
    };
  }
  const cwd = s.info?.cwd || s.cwd || fallbackCwd;
  // Prefer desk first-prompt title when CLI left a generic greeting title
  const rawTitle =
    s.generated_title ||
    s.session_summary ||
    s.title ||
    s.info?.title ||
    null;
  let title;
  if (deskTitle && !looksLikeIdTitle(deskTitle, id)) {
    // Desk title wins when CLI title is a stale first-message summary
    const cliGeneric =
      !rawTitle ||
      looksLikeIdTitle(rawTitle, id) ||
      /^(user greeting|new chat|session start)/i.test(String(rawTitle));
    title = cliGeneric ? deskTitle : rawTitle;
  } else if (!looksLikeIdTitle(rawTitle, id)) {
    title = rawTitle;
  } else {
    title = deskTitle || rawTitle || "New chat";
  }
  const agentName = s.agent_name || null;
  const origin = classifyOrigin(id, cwd, agentName, deskSessionIds, sessionKind);
  return {
    id,
    cwd,
    title: String(title).slice(0, 120),
    // Never use s.last_active_at / s.updated_at (open/resume bumps those)
    updatedAt: resolveInteractionAt(
      sessionDir,
      id,
      deskLastAt,
      deskRec,
      s.created_at || null,
    ),
    createdAt: s.created_at || null,
    numMessages: s.num_messages || s.num_chat_messages || 0,
    model: s.current_model_id || null,
    agentName,
    branch: s.head_branch || null,
    source: origin.source,
    sourceLabel: origin.label,
    projectLabel: origin.projectLabel,
    isSubagent: isSub,
    /** Raw `session_kind` from summary.json — "headless" / "subagent" / null. */
    sessionKind,
    pinned,
  };
}

/**
 * List projects (cwd groups) with nested sessions, newest first.
 */
export function listProjects(opts = {}) {
  const settings = loadSettings();
  const root = sessionsRoot();
  if (!fs.existsSync(root)) {
    return { projects: [], settings, sessionsRoot: root };
  }

  // P7 — the "one-shot cleanup" that ran here is gone.
  //
  // `pruneSubagentsFromDeskIndex()` is O(indexed x on-disk) and it ran on every
  // 2.5 s sidebar poll, which is most of the 2.9-4.5 s this endpoint took. It
  // was also redundant: nothing below reads desk-index to decide whether a
  // subagent is shown — the `scan.subagentIds` / `meta.isSubagent` filters do
  // that, and they see the same links prune did. It still runs once at daemon
  // boot (daemon/index.js), which is where a "one-shot cleanup" belongs.
  const scan = sessionScan();

  const maxPer = Number(opts.maxSessionsPerProject ?? settings.maxSessionsPerProject) || 40;
  const maxProjects = Number(opts.maxProjectsShown ?? settings.maxProjectsShown) || 80;
  const showHome = settings.showHomeSessions === true;
  // Strict: only true when explicitly enabled (never dump CLI history by default)
  const showAll = settings.showAllCliSessions === true;
  const showSubagents = settings.showSubagentSessions === true;
  const deskIdx = loadDeskIndex();
  const deskSessionIds = new Set(Object.keys(deskIdx.sessionIds || {}));
  const deskProjects = new Set(Object.keys(deskIdx.projectCwds || {}));
  // One load for last-interaction times (Desk shadow log)
  const deskLastAtMap = deskLastMessageAtMap();
  const pinnedSessions = settings.pinnedSessions || {};

  // Fast path: desk-only with empty index → empty sidebar
  if (!showAll && deskSessionIds.size === 0 && deskProjects.size === 0 && !(settings.pinnedCwds || []).length) {
    return {
      projects: [],
      settings,
      sessionsRoot: root,
      totalProjects: 0,
      mode: "desk-only-empty",
    };
  }

  const projects = [];
  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    if (ent.name.startsWith(".")) continue;
    const key = ent.name;
    const groupDir = path.join(root, key);
    let cwd = decodeCwdKey(key);
    const cwdFile = path.join(groupDir, ".cwd");
    if (fs.existsSync(cwdFile)) {
      try {
        cwd = fs.readFileSync(cwdFile, "utf8").trim() || cwd;
      } catch {
        /* */
      }
    }

    const isHome = cwd === os.homedir() || cwd === path.join("/Users", os.userInfo().username);
    if (!showHome && isHome && !showAll && !deskProjects.has(cwd) && !settings.pinnedCwds?.includes(cwd)) {
      continue;
    }

    // Collect sessions for this project. P7: the subagent links come from the
    // shared snapshot (built once per tick for the whole tree) instead of a
    // per-group nested readdir on every poll. It is a superset of the old
    // per-group set — the same links `pruneSubagentsFromDeskIndex` used.
    let diskCount = 0;
    const childIds = scan.subagentIds;
    const sessions = [];
    for (const sEnt of fs.readdirSync(groupDir, { withFileTypes: true })) {
      if (!sEnt.isDirectory()) continue;
      diskCount += 1;
      if (!showAll && !deskSessionIds.has(sEnt.name)) continue;
      if (!showSubagents && childIds.has(sEnt.name)) continue;
      const meta = sessionMeta(
        path.join(groupDir, sEnt.name),
        cwd,
        deskSessionIds,
        deskLastAtMap,
        deskIdx,
        pinnedSessions,
      );
      if (!meta) continue;
      // Hide subagent worker sessions (explore/plan/general-purpose children)
      if (meta.isSubagent && !showSubagents) continue;
      sessions.push(meta);
    }

    // Desk-only: skip projects with nothing tracked here
    if (!showAll && sessions.length === 0) continue;

    // Pinned first, then last real interaction (desc)
    sessions.sort((a, b) => {
      const ap = a.pinned ? 1 : 0;
      const bp = b.pinned ? 1 : 0;
      if (bp !== ap) return bp - ap;
      return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
    });
    const trimmed = sessions.slice(0, maxPer);
    if (!trimmed.length) continue;

    const latest = trimmed[0]?.updatedAt || null;
    projects.push({
      cwd,
      name: projectName(cwd),
      key,
      sessionCount: trimmed.length,
      diskCount,
      shownCount: trimmed.length,
      truncated: sessions.length > trimmed.length || (!showAll && diskCount > sessions.length),
      latestAt: latest,
      sessions: trimmed,
      collapsed: Boolean(settings.collapsedProjects?.[cwd]),
      pinned: Boolean(settings.pinnedCwds?.includes(cwd)),
    });
  }

  // Inject Agent Mail email-agent sessions into matching project folders
  const mailSessions = loadAgentMailSessions();
  for (const ms of mailSessions) {
    let proj = projects.find((p) => p.cwd === ms.cwd);
    if (!proj) {
      proj = {
        cwd: ms.cwd,
        name: projectName(ms.cwd),
        key: encodeURIComponent(ms.cwd),
        sessionCount: 0,
        diskCount: 0,
        shownCount: 0,
        truncated: false,
        latestAt: ms.updatedAt,
        sessions: [],
        collapsed: Boolean(settings.collapsedProjects?.[ms.cwd]),
        pinned: Boolean(settings.pinnedCwds?.includes(ms.cwd)),
      };
      projects.push(proj);
    }
    if (!proj.sessions.some((s) => s.id === ms.id)) {
      proj.sessions.push(ms);
    }
  }

  // Re-sort / trim each project after mail inject
  const maxPerFinal = Number(opts.maxSessionsPerProject ?? settings.maxSessionsPerProject) || 40;
  for (const p of projects) {
    // Tag mail sessions with pin flag if needed
    for (const s of p.sessions) {
      if (s.pinned === undefined) s.pinned = Boolean(pinnedSessions[s.id]);
    }
    p.sessions.sort((a, b) => {
      const ap = a.pinned ? 1 : 0;
      const bp = b.pinned ? 1 : 0;
      if (bp !== ap) return bp - ap;
      return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
    });
    if (p.sessions.length > maxPerFinal) {
      p.truncated = true;
      p.sessions = p.sessions.slice(0, maxPerFinal);
    }
    p.sessionCount = p.sessions.length;
    p.shownCount = p.sessions.length;
    p.latestAt = p.sessions[0]?.updatedAt || p.latestAt || null;
  }

  // Ensure desk source project appears even with zero sessions yet
  const deskDir = deskSourceDir();
  if (deskDir && fs.existsSync(deskDir) && !projects.some((p) => p.cwd === deskDir)) {
    const showDesk =
      showAll ||
      deskProjects.has(deskDir) ||
      settings.pinnedCwds?.includes(deskDir) ||
      true; // always list desk source for improvements
    if (showDesk) {
      projects.unshift({
        cwd: deskDir,
        name: projectName(deskDir) || "grok-desk",
        key: encodeURIComponent(deskDir),
        sessionCount: 0,
        diskCount: 0,
        shownCount: 0,
        truncated: false,
        latestAt: null,
        sessions: [],
        collapsed: Boolean(settings.collapsedProjects?.[deskDir]),
        pinned: true,
        isDeskSource: true,
      });
    }
  } else {
    for (const p of projects) {
      if (p.cwd === deskDir) {
        p.pinned = true;
        p.isDeskSource = true;
      }
    }
  }

  // pinned first, then by latest activity
  projects.sort((a, b) => {
    if (a.isDeskSource !== b.isDeskSource) return a.isDeskSource ? -1 : 1;
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return String(b.latestAt || "").localeCompare(String(a.latestAt || ""));
  });

  return {
    projects: projects.slice(0, maxProjects),
    settings,
    sessionsRoot: root,
    totalProjects: projects.length,
    deskSourceDir: deskDir,
  };
}

/**
 * Every spelling of `cwd` that could have produced this session's directory key.
 *
 * P4. The directory key is `encodeURIComponent(cwd)` and the two sides do not
 * always agree on which cwd that was: ~/.grok/active_sessions.json has been seen
 * recording `/private/tmp/...` for a process whose argv said `/tmp/...`. On
 * macOS `/tmp`, `/var` and `/etc` are symlinks into `/private`, so the exact
 * string decides whether the lookup hits or misses — hence realpath, plus the
 * `/private` prefix in both directions.
 */
export function cwdKeyCandidates(cwd) {
  if (!cwd) return [];
  const raw = String(cwd);
  const out = [raw];
  try {
    out.push(fs.realpathSync(raw));
  } catch {
    /* path may be gone — the literal spelling is still worth trying */
  }
  if (raw.startsWith("/private/")) out.push(raw.slice("/private".length));
  else if (raw.startsWith("/")) out.push(path.join("/private", raw));
  return [...new Set(out.filter(Boolean))];
}

export function findSessionDir(sessionId, cwd) {
  const root = sessionsRoot();
  if (!sessionId) return null;
  for (const key of cwdKeyCandidates(cwd)) {
    const candidate = path.join(root, encodeURIComponent(key), sessionId);
    if (fs.existsSync(candidate)) return candidate;
  }
  // P7: the group key is unknown, so ask the shared snapshot instead of
  // re-listing all 89 project groups. `findSessionCwd` and the ACP prompt /
  // queue-drain paths call this on every turn.
  const group = scanGroupFor(sessionId);
  if (!group) return null;
  const p = path.join(root, group, sessionId);
  return fs.existsSync(p) ? p : null;
}

/** List rewind points (metadata only — no file snapshot bodies). */
export function listRewindPoints(sessionId, cwd) {
  const dir = findSessionDir(sessionId, cwd);
  if (!dir) return { ok: false, error: "session not found", points: [] };
  const file = path.join(dir, "rewind_points.jsonl");
  if (!fs.existsSync(file)) return { ok: true, points: [], path: file };
  const points = [];
  try {
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const j = JSON.parse(line);
        const files = Object.keys(j.file_snapshots || j.after_snapshots || {});
        points.push({
          promptIndex: j.prompt_index ?? j.promptIndex ?? points.length,
          createdAt: j.created_at || j.createdAt || null,
          fileCount: files.length,
          files: files.slice(0, 20),
        });
      } catch {
        /* */
      }
    }
  } catch (e) {
    return { ok: false, error: e.message || String(e), points: [] };
  }
  return { ok: true, points, path: file };
}

/** Session info drawer payload */
export function getSessionInfo(sessionId, cwd) {
  const dir = findSessionDir(sessionId, cwd);
  if (!dir) return { ok: false, error: "session not found" };
  let summary = {};
  try {
    const p = path.join(dir, "summary.json");
    if (fs.existsSync(p)) summary = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    /* */
  }
  const resolvedCwd =
    cwd ||
    (dir.includes("%2F")
      ? decodeURIComponent(path.basename(path.dirname(dir)))
      : findSessionCwd(sessionId));
  return {
    ok: true,
    sessionId,
    cwd: resolvedCwd,
    dir,
    title: summary.generated_title || getDeskTitle(sessionId) || null,
    model: summary.current_model_id || null,
    agentName: summary.agent_name || null,
    numMessages: summary.num_messages ?? summary.num_chat_messages ?? null,
    nextTraceTurn: summary.next_trace_turn ?? null,
    createdAt: summary.created_at || null,
    updatedAt: summary.updated_at || summary.last_active_at || null,
    gitRoot: summary.git_root_dir || null,
    headBranch: summary.head_branch || null,
    headCommit: summary.head_commit || null,
    reasoningEffort: summary.reasoning_effort || null,
    sandboxProfile: summary.sandbox_profile || null,
  };
}

/** User prompt history for history panel */
export function listPromptHistory(sessionId, cwd, limit = 50) {
  const transcript = loadTranscript(sessionId, cwd);
  const prompts = [];
  for (const m of transcript.messages || []) {
    if (m.role !== "user") continue;
    const content = String(m.content || "").trim();
    if (!content) continue;
    prompts.push({
      id: m.id || `u_${prompts.length}`,
      content: content.slice(0, 2000),
      preview: content.replace(/\s+/g, " ").slice(0, 120),
    });
    if (prompts.length >= limit) break;
  }
  return { ok: true, sessionId, prompts: prompts.reverse() };
}

/** Delete session directory (and desk shadow). Destructive. */
export function deleteSession(sessionId, cwd) {
  const dir = findSessionDir(sessionId, cwd);
  if (!dir) return { ok: false, error: "session not found" };
  // Safety: must be under sessions root
  const root = sessionsRoot();
  if (!dir.startsWith(root)) return { ok: false, error: "refusing delete outside sessions" };
  // P4 ownership guard: rm -rf on a directory a live `grok` is appending to
  // yanks the store out from under it mid-turn. Refuse and name the pid.
  const owner = sessionOwner(sessionId);
  if (owner) {
    return {
      ok: false,
      error:
        `Session is open in a live grok (pid ${owner.pid}` +
        `${owner.cwd ? ` · ${owner.cwd}` : ""}). Quit that ${
          owner.kind === "headless" ? "run" : "terminal"
        } first, then delete.`,
      owner,
    };
  }
  fs.rmSync(dir, { recursive: true, force: true });
  // P7: the tree changed under us — drop the shared snapshot and this id's memos.
  bumpSessionScan();
  interactionFreeze.delete(sessionId);
  subagentMemo.delete(sessionId);
  notSubagentMemo.delete(sessionId);
  try {
    clearDeskMessages(sessionId);
  } catch {
    /* */
  }
  // P5 — prune desk-index.
  //
  // This used to read the file itself and look for `idx.sessions[sessionId]`.
  // The schema key is `sessionIds` (see `loadDeskIndex`), so the branch was
  // dead: the index NEVER shrank, and every deleted session stayed in it
  // forever. Go through loadDeskIndex/saveDeskIndex so the in-memory cache and
  // the serialized tmp+rename write stay the one path that touches this file.
  try {
    const idx = loadDeskIndex();
    if (idx.sessionIds && idx.sessionIds[sessionId]) {
      delete idx.sessionIds[sessionId];
      saveDeskIndex(idx);
    }
  } catch {
    /* */
  }
  return { ok: true, sessionId, deleted: dir };
}

function contentToText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part) return "";
        if (typeof part === "string") return part;
        if (part.type === "text" && part.text) return part.text;
        return "";
      })
      .join("");
  }
  if (typeof content === "object" && content.text) return String(content.text);
  return "";
}

/**
 * Normalize for display + dedupe.
 * Strips agent-only attach notes, image_files blocks, and scaffolding so
 * Desk UI line and ACP history line of the same turn collapse to one.
 */
function stripAgentOnlySuffixes(text) {
  let t = String(text || "");
  // Desk injects this for the agent only — never show as a second user bubble
  t = t.replace(/^\s*\[GROK DESK — PROJECT CONTEXT\][\s\S]*?(?:\n\n|\r\n\r\n)/i, "");
  t = t.replace(/\n*\s*\[ATTACHED FILES[\s\S]*?\]\s*$/i, "");
  t = t.replace(/<image_files>[\s\S]*?<\/image_files>/gi, "");
  t = t.replace(/\[Image #\d+\]/gi, "");
  return t.replace(/\s+/g, " ").trim();
}

/** Fingerprint for merge dedupe (role + normalized body). */
function messageDedupeKey(role, content) {
  const body = stripAgentOnlySuffixes(content).slice(0, 240).toLowerCase();
  return `${role}:${body}`;
}

/** Prefer the human line inside <user_query>; drop pure system scaffolding. */
function extractUserFacingText(raw) {
  let text = String(raw || "").trim();
  if (!text) return null;
  const m = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
  if (m) {
    const q = stripAgentOnlySuffixes(m[1]);
    return q || null;
  }
  // Skip injected system blobs with no real user line
  if (
    /<system-reminder>|<user_info>|<agent_skills>|<mcp_servers>/i.test(text) &&
    !/<user_query>/i.test(text)
  ) {
    return null;
  }
  // Desk sometimes stores plain user text
  if (text.startsWith("You are Grok")) return null;
  text = stripAgentOnlySuffixes(text);
  // Bare leftover from truncated attach note
  if (!text || text === "[" || text === "]") return null;
  return text || null;
}

function loadFromChatHistory(sessionDir) {
  const p = path.join(sessionDir, "chat_history.jsonl");
  if (!fs.existsSync(p)) return [];
  const messages = [];
  let n = 0;
  const lines = fs.readFileSync(p, "utf8").split("\n");
  const slice = lines.length > 4000 ? lines.slice(-4000) : lines;
  for (const line of slice) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const kind = row.type || row.role;
    if (kind === "user" || kind === "human") {
      const face = extractUserFacingText(contentToText(row.content));
      if (!face) continue;
      messages.push({ id: `ch_u_${n++}`, role: "user", content: face });
    } else if (kind === "assistant" || kind === "agent" || kind === "ai") {
      const text = contentToText(row.content).trim();
      if (!text) continue;
      messages.push({ id: `ch_a_${n++}`, role: "assistant", content: text });
    }
  }
  return messages;
}

function loadFromUpdates(sessionDir) {
  const updatesPath = path.join(sessionDir, "updates.jsonl");
  if (!fs.existsSync(updatesPath)) return { messages: [], truncated: false };
  const messages = [];
  let cur = null;
  const flush = () => {
    if (cur && (cur.content.trim() || cur.thought?.trim() || (cur.tools && cur.tools.length))) {
      messages.push({
        id: cur.id,
        role: cur.role,
        content: cur.content.trim(),
        thought: cur.thought?.trim() || undefined,
        tools: cur.tools?.length ? cur.tools : undefined,
        plan: cur.plan?.length ? cur.plan : undefined,
      });
    }
    cur = null;
  };
  const lines = fs.readFileSync(updatesPath, "utf8").split("\n");
  const slice = lines.length > 8000 ? lines.slice(-8000) : lines;
  let n = 0;
  for (const line of slice) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const update = row.params?.update || row.update;
    if (!update) continue;
    const kind = update.sessionUpdate || update.type;
    if (kind === "user_message_chunk") {
      const text = update.content?.text ?? update.text ?? "";
      if (!text) continue;
      if (!cur || cur.role !== "user") {
        flush();
        cur = { role: "user", content: text, id: `u_${n++}`, thought: "", tools: [], plan: [] };
      } else cur.content += text;
    } else if (kind === "agent_message_chunk") {
      const text = update.content?.text ?? update.text ?? "";
      if (!text) continue;
      if (!cur || cur.role !== "assistant") {
        flush();
        cur = { role: "assistant", content: text, id: `a_${n++}`, thought: "", tools: [], plan: [] };
      } else cur.content += text;
    } else if (kind === "agent_thought_chunk") {
      const text = update.content?.text ?? update.text ?? "";
      if (!text) continue;
      if (!cur || cur.role !== "assistant") {
        flush();
        cur = { role: "assistant", content: "", id: `a_${n++}`, thought: text, tools: [], plan: [] };
      } else cur.thought = (cur.thought || "") + text;
    } else if (kind === "tool_call" || kind === "tool_call_update") {
      if (!cur || cur.role !== "assistant") {
        flush();
        cur = { role: "assistant", content: "", id: `a_${n++}`, thought: "", tools: [], plan: [] };
      }
      const id = String(update.toolCallId || update.tool_call_id || update.id || `t_${cur.tools.length}`);
      const existing = cur.tools.find((t) => t.id === id);
      if (existing) {
        if (update.status) existing.status = String(update.status);
        if (update.title) existing.title = String(update.title);
      } else if (kind === "tool_call") {
        cur.tools.push({
          id,
          title: String(update.title || update.name || "tool"),
          kind: update.kind ? String(update.kind) : undefined,
          status: String(update.status || "pending"),
        });
      }
    } else if (kind === "plan") {
      const entries = update.entries;
      if (Array.isArray(entries)) {
        if (!cur || cur.role !== "assistant") {
          flush();
          cur = { role: "assistant", content: "", id: `a_${n++}`, thought: "", tools: [], plan: [] };
        }
        cur.plan = entries.map((e) => ({
          content: String(e.content || ""),
          status: String(e.status || "pending"),
          priority: e.priority ? String(e.priority) : undefined,
        }));
      }
    }
  }
  flush();
  // Normalize user lines the same way
  const normalized = messages
    .map((m) => {
      if (m.role !== "user") return m;
      const face = extractUserFacingText(m.content);
      if (!face) return null;
      return { ...m, content: face };
    })
    .filter(Boolean);
  return {
    messages: normalized,
    truncated: lines.length > slice.length,
  };
}

function deskMessagesPath() {
  ensureUserDataMigrated();
  return userDataPath("desk-messages.json");
}

/**
 * P7 — cache the legacy shadow log.
 *
 * This file is 814 KB on this machine and P5 made it read-only, yet
 * `firstDeskUserTitle()` re-read AND re-parsed the whole thing once per session
 * while building the sidebar: ~500 full JSON parses (~400 MB of parsing) per
 * `GET /api/projects`. It is now parsed once and re-validated with a single
 * `stat` — size + mtime — so an external edit is still picked up.
 */
let deskMessagesCache = null; // { path, size, mtimeMs, store }

function loadDeskMessagesStore() {
  let p;
  try {
    p = deskMessagesPath();
  } catch {
    return {};
  }
  let st = null;
  try {
    st = fs.statSync(p);
  } catch {
    st = null;
  }
  if (!st) {
    deskMessagesCache = { path: p, size: -1, mtimeMs: -1, store: {} };
    return deskMessagesCache.store;
  }
  if (
    deskMessagesCache &&
    deskMessagesCache.path === p &&
    deskMessagesCache.size === st.size &&
    deskMessagesCache.mtimeMs === st.mtimeMs
  ) {
    return deskMessagesCache.store;
  }
  let store = {};
  try {
    store = JSON.parse(fs.readFileSync(p, "utf8")) || {};
  } catch {
    store = {};
  }
  deskMessagesCache = { path: p, size: st.size, mtimeMs: st.mtimeMs, store };
  return store;
}

/**
 * Atomic write. Only the delete path writes this file now (see below), but a
 * torn write here used to take the WHOLE log with it: `loadDeskMessagesStore`
 * swallows a JSON parse error and returns `{}`.
 */
function saveDeskMessagesStore(store) {
  const p = deskMessagesPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store));
  fs.renameSync(tmp, p);
  deskMessagesCache = null; // re-stat on next read
}

/**
 * P5 — the shadow transcript is RETIRED.
 *
 * `~/.grok/sessions/<cwd>/<id>/` is the single source of truth and
 * `daemon/session-feed.js` projects it. This file was a third copy kept in
 * agreement by hand, written with a non-atomic whole-file read-modify-write:
 *
 *   - two parallel turns interleaved read → modify → write and lost messages;
 *   - a crash mid-write left invalid JSON, and `loadDeskMessagesStore` returns
 *     `{}` on a parse error — the entire log, every session, silently gone;
 *   - it grew to 788 KB and had not been written since 28 Aug anyway.
 *
 * Writing stops here. Reading stays (`loadDeskMessages`, `deskLastMessageAtMap`)
 * as a legacy fallback so chats that predate the feed still render, and the
 * user's existing file is never deleted.
 *
 * These two remain as no-op-write seams because the prompt path still owes the
 * sidebar its sort key on a real turn — that is a desk-index write, not a
 * transcript write.
 */
export function appendDeskMessage(sessionId, message) {
  if (!sessionId || !message) return;
  // Bump sidebar sort key — real user/assistant turn, not open
  try {
    touchSessionInteraction(sessionId, undefined);
  } catch {
    /* */
  }
}

/**
 * Streaming counterpart of `appendDeskMessage`. Also no longer persists.
 * A mid-stream row is not a real interaction, so it does not bump the sort key.
 */
export function upsertDeskMessage(sessionId, message) {
  if (!sessionId || !message) return;
  if (message.streaming) return;
  try {
    touchSessionInteraction(sessionId, undefined);
  } catch {
    /* */
  }
}

/** Legacy read-only fallback — chats that predate the feed still render. */
export function loadDeskMessages(sessionId) {
  if (!sessionId) return [];
  const store = loadDeskMessagesStore();
  const list = store[sessionId];
  if (!Array.isArray(list)) return [];
  return list.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    thought: m.thought,
    tools: m.tools,
    plan: m.plan,
    streaming: Boolean(m.streaming),
  }));
}

/**
 * Drop ONE session's legacy rows when that session is deleted.
 * The only remaining writer of this file, and it never removes the file itself.
 */
export function clearDeskMessages(sessionId) {
  if (!sessionId) return;
  const store = loadDeskMessagesStore();
  if (store[sessionId]) {
    delete store[sessionId];
    saveDeskMessagesStore(store);
  }
}

/**
 * Reconstruct chat messages for resume.
 * Prefer chat_history.jsonl, merge updates.jsonl, always union Desk shadow log.
 */
export function loadTranscript(sessionId, cwd) {
  // Agent Mail email-agent sessions (not ACP / ~/.grok sessions)
  if (String(sessionId).startsWith("mail:")) {
    return loadAgentMailTranscript(sessionId);
  }

  const sessionDir = findSessionDir(sessionId, cwd);
  if (!sessionDir) {
    const deskOnly = loadDeskMessages(sessionId);
    return {
      ok: deskOnly.length > 0,
      error: deskOnly.length ? undefined : "session not found",
      messages: deskOnly,
      summary: null,
    };
  }

  const summary = sessionMeta(sessionDir, cwd || "");
  const fromHistory = loadFromChatHistory(sessionDir);
  const fromUpdates = loadFromUpdates(sessionDir);
  const fromDesk = loadDeskMessages(sessionId);

  // Prefer the richest source for the main thread, then fill gaps from desk log.
  let messages =
    fromHistory.length >= fromUpdates.messages.length ? fromHistory : fromUpdates.messages;

  if (fromDesk.length) {
    // If disk is empty/sparse (common mid-turn), desk log is ground truth for UI.
    if (messages.length === 0) {
      messages = fromDesk;
    } else if (fromDesk.length > messages.length) {
      messages = mergeTranscripts(messages, fromDesk);
    } else {
      // Ensure every desk user line appears (prompt typed in Desk always saved)
      messages = mergeTranscripts(messages, fromDesk);
    }
  }

  const capped = messages.length > 200 ? messages.slice(-200) : messages;
  return {
    ok: true,
    messages: capped,
    summary,
    truncated:
      messages.length > capped.length ||
      fromUpdates.truncated ||
      fromHistory.length > 200,
  };
}

/** Merge by message id first; content fingerprint only as last-ditch dedupe. */
function mergeTranscripts(primary, secondary) {
  const byId = new Map();
  const take = (m) => {
    if (!m) return;
    const id = m.id || null;
    if (id) {
      if (!byId.has(id)) {
        byId.set(id, m);
      } else {
        const prev = byId.get(id);
        const richer =
          (m.content?.length || 0) > (prev.content?.length || 0) ? m : prev;
        byId.set(id, {
          ...richer,
          thought: richer.thought || prev.thought || m.thought,
          tools: richer.tools?.length ? richer.tools : prev.tools || m.tools,
          plan: richer.plan?.length ? richer.plan : prev.plan || m.plan,
        });
      }
    }
  };
  for (const m of primary) take(m);
  for (const m of secondary) take(m);

  const out = [];
  const usedIds = new Set();
  const seen = new Set();
  for (const m of primary) {
    if (m?.id && byId.has(m.id) && !usedIds.has(m.id)) {
      usedIds.add(m.id);
      const row = byId.get(m.id);
      const cleaned =
        row.role === "user"
          ? { ...row, content: stripAgentOnlySuffixes(row.content) || row.content }
          : row;
      out.push(cleaned);
      seen.add(messageDedupeKey(cleaned.role, cleaned.content));
    }
  }
  for (const m of secondary) {
    if (m?.id && byId.has(m.id) && !usedIds.has(m.id)) {
      usedIds.add(m.id);
      const row = byId.get(m.id);
      const content =
        row.role === "user" ? stripAgentOnlySuffixes(row.content) || row.content : row.content;
      const key = messageDedupeKey(row.role, content);
      if (seen.has(key) && content) continue;
      seen.add(key);
      out.push({ ...row, content });
    }
  }
  // Content-only rows (ACP history ids like ch_u_N vs desk_u_*)
  const seenAfterIds = new Set(out.map((m) => messageDedupeKey(m.role, m.content)));
  const rest = [];
  for (const src of [primary, secondary]) {
    for (const m of src) {
      if (m?.id && usedIds.has(m.id)) continue;
      const content =
        m.role === "user" ? stripAgentOnlySuffixes(m.content) || m.content : m.content;
      const key = messageDedupeKey(m.role, content);
      if (seenAfterIds.has(key)) continue;
      seenAfterIds.add(key);
      rest.push({ ...m, content });
    }
  }
  return out.concat(rest);
}

export function findSessionCwd(sessionId) {
  if (!sessionId) return null;
  // P7: index lookup instead of a readdir of every project group. This ran on
  // every prompt, every queue drain and every load.
  const group = scanGroupFor(sessionId);
  if (!group) return null;
  if (!fs.existsSync(path.join(sessionsRoot(), group, sessionId))) return null;
  return decodeCwdKey(group);
}
