#!/usr/bin/env node
/**
 * Grok Desk Feature Radar — daily scan
 * Writes ~/Library/Application Support/GrokDesk/radar/YYYY-MM-DD.json
 *
 * Local-first (version, changelog, models). Optional network fetches when online.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GROK_HOME = process.env.GROK_HOME || path.join(os.homedir(), ".grok");
const APP_SUPPORT = path.join(os.homedir(), "Library", "Application Support", "GrokDesk", "radar");
const TODAY = new Date().toISOString().slice(0, 10);

const SOURCES = {
  changelog: "https://x.ai/build/changelog",
  releaseNotes: "https://docs.x.ai/developers/release-notes",
  models: "https://docs.x.ai/developers/models",
  buildOverview: "https://docs.x.ai/build/overview",
  marketplace: "https://github.com/xai-org/plugin-marketplace",
  grokBuildRepo: "https://github.com/xai-org/grok-build",
};

function readJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function readText(file, max = 80_000) {
  try {
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file, "utf8").slice(0, max);
  } catch {
    return null;
  }
}

async function fetchText(url, timeoutMs = 12_000) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "GrokDesk-Radar/1.0" },
    });
    clearTimeout(t);
    if (!res.ok) return { ok: false, status: res.status, url };
    const text = await res.text();
    return { ok: true, status: res.status, url, text: text.slice(0, 100_000), etag: res.headers.get("etag") };
  } catch (e) {
    return { ok: false, url, error: e.message || String(e) };
  }
}

function extractModelIds(cache) {
  const ids = new Set();
  if (!cache) return [];
  const list = Array.isArray(cache?.models)
    ? cache.models
    : Array.isArray(cache)
      ? cache
      : [];
  for (const m of list) {
    if (m && typeof m === "object" && typeof m.id === "string") ids.add(m.id);
  }
  return [...ids].sort();
}

function hashish(s) {
  let h = 0;
  const str = String(s || "");
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

function priorSnapshot() {
  if (!fs.existsSync(APP_SUPPORT)) return null;
  const files = fs
    .readdirSync(APP_SUPPORT)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f !== `${TODAY}.json`)
    .sort()
    .reverse();
  if (!files.length) return null;
  return readJson(path.join(APP_SUPPORT, files[0]), null);
}

/** Known Desk gaps — proposals when Build has capability Desk lacks UI for */
/** Gaps still open after Phase 0–4 Desk build (2026-08-08) */
const DESK_GAP_CATALOG = [
  { id: "permissions", priority: "P1", text: "Permission cards (optional ask mode vs always-approve)" },
  { id: "real-terminal", priority: "P1", text: "Real terminal I/O pane (not tool-title projection only)" },
  { id: "diff-preview", priority: "P1", text: "File diff/content preview from tool results" },
  { id: "workflow-runs", priority: "P1", text: "Live workflow run dashboard (pause/resume/stop)" },
  { id: "usage-quota", priority: "P2", text: "Live SuperGrok quota when API exposes remaining balance" },
  { id: "worktree-actions", priority: "P1", text: "Worktree apply/merge/discard buttons (not list-only)" },
  { id: "mcp-oauth-ui", priority: "P1", text: "In-app MCP OAuth connect (today: list + agent)" },
  { id: "skill-create-wizard", priority: "P2", text: "Create-skill visual wizard without slash" },
];

function buildProposals({ newModels, changelogBullets, prior }) {
  const proposals = [];
  const priorIds = new Set((prior?.desk_gap_proposals || []).map((p) => p.id));

  // Always surface top gaps not yet in prior "shipped" list
  for (const g of DESK_GAP_CATALOG) {
    if (priorIds.has(g.id) && prior?.shipped?.includes?.(g.id)) continue;
    proposals.push({ ...g, source: "desk_gap_catalog" });
  }

  for (const id of newModels) {
    proposals.unshift({
      id: `model-${id}`,
      priority: "P0",
      text: `New model available: ${id} — surface in Desk model picker`,
      source: "models_cache",
    });
  }

  for (const b of changelogBullets.slice(0, 8)) {
    const id = `cl-${hashish(b).slice(0, 8)}`;
    proposals.push({
      id,
      priority: "P1",
      text: `Build changelog: ${b.slice(0, 140)}`,
      source: "local_changelog",
    });
  }

  // Dedup by id, cap 20
  const seen = new Set();
  const out = [];
  for (const p of proposals) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
    if (out.length >= 20) break;
  }
  return out;
}

function parseChangelogBullets(md) {
  if (!md) return [];
  const lines = md.split("\n");
  const bullets = [];
  for (const line of lines) {
    const m = line.match(/^\s*[-*]\s+(.+)/);
    if (m) bullets.push(m[1].trim());
    if (bullets.length >= 40) break;
  }
  return bullets;
}

async function main() {
  fs.mkdirSync(APP_SUPPORT, { recursive: true });
  fs.mkdirSync(path.join(APP_SUPPORT, "queue"), { recursive: true });

  const versionJson = readJson(path.join(GROK_HOME, "version.json"), {});
  const modelsCache = readJson(path.join(GROK_HOME, "models_cache.json"), {});
  const localChangelog = readText(path.join(GROK_HOME, "CHANGELOG.md"), 40_000) || "";
  const bundledManifest = readJson(path.join(GROK_HOME, "bundled", "manifest.json"), null);
  const prior = priorSnapshot();

  let binaryVersion = null;
  try {
    const { stdout } = await execFileAsync(
      process.env.GROK_BIN || path.join(GROK_HOME, "bin", "grok"),
      ["--version"],
      { timeout: 5000 },
    );
    binaryVersion = (stdout || "").trim();
  } catch {
    /* */
  }

  const modelIds = extractModelIds(modelsCache);
  const priorModels = new Set(prior?.model_ids || []);
  const newModels = modelIds.filter((id) => !priorModels.has(id));

  const changelogBullets = parseChangelogBullets(localChangelog);
  const priorClHash = prior?.local_changelog_hash || null;
  const clHash = hashish(localChangelog);
  const newChangelog = clHash !== priorClHash ? changelogBullets.slice(0, 15) : [];

  // Network (best-effort)
  const remote = {};
  if (process.env.RADAR_OFFLINE !== "1") {
    for (const [key, url] of Object.entries(SOURCES)) {
      const r = await fetchText(url);
      remote[key] = {
        ok: r.ok,
        status: r.status || null,
        etag: r.etag || null,
        error: r.error || null,
        hash: r.text ? hashish(r.text) : null,
        changed: prior?.remote?.[key]?.hash ? prior.remote[key].hash !== hashish(r.text || "") : Boolean(r.ok),
      };
    }
  }

  const desk_gap_proposals = buildProposals({
    newModels,
    changelogBullets: newChangelog,
    prior,
  });

  const snapshot = {
    date: TODAY,
    scanned_at: new Date().toISOString(),
    local_version: versionJson.version || versionJson.semver || null,
    binary_version: binaryVersion,
    model_ids: modelIds,
    new_models: newModels,
    local_changelog_hash: clHash,
    changelog_bullets: newChangelog,
    bundled_manifest_id: bundledManifest?.id || bundledManifest?.revision || null,
    remote,
    desk_gap_proposals,
    summary: [
      newModels.length ? `${newModels.length} new model(s)` : null,
      newChangelog.length ? `${newChangelog.length} changelog bullets` : null,
      `${desk_gap_proposals.length} proposals`,
    ]
      .filter(Boolean)
      .join(" · ") || "no deltas",
  };

  const outPath = path.join(APP_SUPPORT, `${TODAY}.json`);
  fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
  console.log(`[radar] wrote ${outPath}`);
  console.log(`[radar] ${snapshot.summary}`);
  return snapshot;
}

main().catch((e) => {
  console.error("[radar] failed", e);
  process.exit(1);
});
