/**
 * Build surface APIs — skills, MCP, models, slash registry, inspect, radar.
 * Never touches the turn controller / ACP prompt path.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { userDataPath } from "../user-data.js";
import {
  createWorktree,
  gcWorktrees,
  listWorktreesCli,
  mergeWorktree,
  removeWorktree,
} from "../worktree-ops.js";
import { collectSessionUsage, probeAccountCredits } from "../usage-collect.js";
import {
  deleteSession,
  findSessionDir,
  getSessionInfo,
  listPromptHistory,
  listRewindPoints,
  setDeskTitle,
} from "../session-store.js";
import * as cliExt from "../cli-ext.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const execFileAsync = promisify(execFile);
const GROK_HOME = process.env.GROK_HOME || path.join(os.homedir(), ".grok");
const GROK_BIN = process.env.GROK_BIN || path.join(GROK_HOME, "bin", "grok");

/** Static slash registry — maps to Desk actions / views */
export const SLASH_REGISTRY = [
  { id: "new", cmd: "/new", aliases: ["/clear"], category: "session", label: "New chat", action: "new_chat" },
  { id: "resume", cmd: "/resume", category: "session", label: "Resume session", action: "open_sessions" },
  { id: "dashboard", cmd: "/dashboard", aliases: ["/agents-dashboard", "/sessions"], category: "session", label: "Agent dashboard", action: "view:home" },
  { id: "compact", cmd: "/compact", category: "session", label: "Compact context", action: "prompt:/compact" },
  { id: "context", cmd: "/context", category: "session", label: "Context usage", action: "prompt:/context" },
  { id: "session-info", cmd: "/session-info", aliases: ["/status", "/info"], category: "session", label: "Session info", action: "prompt:/session-info" },
  { id: "fork", cmd: "/fork", category: "session", label: "Fork session", action: "prompt:/fork" },
  { id: "rewind", cmd: "/rewind", aliases: ["/undo"], category: "session", label: "Rewind turn", action: "prompt:/rewind" },
  { id: "rename", cmd: "/rename", aliases: ["/title"], category: "session", label: "Rename session", action: "prompt:/rename" },
  { id: "delete", cmd: "/delete", category: "session", label: "Delete session", action: "prompt:/delete" },
  { id: "export", cmd: "/export", category: "session", label: "Export transcript", action: "export_chat" },
  { id: "copy", cmd: "/copy", category: "session", label: "Copy last reply", action: "copy_chat" },
  { id: "model", cmd: "/model", aliases: ["/m"], category: "model", label: "Switch model", action: "view:settings" },
  { id: "effort", cmd: "/effort", category: "model", label: "Reasoning effort", action: "prompt:/effort" },
  { id: "always-approve", cmd: "/always-approve", category: "mode", label: "Always approve tools", action: "prompt:/always-approve" },
  { id: "auto", cmd: "/auto", category: "mode", label: "Auto permission mode", action: "prompt:/auto" },
  { id: "plan", cmd: "/plan", category: "mode", label: "Enter plan mode", action: "prompt:/plan" },
  { id: "view-plan", cmd: "/view-plan", aliases: ["/show-plan", "/plan-view"], category: "mode", label: "View plan", action: "view:plan" },
  { id: "memory", cmd: "/memory", aliases: ["/mem"], category: "memory", label: "Memory browser", action: "view:memory" },
  { id: "flush", cmd: "/flush", category: "memory", label: "Flush session to memory", action: "prompt:/flush" },
  { id: "dream", cmd: "/dream", category: "memory", label: "Dream (consolidate memory)", action: "prompt:/dream" },
  { id: "remember", cmd: "/remember", category: "memory", label: "Remember note", action: "prompt:/remember " },
  { id: "hooks", cmd: "/hooks", category: "extensions", label: "Hooks", action: "view:hooks" },
  { id: "plugins", cmd: "/plugins", category: "extensions", label: "Plugins", action: "view:marketplace" },
  { id: "marketplace", cmd: "/marketplace", category: "extensions", label: "Marketplace", action: "view:marketplace" },
  { id: "skills", cmd: "/skills", category: "extensions", label: "Skills", action: "view:skills" },
  { id: "mcps", cmd: "/mcps", category: "extensions", label: "MCP servers", action: "view:mcp" },
  { id: "loop", cmd: "/loop", category: "automation", label: "Schedule loop", action: "prompt:/loop" },
  { id: "goal", cmd: "/goal", category: "automation", label: "Goal mode", action: "prompt:/goal" },
  { id: "deep-research", cmd: "/deep-research", category: "automation", label: "Deep research", action: "prompt:/deep-research" },
  { id: "workflow", cmd: "/workflow", category: "automation", label: "Run workflow", action: "prompt:/workflow " },
  { id: "workflows", cmd: "/workflows", category: "automation", label: "Workflow runs", action: "view:workflows" },
  { id: "worktrees", cmd: "/worktrees", category: "session", label: "Git worktrees", action: "view:worktrees" },
  { id: "media", cmd: "/media", category: "media", label: "Media studio", action: "view:media" },
  { id: "config-agents", cmd: "/config-agents", aliases: ["/agents"], category: "agents", label: "Agent definitions", action: "view:personas" },
  { id: "personas", cmd: "/personas", category: "agents", label: "Personas", action: "view:personas" },
  { id: "compact-mode", cmd: "/compact-mode", category: "system", label: "Toggle compact density", action: "toggle:compact-mode" },
  { id: "timestamps", cmd: "/timestamps", category: "system", label: "Toggle timestamps", action: "toggle:timestamps" },
  { id: "btw", cmd: "/btw", category: "session", label: "Side question (BTW)", action: "btw:" },
  { id: "feedback", cmd: "/feedback", category: "system", label: "Send feedback", action: "feedback" },
  { id: "privacy", cmd: "/privacy", category: "system", label: "Privacy", action: "view:settings" },
  { id: "import-claude", cmd: "/import-claude", category: "session", label: "Import Claude session", action: "prompt:/import-claude " },
  { id: "imagine", cmd: "/imagine", category: "media", label: "Generate image", action: "prompt:/imagine" },
  { id: "imagine-video", cmd: "/imagine-video", category: "media", label: "Generate video", action: "prompt:/imagine-video" },
  { id: "login", cmd: "/login", category: "account", label: "Login", action: "prompt:/login" },
  { id: "logout", cmd: "/logout", category: "account", label: "Logout", action: "prompt:/logout" },
  { id: "usage", cmd: "/usage", aliases: ["/cost"], category: "account", label: "Usage", action: "view:settings" },
  { id: "settings", cmd: "/settings", aliases: ["/config", "/preferences", "/prefs"], category: "system", label: "Settings", action: "view:settings" },
  { id: "doctor", cmd: "/doctor", category: "system", label: "Doctor", action: "prompt:/doctor" },
  { id: "release-notes", cmd: "/release-notes", aliases: ["/changelog"], category: "system", label: "Release notes", action: "view:radar" },
  { id: "docs", cmd: "/docs", aliases: ["/howto", "/guides"], category: "system", label: "Docs", action: "view:arch" },
  { id: "tasks", cmd: "/tasks", category: "system", label: "Tasks map", action: "view:tasks" },
  { id: "radar", cmd: "/radar", category: "system", label: "Feature radar", action: "view:radar" },
];

function readJsonSafe(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function listSkillDirs(root, scope) {
  if (!root || !fs.existsSync(root)) return [];
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const skillMd = path.join(root, ent.name, "SKILL.md");
    const skillOff = path.join(root, ent.name, "SKILL.md.off");
    let enabled = true;
    let skillPath = skillMd;
    if (fs.existsSync(skillMd)) {
      enabled = true;
      skillPath = skillMd;
    } else if (fs.existsSync(skillOff)) {
      enabled = false;
      skillPath = skillOff;
    } else {
      continue;
    }
    let description = "";
    let name = ent.name;
    try {
      const raw = fs.readFileSync(skillPath, "utf8");
      const fm = raw.match(/^---\n([\s\S]*?)\n---/);
      if (fm) {
        const n = fm[1].match(/^name:\s*[\"']?([^\"'\n]+)/m);
        const d = fm[1].match(/^description:\s*[>|]?\s*([\s\S]*?)(?=\n[a-zA-Z_]+:|\n*$)/m);
        if (n) name = n[1].trim();
        if (d) description = d[1].replace(/\n/g, " ").replace(/\s+/g, " ").trim().slice(0, 280);
      }
    } catch {
      /* */
    }
    out.push({
      id: ent.name,
      name,
      description,
      path: skillPath,
      dir: path.join(root, ent.name),
      scope,
      enabled,
    });
  }
  return out;
}

function listSkills(cwd) {
  const roots = [
    { dir: path.join(GROK_HOME, "skills"), scope: "user" },
    { dir: path.join(GROK_HOME, "bundled", "skills"), scope: "bundled" },
  ];
  if (cwd) {
    roots.push({ dir: path.join(cwd, ".grok", "skills"), scope: "project" });
    roots.push({ dir: path.join(cwd, ".agents", "skills"), scope: "project" });
  }
  const seen = new Set();
  const all = [];
  for (const r of roots) {
    for (const s of listSkillDirs(r.dir, r.scope)) {
      const key = `${s.scope}:${s.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(s);
    }
  }
  all.sort((a, b) => a.name.localeCompare(b.name));
  return all;
}

function parseTomlMcpServers() {
  const cfgPath = path.join(GROK_HOME, "config.toml");
  if (!fs.existsSync(cfgPath)) return [];
  let text;
  try {
    text = fs.readFileSync(cfgPath, "utf8");
  } catch {
    return [];
  }
  const servers = [];
  const re = /\[mcp_servers\.([^\]]+)\]/g;
  let m;
  while ((m = re.exec(text))) {
    const name = m[1].trim();
    const start = m.index + m[0].length;
    const next = text.slice(start).search(/\n\[/);
    const block = next === -1 ? text.slice(start) : text.slice(start, start + next);
    const url = block.match(/url\s*=\s*["']([^"']+)["']/)?.[1] || null;
    const command = block.match(/command\s*=\s*["']([^"']+)["']/)?.[1] || null;
    const disabled = /enabled\s*=\s*false/.test(block);
    servers.push({
      name,
      url,
      command,
      transport: url ? "http" : command ? "stdio" : "unknown",
      enabled: !disabled,
    });
  }
  return servers;
}

function listModels() {
  const cache = readJsonSafe(path.join(GROK_HOME, "models_cache.json"), {});
  const models = [];
  const raw = cache?.models;
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(cache)
      ? cache
      : raw && typeof raw === "object"
        ? Object.values(raw)
        : [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    // cache shape: { "grok-4.5": { info: { id, name, ... }, ... } }
    const m = entry.info && typeof entry.info === "object" ? entry.info : entry;
    const id = m.id || m.model_id || m.model || m.name;
    if (!id || typeof id !== "string") continue;
    const efforts = Array.isArray(m.reasoning_efforts)
      ? m.reasoning_efforts.map((e) => ({
          id: e.id || e.value,
          label: e.label || e.id || e.value,
          default: Boolean(e.default),
        }))
      : m.supports_reasoning_effort
        ? [
            { id: "high", label: "High", default: true },
            { id: "medium", label: "Medium", default: false },
            { id: "low", label: "Low", default: false },
          ]
        : [];
    models.push({
      id,
      name: m.name || m.display_name || m.system_prompt_label || id,
      description: typeof m.description === "string" ? m.description : "",
      context: m.context_window || m.context || null,
      reasoningEfforts: efforts,
      defaultEffort: efforts.find((e) => e.default)?.id || m.reasoning_effort || null,
    });
  }
  if (models.length === 0) {
    models.push({
      id: "grok-4.5",
      name: "Grok 4.5",
      description: "Default frontier model",
      context: 500000,
      reasoningEfforts: [
        { id: "high", label: "High", default: true },
        { id: "medium", label: "Medium", default: false },
        { id: "low", label: "Low", default: false },
      ],
      defaultEffort: "high",
    });
  }
  return models;
}

function loadPlan(sessionId, cwd) {
  if (!sessionId) return { ok: false, error: "sessionId required" };
  const dir = findSessionDir(sessionId, cwd);
  if (!dir) return { ok: false, error: "session not found", content: null };
  const planPath = path.join(dir, "plan.md");
  const planJsonPath = path.join(dir, "plan.json");
  let content = null;
  let source = null;
  if (fs.existsSync(planPath)) {
    content = fs.readFileSync(planPath, "utf8");
    source = "plan.md";
  } else if (fs.existsSync(planJsonPath)) {
    try {
      const j = JSON.parse(fs.readFileSync(planJsonPath, "utf8"));
      content = typeof j === "string" ? j : JSON.stringify(j, null, 2);
      source = "plan.json";
    } catch {
      content = null;
    }
  }
  return {
    ok: true,
    sessionId,
    cwd: cwd || null,
    path: content ? (source === "plan.md" ? planPath : planJsonPath) : null,
    source,
    content,
    mtime: content && source === "plan.md" ? fs.statSync(planPath).mtime.toISOString() : null,
  };
}

function readVersion() {
  const v = readJsonSafe(path.join(GROK_HOME, "version.json"), {});
  return {
    version: v.version || v.semver || null,
    checkedAt: v.checked_at || v.updated_at || null,
    path: GROK_BIN,
  };
}

function inspectProject(cwd) {
  if (!cwd || !fs.existsSync(cwd)) {
    return { ok: false, error: "cwd missing" };
  }
  const rules = [];
  for (const name of ["AGENTS.md", "Agents.md", "AGENT.md", "CLAUDE.md", "Claude.md", "CLAUDE.local.md"]) {
    const p = path.join(cwd, name);
    if (fs.existsSync(p)) rules.push({ name, path: p, kind: "rules" });
  }
  const grokDir = path.join(cwd, ".grok");
  const modules = [];
  if (fs.existsSync(grokDir)) {
    for (const sub of ["skills", "hooks", "agents", "workflows", "rules"]) {
      const p = path.join(grokDir, sub);
      if (fs.existsSync(p)) {
        let count = 0;
        try {
          count = fs.readdirSync(p).length;
        } catch {
          /* */
        }
        modules.push({ name: sub, path: p, count });
      }
    }
    const cfg = path.join(grokDir, "config.toml");
    if (fs.existsSync(cfg)) modules.push({ name: "config.toml", path: cfg, count: 1 });
  }
  return {
    ok: true,
    cwd,
    rules,
    modules,
    skills: listSkills(cwd).filter((s) => s.scope === "project"),
  };
}

function radarDir() {
  const d = userDataPath("radar");
  fs.mkdirSync(d, { recursive: true });
  fs.mkdirSync(path.join(d, "queue"), { recursive: true });
  return d;
}

function listRadarSnapshots() {
  const dir = radarDir();
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .reverse();
  return files.map((f) => {
    const data = readJsonSafe(path.join(dir, f), {});
    return {
      date: f.replace(/\.json$/, ""),
      path: path.join(dir, f),
      proposalCount: Array.isArray(data.desk_gap_proposals) ? data.desk_gap_proposals.length : 0,
      version: data.local_version || null,
      summary: data.summary || null,
    };
  });
}

function latestRadar() {
  const list = listRadarSnapshots();
  if (!list.length) return null;
  return readJsonSafe(list[0].path, null);
}

function listQueue() {
  const dir = path.join(radarDir(), "queue");
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJsonSafe(path.join(dir, f), null))
    .filter(Boolean)
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
}

function approveProposal(body) {
  const id = body?.id || `prop_${Date.now().toString(36)}`;
  const item = {
    id,
    text: body?.text || body?.proposal || "",
    priority: body?.priority || "P1",
    status: "approved",
    createdAt: new Date().toISOString(),
    source: body?.source || "desk",
  };
  const file = path.join(radarDir(), "queue", `${id}.json`);
  fs.writeFileSync(file, JSON.stringify(item, null, 2));
  return item;
}

function listMemory() {
  const memRoot = path.join(GROK_HOME, "memory");
  const agentMem = path.join(os.homedir(), "AgentMemory");
  const banks = [];

  const pushFile = (scope, name, filePath) => {
    if (!fs.existsSync(filePath)) return;
    try {
      const st = fs.statSync(filePath);
      if (!st.isFile()) return;
      const text = fs.readFileSync(filePath, "utf8");
      banks.push({
        id: `${scope}:${name}`,
        scope,
        name,
        path: filePath,
        bytes: st.size,
        mtime: st.mtime.toISOString(),
        preview: text.slice(0, 4000),
        lines: text.split("\n").length,
      });
    } catch {
      /* */
    }
  };

  pushFile("global", "MEMORY.md", path.join(memRoot, "MEMORY.md"));
  pushFile("global", "AGENTMEMORY.md", path.join(memRoot, "AGENTMEMORY.md"));
  pushFile("agentmemory", "GLOBAL.md", path.join(agentMem, "GLOBAL.md"));
  pushFile("agentmemory", "PROTOCOL.md", path.join(agentMem, "PROTOCOL.md"));

  if (fs.existsSync(memRoot)) {
    try {
      for (const ent of fs.readdirSync(memRoot, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        if (ent.name === "sessions") continue;
        const mem = path.join(memRoot, ent.name, "MEMORY.md");
        pushFile("workspace", ent.name, mem);
      }
    } catch {
      /* */
    }
  }

  const projectsDir = path.join(agentMem, "projects");
  if (fs.existsSync(projectsDir)) {
    try {
      for (const ent of fs.readdirSync(projectsDir, { withFileTypes: true })) {
        if (!ent.isFile() || !ent.name.endsWith(".md")) continue;
        pushFile("projects", ent.name, path.join(projectsDir, ent.name));
      }
    } catch {
      /* */
    }
  }

  banks.sort((a, b) => (b.mtime || "").localeCompare(a.mtime || ""));
  return banks;
}

function readMemoryFile(id) {
  const banks = listMemory();
  const hit = banks.find((b) => b.id === id);
  if (!hit) return { ok: false, error: "not found" };
  try {
    const content = fs.readFileSync(hit.path, "utf8");
    return { ok: true, ...hit, preview: undefined, content };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

function listHooks() {
  const hooks = [];
  const dirs = [
    { scope: "user", dir: path.join(GROK_HOME, "hooks") },
  ];
  for (const { scope, dir } of dirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!ent.isFile() || !ent.name.endsWith(".json")) continue;
        const filePath = path.join(dir, ent.name);
        const raw = readJsonSafe(filePath, null);
        const events = raw?.hooks && typeof raw.hooks === "object" ? Object.keys(raw.hooks) : [];
        let commandCount = 0;
        if (raw?.hooks) {
          for (const arr of Object.values(raw.hooks)) {
            if (!Array.isArray(arr)) continue;
            for (const block of arr) {
              const hs = block?.hooks || [];
              commandCount += Array.isArray(hs) ? hs.length : 0;
            }
          }
        }
        hooks.push({
          id: ent.name.replace(/\.json$/, ""),
          name: ent.name,
          scope,
          path: filePath,
          events,
          commandCount,
          mtime: fs.statSync(filePath).mtime.toISOString(),
        });
      }
    } catch {
      /* */
    }
  }
  return hooks;
}

function readHook(id) {
  const filePath = path.join(GROK_HOME, "hooks", id.endsWith(".json") ? id : `${id}.json`);
  if (!fs.existsSync(filePath)) return { ok: false, error: "not found" };
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(content);
    return { ok: true, id, path: filePath, content, parsed };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

function listMarketplace() {
  const installed = [];
  const registry = readJsonSafe(path.join(GROK_HOME, "installed-plugins", "registry.json"), {});
  const repos = registry?.repos || {};
  for (const [repoId, repo] of Object.entries(repos)) {
    const plugins = repo?.plugins || {};
    for (const [name, info] of Object.entries(plugins)) {
      installed.push({
        id: `${repoId}:${name}`,
        name,
        version: info?.version || null,
        path: repo?.path || null,
        marketplace: repo?.marketplace?.source_display_name || null,
        source: repo?.marketplace?.source_url_or_path || repo?.kind?.url || null,
        installedAt: repo?.installed_at || null,
        status: "installed",
      });
    }
  }

  const catalog = [];
  const cacheRoot = path.join(GROK_HOME, "marketplace-cache");
  if (fs.existsSync(cacheRoot)) {
    try {
      for (const ent of fs.readdirSync(cacheRoot, { withFileTypes: true })) {
        if (!ent.isDirectory() || ent.name.endsWith(".lock")) continue;
        const indexPath = path.join(cacheRoot, ent.name, ".grok-plugin", "plugin-index.json");
        const marketPath = path.join(cacheRoot, ent.name, ".grok-plugin", "marketplace.json");
        const index = readJsonSafe(indexPath, null);
        const market = readJsonSafe(marketPath, null);
        const marketName = market?.name || market?.displayName || ent.name;
        const plugins = index?.plugins || {};
        for (const [name, meta] of Object.entries(plugins)) {
          const components = meta?.components || {};
          catalog.push({
            id: `${ent.name}:${name}`,
            name,
            version: meta?.version || null,
            description:
              meta?.description ||
              components?.skills?.[0]?.description ||
              components?.mcpServers?.[0]?.description ||
              "",
            marketplace: marketName,
            skills: (components?.skills || []).map((s) => s.name).filter(Boolean),
            mcp: (components?.mcpServers || []).map((s) => s.name).filter(Boolean),
            status: installed.some((i) => i.name === name) ? "installed" : "available",
          });
        }
      }
    } catch {
      /* */
    }
  }

  catalog.sort((a, b) => a.name.localeCompare(b.name));
  return { installed, catalog: catalog.slice(0, 200) };
}

function listSubagents(sessionId, cwd) {
  if (!sessionId) return { ok: false, error: "sessionId required", subagents: [] };
  const dir = findSessionDir(sessionId, cwd);
  if (!dir) return { ok: true, subagents: [], sessionId };
  const subDir = path.join(dir, "subagents");
  if (!fs.existsSync(subDir)) return { ok: true, subagents: [], sessionId };
  const out = [];
  try {
    for (const ent of fs.readdirSync(subDir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const metaPath = path.join(subDir, ent.name, "meta.json");
      const meta = readJsonSafe(metaPath, null) || {};
      out.push({
        id: meta.subagent_id || ent.name,
        type: meta.subagent_type || meta.type || "general-purpose",
        description: meta.description || meta.prompt?.slice?.(0, 120) || ent.name,
        status: meta.status || "unknown",
        startedAt: meta.started_at || null,
        completedAt: meta.completed_at || null,
        durationMs: meta.duration_ms || null,
        toolCalls: meta.tool_calls || null,
        turns: meta.turns || null,
        parentSessionId: meta.parent_session_id || sessionId,
      });
    }
  } catch {
    /* */
  }
  out.sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")));
  return { ok: true, sessionId, subagents: out };
}

function doctorStatus() {
  const checks = [];
  const push = (id, ok, detail) => checks.push({ id, ok, detail });
  push("grok_home", fs.existsSync(GROK_HOME), GROK_HOME);
  push("grok_bin", fs.existsSync(GROK_BIN), GROK_BIN);
  push("auth", fs.existsSync(path.join(GROK_HOME, "auth.json")), "auth.json");
  push("config", fs.existsSync(path.join(GROK_HOME, "config.toml")), "config.toml");
  push("sessions", fs.existsSync(path.join(GROK_HOME, "sessions")), "sessions/");
  push("memory", fs.existsSync(path.join(GROK_HOME, "memory", "MEMORY.md")), "memory/MEMORY.md");
  push("agent_memory", fs.existsSync(path.join(os.homedir(), "AgentMemory", "GLOBAL.md")), "~/AgentMemory");
  const ver = readVersion();
  push("version", Boolean(ver.version), ver.version || "unknown");
  const mcp = parseTomlMcpServers();
  push("mcp", mcp.length > 0, `${mcp.length} server(s)`);
  push("worktrees_db", fs.existsSync(path.join(GROK_HOME, "worktrees.db")), "worktrees.db");
  push("radar", fs.existsSync(userDataPath("radar")), "GrokDesk/radar");
  return { ok: checks.every((c) => c.ok), checks, version: ver, mcpCount: mcp.length };
}

function listWorkflowFiles(cwd) {
  const out = [];
  const roots = [
    { scope: "user", dir: path.join(GROK_HOME, "workflows") },
    { scope: "bundled", dir: path.join(GROK_HOME, "bundled", "workflows") },
  ];
  if (cwd) roots.push({ scope: "project", dir: path.join(cwd, ".grok", "workflows") });
  for (const { scope, dir } of roots) {
    if (!fs.existsSync(dir)) continue;
    try {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!ent.isFile()) continue;
        if (!ent.name.endsWith(".rhai") && !ent.name.endsWith(".md")) continue;
        const filePath = path.join(dir, ent.name);
        const st = fs.statSync(filePath);
        let preview = "";
        try {
          preview = fs.readFileSync(filePath, "utf8").slice(0, 400);
        } catch {
          /* */
        }
        out.push({
          id: `${scope}:${ent.name}`,
          name: ent.name.replace(/\.(rhai|md)$/, ""),
          file: ent.name,
          scope,
          path: filePath,
          bytes: st.size,
          mtime: st.mtime.toISOString(),
          preview,
        });
      }
    } catch {
      /* */
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Live / retained workflow runs — scan session workflows/ dirs + recent tool traces.
 */
function listWorkflowRuns({ limit = 40 } = {}) {
  const runs = [];
  const sessionsRoot = path.join(GROK_HOME, "sessions");
  if (!fs.existsSync(sessionsRoot)) return runs;

  const pushRun = (r) => {
    if (!r?.name && !r?.id) return;
    runs.push(r);
  };

  // 1) session/<cwd>/<id>/workflows/*
  try {
    for (const group of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!group.isDirectory()) continue;
      const groupPath = path.join(sessionsRoot, group.name);
      let sessions;
      try {
        sessions = fs.readdirSync(groupPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const s of sessions) {
        if (!s.isDirectory()) continue;
        const sid = s.name;
        const wfDir = path.join(groupPath, sid, "workflows");
        if (!fs.existsSync(wfDir)) continue;
        let entries;
        try {
          entries = fs.readdirSync(wfDir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const ent of entries) {
          const runPath = path.join(wfDir, ent.name);
          let meta = {};
          try {
            const metaPath = path.join(runPath, "meta.json");
            const statusPath = path.join(runPath, "status.json");
            const runJson = path.join(runPath, "run.json");
            if (fs.existsSync(metaPath)) meta = { ...meta, ...JSON.parse(fs.readFileSync(metaPath, "utf8")) };
            if (fs.existsSync(statusPath)) meta = { ...meta, ...JSON.parse(fs.readFileSync(statusPath, "utf8")) };
            if (fs.existsSync(runJson)) meta = { ...meta, ...JSON.parse(fs.readFileSync(runJson, "utf8")) };
          } catch {
            /* */
          }
          let st;
          try {
            st = fs.statSync(ent.isDirectory() ? runPath : runPath);
          } catch {
            st = null;
          }
          const name =
            meta.display_name ||
            meta.displayName ||
            meta.name ||
            meta.meta?.name ||
            ent.name;
          const status =
            meta.status ||
            meta.phase ||
            meta.state ||
            (ent.isDirectory() ? "retained" : "file");
          pushRun({
            id: `${sid}:${ent.name}`,
            name: String(name),
            status: String(status),
            phase: meta.phase || meta.current_phase || null,
            sessionId: sid,
            path: runPath,
            scriptPath: meta.script_path || meta.scriptPath || null,
            mtime: st?.mtime?.toISOString?.() || null,
            source: "disk",
          });
        }
      }
    }
  } catch {
    /* */
  }

  // 2) Recent workflow tool_calls from active-ish session updates (last N sessions by mtime)
  try {
    const candidates = [];
    for (const group of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!group.isDirectory()) continue;
      const groupPath = path.join(sessionsRoot, group.name);
      for (const s of fs.readdirSync(groupPath, { withFileTypes: true })) {
        if (!s.isDirectory()) continue;
        const upd = path.join(groupPath, s.name, "updates.jsonl");
        if (!fs.existsSync(upd)) continue;
        try {
          const st = fs.statSync(upd);
          candidates.push({ sid: s.name, upd, mtime: st.mtimeMs });
        } catch {
          /* */
        }
      }
    }
    candidates.sort((a, b) => b.mtime - a.mtime);
    for (const c of candidates.slice(0, 12)) {
      let lines;
      try {
        // tail ~200 lines
        const raw = fs.readFileSync(c.upd, "utf8");
        lines = raw.trim().split("\n").slice(-200);
      } catch {
        continue;
      }
      for (const line of lines) {
        if (!/workflow/i.test(line)) continue;
        let o;
        try {
          o = JSON.parse(line);
        } catch {
          continue;
        }
        const u = o?.params?.update || o?.update || {};
        const title = String(u.title || "");
        const metaName = u?._meta?.["x.ai/tool"]?.name || "";
        if (metaName !== "workflow" && !/^workflow\b/i.test(title) && title.toLowerCase() !== "workflow") {
          continue;
        }
        const status = String(u.status || "pending").toLowerCase();
        const rawIn = u.rawInput || {};
        const name =
          rawIn.name ||
          rawIn.workflow ||
          (typeof rawIn.script_path === "string"
            ? path.basename(rawIn.script_path, ".rhai")
            : null) ||
          title ||
          "workflow";
        pushRun({
          id: `tool:${u.toolCallId || u.tool_call_id || `${c.sid}:${title}`}`,
          name: String(name).replace(/^workflow\s+/i, "") || "workflow",
          status: status === "completed" ? "completed" : status === "failed" ? "failed" : "running",
          phase: null,
          sessionId: c.sid,
          path: null,
          scriptPath: rawIn.script_path || null,
          mtime: o.timestamp
            ? new Date(typeof o.timestamp === "number" && o.timestamp < 1e12 ? o.timestamp * 1000 : o.timestamp).toISOString()
            : null,
          source: "tool",
          toolCallId: u.toolCallId || u.tool_call_id || null,
        });
      }
    }
  } catch {
    /* */
  }

  // Dedupe by name+session, prefer disk over tool, newer mtime
  const byKey = new Map();
  for (const r of runs) {
    const key = `${r.sessionId || ""}::${String(r.name).toLowerCase()}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, r);
      continue;
    }
    const score = (x) => (x.source === "disk" ? 2 : 0) + (x.mtime ? Date.parse(x.mtime) || 0 : 0);
    if (score(r) >= score(prev)) byKey.set(key, r);
  }
  const out = [...byKey.values()];
  out.sort((a, b) => String(b.mtime || "").localeCompare(String(a.mtime || "")));
  return out.slice(0, limit);
}

async function listWorktrees() {
  // Prefer CLI JSON (tracks live registry); fall back to sqlite
  const cli = await listWorktreesCli();
  if (Array.isArray(cli) && cli.length) {
    return {
      ok: true,
      source: "cli",
      worktrees: cli.map((r) => ({
        id: r.id || r.worktree_id || r.path,
        path: r.path || r.worktree_path,
        sourceRepo: r.source_repo || r.sourceRepo || r.repo || null,
        repoName: r.repo_name || r.repoName || r.name || path.basename(r.path || ""),
        kind: r.kind || "session",
        creationMode: r.creation_mode || r.creationMode || null,
        gitRef: r.git_ref || r.branch || r.gitRef || null,
        headCommit: r.head_commit || r.headCommit || null,
        sessionId: r.session_id || r.sessionId || null,
        createdAt: r.created_at || r.createdAt || null,
        lastAccessedAt: r.last_accessed_at || r.lastAccessedAt || null,
        status: r.status || "alive",
      })),
    };
  }

  const db = path.join(GROK_HOME, "worktrees.db");
  if (!fs.existsSync(db)) return { ok: true, source: "empty", worktrees: [] };
  try {
    const { stdout } = await execFileAsync(
      "sqlite3",
      [
        "-json",
        db,
        `SELECT id, path, source_repo, repo_name, kind, creation_mode, git_ref, head_commit,
                session_id, created_at, last_accessed_at, status
         FROM worktrees ORDER BY COALESCE(last_accessed_at, created_at) DESC LIMIT 100`,
      ],
      { timeout: 5000 },
    );
    const rows = JSON.parse(stdout || "[]");
    return {
      ok: true,
      source: "sqlite",
      worktrees: rows.map((r) => ({
        id: r.id,
        path: r.path,
        sourceRepo: r.source_repo,
        repoName: r.repo_name,
        kind: r.kind,
        creationMode: r.creation_mode,
        gitRef: r.git_ref,
        headCommit: r.head_commit,
        sessionId: r.session_id,
        createdAt: r.created_at ? new Date(Number(r.created_at)).toISOString() : null,
        lastAccessedAt: r.last_accessed_at
          ? new Date(Number(r.last_accessed_at)).toISOString()
          : null,
        status: r.status,
      })),
    };
  } catch (e) {
    return { ok: false, error: e.message || String(e), worktrees: [] };
  }
}

async function usageSnapshot(sessionId, cwd) {
  const authPath = path.join(GROK_HOME, "auth.json");
  let auth = { present: false, method: null };
  try {
    if (fs.existsSync(authPath)) {
      const raw = JSON.parse(fs.readFileSync(authPath, "utf8"));
      auth = {
        present: true,
        method: raw.auth_method || raw.method || (raw.access_token || raw.token ? "session" : "unknown"),
        // never expose tokens
        hasToken: Boolean(raw.access_token || raw.token || raw.session_token),
      };
    }
  } catch {
    auth = { present: fs.existsSync(authPath), method: "unreadable" };
  }
  const models = listModels();
  const ver = readVersion();
  const account = await probeAccountCredits();
  const sessionUsage = sessionId ? collectSessionUsage(sessionId, cwd) : null;
  return {
    ok: true,
    version: ver,
    auth,
    modelCount: models.length,
    models: models.map((m) => ({ id: m.id, name: m.name })),
    account,
    sessionUsage,
    note:
      account?.note ||
      "SuperGrok quota is account-side — no local remaining balance file.",
  };
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {(res, status, body) => void} sendJson
 * @param {(req) => Promise<any>} readBody
 */
export async function handleBuildApi(req, res, sendJson, readBody) {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (!url.pathname.startsWith("/api/build")) return false;

  if (url.pathname === "/api/build/health" && req.method === "GET") {
    sendJson(res, 200, {
      ok: true,
      surface: "grok-build-visual",
      version: readVersion(),
      slashCount: SLASH_REGISTRY.length,
    });
    return true;
  }

  if (url.pathname === "/api/build/slash" && req.method === "GET") {
    sendJson(res, 200, { ok: true, commands: SLASH_REGISTRY });
    return true;
  }

  if (url.pathname === "/api/build/skills" && req.method === "GET") {
    const cwd = url.searchParams.get("cwd") || null;
    sendJson(res, 200, { ok: true, skills: listSkills(cwd) });
    return true;
  }

  if (url.pathname === "/api/build/models" && req.method === "GET") {
    sendJson(res, 200, { ok: true, models: listModels(), version: readVersion() });
    return true;
  }

  if (url.pathname === "/api/build/plan" && req.method === "GET") {
    const sessionId = url.searchParams.get("sessionId") || url.searchParams.get("id");
    const cwd = url.searchParams.get("cwd") || null;
    sendJson(res, 200, loadPlan(sessionId, cwd));
    return true;
  }

  if (url.pathname === "/api/build/inspect" && req.method === "GET") {
    const cwd = url.searchParams.get("cwd") || null;
    sendJson(res, 200, inspectProject(cwd));
    return true;
  }

  if (url.pathname === "/api/build/radar" && req.method === "GET") {
    sendJson(res, 200, {
      ok: true,
      latest: latestRadar(),
      snapshots: listRadarSnapshots().slice(0, 14),
      queue: listQueue(),
      version: readVersion(),
    });
    return true;
  }

  if (url.pathname === "/api/build/radar/approve" && req.method === "POST") {
    const body = await readBody(req).catch(() => ({}));
    const item = approveProposal(body);
    sendJson(res, 200, { ok: true, item });
    return true;
  }

  if (url.pathname === "/api/build/radar/run" && req.method === "POST") {
    const scanner = path.join(__dirname, "..", "radar", "scanner.mjs");
    try {
      const { stdout } = await execFileAsync(process.execPath, [scanner], {
        timeout: 120_000,
        env: { ...process.env, GROK_HOME },
      });
      sendJson(res, 200, { ok: true, output: stdout?.slice(-2000) || "ok", latest: latestRadar() });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message || String(e) });
    }
    return true;
  }

  if (url.pathname === "/api/build/version" && req.method === "GET") {
    sendJson(res, 200, { ok: true, ...readVersion(), grokHome: GROK_HOME });
    return true;
  }

  if (url.pathname === "/api/build/memory" && req.method === "GET") {
    const id = url.searchParams.get("id");
    if (id) {
      sendJson(res, 200, readMemoryFile(id));
      return true;
    }
    sendJson(res, 200, { ok: true, banks: listMemory() });
    return true;
  }

  if (url.pathname === "/api/build/hooks" && req.method === "GET") {
    const id = url.searchParams.get("id");
    if (id) {
      sendJson(res, 200, readHook(id));
      return true;
    }
    sendJson(res, 200, { ok: true, hooks: listHooks() });
    return true;
  }

  if (url.pathname === "/api/build/marketplace" && req.method === "GET") {
    sendJson(res, 200, { ok: true, ...listMarketplace() });
    return true;
  }

  if (url.pathname === "/api/build/subagents" && req.method === "GET") {
    const sessionId = url.searchParams.get("sessionId") || url.searchParams.get("id");
    const cwd = url.searchParams.get("cwd") || null;
    sendJson(res, 200, listSubagents(sessionId, cwd));
    return true;
  }

  if (url.pathname === "/api/build/doctor" && req.method === "GET") {
    sendJson(res, 200, doctorStatus());
    return true;
  }

  if (url.pathname === "/api/build/radar/digest" && req.method === "POST") {
    const digest = path.join(__dirname, "..", "radar", "digest.mjs");
    const body = await readBody(req).catch(() => ({}));
    const args = [digest];
    // Default dry-run; only send when body.send === true
    const dry = body?.send !== true;
    if (dry) args.push("--dry");
    try {
      const { stdout } = await execFileAsync(process.execPath, args, {
        timeout: 60_000,
        env: { ...process.env, GROK_HOME },
      });
      sendJson(res, 200, { ok: true, dry, output: stdout?.slice(-4000) || "ok" });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message || String(e) });
    }
    return true;
  }

  if (url.pathname === "/api/build/workflows" && req.method === "GET") {
    const cwd = url.searchParams.get("cwd") || null;
    sendJson(res, 200, {
      ok: true,
      workflows: listWorkflowFiles(cwd),
      runs: listWorkflowRuns({ limit: 50 }),
    });
    return true;
  }

  if (url.pathname === "/api/build/worktrees" && req.method === "GET") {
    sendJson(res, 200, await listWorktrees());
    return true;
  }

  if (url.pathname === "/api/build/worktrees" && req.method === "POST") {
    try {
      const body = await readBody(req).catch(() => ({}));
      const action = String(body.action || "create");
      if (action === "create") {
        const result = await createWorktree({
          sourceRepo: body.sourceRepo || body.cwd,
          name: body.name,
          ref: body.ref,
          branch: body.branch,
        });
        sendJson(res, 200, result);
        return true;
      }
      if (action === "rm" || action === "discard") {
        const result = await removeWorktree(body.id || body.worktreeId, {
          force: body.force !== false,
        });
        sendJson(res, 200, result);
        return true;
      }
      if (action === "gc") {
        sendJson(res, 200, await gcWorktrees());
        return true;
      }
      if (action === "merge") {
        const result = await mergeWorktree({
          sourceRepo: body.sourceRepo,
          worktreePath: body.path || body.worktreePath,
          targetBranch: body.targetBranch || "main",
          force: Boolean(body.force),
        });
        sendJson(res, 200, result);
        return true;
      }
      sendJson(res, 400, { ok: false, error: `unknown action ${action}` });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message || String(e) });
    }
    return true;
  }

  if (url.pathname === "/api/build/usage" && req.method === "GET") {
    const sessionId = url.searchParams.get("sessionId") || null;
    const cwd = url.searchParams.get("cwd") || null;
    sendJson(res, 200, await usageSnapshot(sessionId, cwd));
    return true;
  }

  // --- Session power (parity Sprint A) ---
  if (url.pathname === "/api/build/session-info" && req.method === "GET") {
    const sessionId = url.searchParams.get("sessionId") || url.searchParams.get("id");
    const cwd = url.searchParams.get("cwd") || null;
    sendJson(res, 200, getSessionInfo(sessionId, cwd));
    return true;
  }

  if (url.pathname === "/api/build/rewind" && req.method === "GET") {
    const sessionId = url.searchParams.get("sessionId") || url.searchParams.get("id");
    const cwd = url.searchParams.get("cwd") || null;
    sendJson(res, 200, listRewindPoints(sessionId, cwd));
    return true;
  }

  if (url.pathname === "/api/build/history" && req.method === "GET") {
    const sessionId = url.searchParams.get("sessionId") || url.searchParams.get("id");
    const cwd = url.searchParams.get("cwd") || null;
    const limit = Number(url.searchParams.get("limit") || 50);
    sendJson(res, 200, listPromptHistory(sessionId, cwd, limit));
    return true;
  }

  if (url.pathname === "/api/build/session-rename" && req.method === "POST") {
    try {
      const body = await readBody(req).catch(() => ({}));
      const sessionId = body.sessionId || body.id;
      const title = String(body.title || "").trim();
      if (!sessionId || !title) {
        sendJson(res, 400, { ok: false, error: "sessionId and title required" });
        return true;
      }
      const t = setDeskTitle(sessionId, title, { force: true });
      sendJson(res, 200, { ok: true, sessionId, title: t || title });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message || String(e) });
    }
    return true;
  }

  if (url.pathname === "/api/build/session-delete" && req.method === "POST") {
    try {
      const body = await readBody(req).catch(() => ({}));
      const sessionId = body.sessionId || body.id;
      const cwd = body.cwd || null;
      if (!sessionId) {
        sendJson(res, 400, { ok: false, error: "sessionId required" });
        return true;
      }
      sendJson(res, 200, deleteSession(sessionId, cwd));
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message || String(e) });
    }
    return true;
  }

  // --- Extensions (Sprint C): MCP / plugins / agents / personas / skills ---
  if (url.pathname === "/api/build/mcp" && req.method === "GET") {
    try {
      const servers = await cliExt.mcpList();
      sendJson(res, 200, { ok: true, servers });
    } catch (e) {
      // fall back to toml parse already in parseTomlMcpServers
      sendJson(res, 200, { ok: true, servers: parseTomlMcpServers(), fallback: true });
    }
    return true;
  }

  if (url.pathname === "/api/build/mcp" && req.method === "POST") {
    try {
      const body = await readBody(req).catch(() => ({}));
      const action = String(body.action || "");
      const name = body.name;
      if (action === "enable") sendJson(res, 200, await cliExt.mcpEnable(name));
      else if (action === "disable") sendJson(res, 200, await cliExt.mcpDisable(name));
      else if (action === "remove") sendJson(res, 200, await cliExt.mcpRemove(name));
      else if (action === "add") sendJson(res, 200, await cliExt.mcpAdd(body));
      else if (action === "doctor") sendJson(res, 200, await cliExt.mcpDoctor());
      else sendJson(res, 400, { ok: false, error: "unknown action" });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message || String(e) });
    }
    return true;
  }

  if (url.pathname === "/api/build/plugins" && req.method === "GET") {
    try {
      const available = url.searchParams.get("available") === "1";
      const plugins = await cliExt.pluginList({ available });
      sendJson(res, 200, { ok: true, plugins });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message || String(e), plugins: [] });
    }
    return true;
  }

  if (url.pathname === "/api/build/plugins" && req.method === "POST") {
    try {
      const body = await readBody(req).catch(() => ({}));
      const action = String(body.action || "");
      if (action === "install") sendJson(res, 200, await cliExt.pluginInstall(body.source, { trust: body.trust !== false }));
      else if (action === "uninstall") sendJson(res, 200, await cliExt.pluginUninstall(body.name));
      else if (action === "update") sendJson(res, 200, await cliExt.pluginUpdate(body.name));
      else if (action === "enable") sendJson(res, 200, await cliExt.pluginEnable(body.name));
      else if (action === "disable") sendJson(res, 200, await cliExt.pluginDisable(body.name));
      else sendJson(res, 400, { ok: false, error: "unknown action" });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message || String(e) });
    }
    return true;
  }

  if (url.pathname === "/api/build/agents" && req.method === "GET") {
    const cwd = url.searchParams.get("cwd") || null;
    sendJson(res, 200, {
      ok: true,
      agents: cliExt.listAgents(cwd),
      personas: cliExt.listPersonas(cwd),
    });
    return true;
  }

  if (url.pathname === "/api/build/skills" && req.method === "POST") {
    try {
      const body = await readBody(req).catch(() => ({}));
      const action = String(body.action || "create");
      if (action === "create") {
        sendJson(res, 200, cliExt.createSkill(body));
      } else if (action === "enable" || action === "disable") {
        sendJson(res, 200, cliExt.setSkillEnabled(body.id || body.path, action === "enable"));
      } else {
        sendJson(res, 400, { ok: false, error: "unknown action" });
      }
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message || String(e) });
    }
    return true;
  }

  /** Soft rewind: return point meta + instruct client to truncate UI; file restore later */
  if (url.pathname === "/api/build/rewind" && req.method === "POST") {
    try {
      const body = await readBody(req).catch(() => ({}));
      const sessionId = body.sessionId || body.id;
      const promptIndex = Number(body.promptIndex);
      const cwd = body.cwd || null;
      const listed = listRewindPoints(sessionId, cwd);
      if (!listed.ok) {
        sendJson(res, 404, listed);
        return true;
      }
      const point = listed.points.find((p) => p.promptIndex === promptIndex);
      if (!point) {
        sendJson(res, 404, { ok: false, error: "rewind point not found" });
        return true;
      }
      // Truncate chat_history is dangerous mid-ACP; client clears UI + sends /rewind
      sendJson(res, 200, {
        ok: true,
        sessionId,
        promptIndex,
        point,
        action: "client_rewind",
        hint: "Desk will clear local transcript after this index and send /rewind to the agent when attached.",
      });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message || String(e) });
    }
    return true;
  }

  /** Safe file preview — path must stay under cwd or home (no escapes) */
  if (url.pathname === "/api/build/file" && req.method === "GET") {
    const filePath = url.searchParams.get("path");
    const cwd = url.searchParams.get("cwd") || os.homedir();
    if (!filePath) {
      sendJson(res, 400, { ok: false, error: "path required" });
      return true;
    }
    try {
      const resolved = path.resolve(filePath.startsWith("/") ? filePath : path.join(cwd, filePath));
      const home = os.homedir();
      const allowedRoots = [path.resolve(cwd), home, path.join(home, "Documents"), path.join(home, ".grok")];
      const okRoot = allowedRoots.some((r) => resolved === r || resolved.startsWith(r + path.sep));
      if (!okRoot) {
        sendJson(res, 403, { ok: false, error: "path outside allowed roots" });
        return true;
      }
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        sendJson(res, 404, { ok: false, error: "not found" });
        return true;
      }
      const st = fs.statSync(resolved);
      if (st.size > 512_000) {
        sendJson(res, 200, {
          ok: true,
          path: resolved,
          truncated: true,
          content: fs.readFileSync(resolved, "utf8").slice(0, 400_000) + "\n…[truncated]",
          bytes: st.size,
        });
        return true;
      }
      sendJson(res, 200, {
        ok: true,
        path: resolved,
        content: fs.readFileSync(resolved, "utf8"),
        bytes: st.size,
        truncated: false,
      });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message || String(e) });
    }
    return true;
  }

  sendJson(res, 404, { ok: false, error: "unknown build route" });
  return true;
}
