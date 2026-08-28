/**
 * Scheduled automations — local JSON + next-run math.
 * Daemon tick (index.js) fires due jobs via the ACP pool.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { userDataPath } from "./user-data.js";

const FILE = "automations.json";
const HISTORY_MAX = 50;
const FREQS = new Set(["once", "hourly", "daily", "weekdays", "weekly"]);

function filePath() {
  return userDataPath(FILE);
}

function emptyStore() {
  return { version: 1, jobs: [], history: [] };
}

function readStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath(), "utf8"));
    if (!raw || typeof raw !== "object") return emptyStore();
    return {
      version: 1,
      jobs: Array.isArray(raw.jobs) ? raw.jobs : [],
      history: Array.isArray(raw.history) ? raw.history.slice(-HISTORY_MAX) : [],
    };
  } catch {
    return emptyStore();
  }
}

function writeStore(store) {
  const dest = filePath();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  const body = {
    version: 1,
    jobs: store.jobs || [],
    history: (store.history || []).slice(-HISTORY_MAX),
  };
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2));
  fs.renameSync(tmp, dest);
}

function parseTime(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || "09:00"));
  if (!m) return { h: 9, min: 0 };
  return { h: Math.min(23, Number(m[1])), min: Math.min(59, Number(m[2])) };
}

export function computeNextRun(job, from = new Date()) {
  const freq = FREQS.has(job.frequency) ? job.frequency : "daily";
  const { h, min } = parseTime(job.time);
  const weekdays = Array.isArray(job.weekdays) && job.weekdays.length
    ? job.weekdays.map(Number)
    : [1, 2, 3, 4, 5];
  const start = new Date(from.getTime());

  if (freq === "hourly") {
    const n = new Date(start.getTime());
    n.setMinutes(min, 0, 0);
    if (n <= start) n.setHours(n.getHours() + 1);
    return n.toISOString();
  }

  const candidate = new Date(start.getTime());
  candidate.setSeconds(0, 0);
  candidate.setHours(h, min, 0, 0);
  if (candidate <= start) candidate.setDate(candidate.getDate() + 1);

  if (freq === "once") {
    return candidate.toISOString();
  }

  for (let i = 0; i < 14; i++) {
    const dow = candidate.getDay();
    if (freq === "daily") return candidate.toISOString();
    if (freq === "weekdays" && dow >= 1 && dow <= 5) return candidate.toISOString();
    if (freq === "weekly" && weekdays.includes(dow)) return candidate.toISOString();
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate.toISOString();
}

function normalizeJob(input, existing = null) {
  const title = String(input.title || existing?.title || "Untitled").trim().slice(0, 120);
  const prompt = String(input.prompt || existing?.prompt || "").trim();
  if (!prompt) throw new Error("prompt required");
  const frequency = FREQS.has(input.frequency)
    ? input.frequency
    : existing?.frequency || "daily";
  const time = String(input.time || existing?.time || "09:00");
  const job = {
    id: existing?.id || crypto.randomUUID(),
    title,
    prompt,
    enabled: input.enabled != null ? Boolean(input.enabled) : existing?.enabled !== false,
    cwd: input.cwd != null ? String(input.cwd || "") : existing?.cwd || "",
    model: input.model != null ? String(input.model || "") : existing?.model || "",
    frequency,
    time,
    weekdays: Array.isArray(input.weekdays)
      ? input.weekdays.map(Number)
      : existing?.weekdays || [1, 2, 3, 4, 5],
    notify: input.notify != null ? Boolean(input.notify) : existing?.notify !== false,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastRunAt: existing?.lastRunAt || null,
    lastStatus: existing?.lastStatus || null,
    nextRunAt: null,
  };
  job.nextRunAt = input.nextRunAt || computeNextRun(job);
  return job;
}

export function listAutomations() {
  return readStore();
}

export function createAutomation(input) {
  const store = readStore();
  const titleKey = String(input.title || "").trim().toLowerCase();
  if (titleKey) {
    const hit = [...store.jobs]
      .reverse()
      .find((j) => String(j.title || "").trim().toLowerCase() === titleKey);
    if (hit) return updateAutomation(hit.id, input);
  }
  const job = normalizeJob(input);
  store.jobs.push(job);
  writeStore(store);
  return job;
}

export function updateAutomation(id, input) {
  const store = readStore();
  const idx = store.jobs.findIndex((j) => j.id === id);
  if (idx < 0) throw new Error("automation not found");
  const job = normalizeJob({ ...store.jobs[idx], ...input }, store.jobs[idx]);
  store.jobs[idx] = job;
  writeStore(store);
  return job;
}

export function deleteAutomation(id) {
  const store = readStore();
  const next = store.jobs.filter((j) => j.id !== id);
  if (next.length === store.jobs.length) throw new Error("automation not found");
  store.jobs = next;
  writeStore(store);
  return { ok: true };
}

export function dueAutomations(now = new Date()) {
  const iso = now.toISOString();
  return readStore().jobs.filter((j) => j.enabled && j.nextRunAt && j.nextRunAt <= iso);
}

export function markAutomationRun(id, result = {}) {
  const store = readStore();
  const job = store.jobs.find((j) => j.id === id);
  if (!job) throw new Error("automation not found");
  const at = new Date().toISOString();
  const outcome = result.ok === false ? "error" : result.skipped ? "skipped" : "ok";
  job.lastRunAt = at;
  job.lastStatus = outcome;
  job.updatedAt = at;
  if (job.frequency === "once" && outcome === "ok") {
    job.enabled = false;
    job.nextRunAt = null;
  } else if (outcome !== "skipped") {
    job.nextRunAt = computeNextRun(job, new Date(at));
  }
  store.history.push({
    id: crypto.randomUUID(),
    scheduleId: job.id,
    name: job.title,
    at,
    outcome,
    error: result.error ? String(result.error).slice(0, 240) : null,
    sessionId: result.sessionId || null,
    source: result.source || "host",
  });
  store.history = store.history.slice(-HISTORY_MAX);
  writeStore(store);
  return job;
}

/** Optional fire hook registered by the daemon. */
let fireHandler = null;
export function setAutomationFireHandler(fn) {
  fireHandler = typeof fn === "function" ? fn : null;
}

export async function runAutomationNow(id, source = "run_now") {
  const store = readStore();
  const job = store.jobs.find((j) => j.id === id);
  if (!job) throw new Error("automation not found");
  if (!fireHandler) throw new Error("automation runner not attached");
  try {
    const fired = await fireHandler(job);
    markAutomationRun(id, { ok: true, sessionId: fired?.sessionId || null, source });
    return { ok: true, sessionId: fired?.sessionId || null };
  } catch (e) {
    markAutomationRun(id, { ok: false, error: e.message || String(e), source });
    throw e;
  }
}

export async function runDueAutomations({ busy } = {}) {
  const due = dueAutomations();
  const results = [];
  for (const job of due) {
    if (busy) {
      markAutomationRun(job.id, { skipped: true, source: "host" });
      results.push({ id: job.id, outcome: "skipped" });
      continue;
    }
    if (!fireHandler) {
      results.push({ id: job.id, outcome: "error", error: "runner not attached" });
      continue;
    }
    try {
      const fired = await fireHandler(job);
      markAutomationRun(job.id, { ok: true, sessionId: fired?.sessionId || null, source: "host" });
      results.push({ id: job.id, outcome: "ok", sessionId: fired?.sessionId || null });
    } catch (e) {
      markAutomationRun(job.id, { ok: false, error: e.message || String(e), source: "host" });
      results.push({ id: job.id, outcome: "error", error: e.message || String(e) });
    }
  }
  return results;
}
