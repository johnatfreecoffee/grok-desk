/**
 * Thin wrappers around `grok mcp` / `grok plugin` CLI for Desk APIs.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const execFileAsync = promisify(execFile);
const GROK_HOME = process.env.GROK_HOME || path.join(os.homedir(), ".grok");
const GROK_BIN = process.env.GROK_BIN || path.join(GROK_HOME, "bin", "grok");

async function grok(args, opts = {}) {
  const { stdout, stderr } = await execFileAsync(GROK_BIN, args, {
    timeout: opts.timeout || 120_000,
    maxBuffer: 8 * 1024 * 1024,
    cwd: opts.cwd || process.cwd(),
    env: { ...process.env },
  });
  return { stdout: (stdout || "").trim(), stderr: (stderr || "").trim() };
}

function parseJson(stdout, fallback = null) {
  if (!stdout) return fallback;
  try {
    return JSON.parse(stdout);
  } catch {
    return fallback;
  }
}

export async function mcpList() {
  const { stdout } = await grok(["mcp", "list", "--json"], { timeout: 30_000 });
  const data = parseJson(stdout, []);
  return Array.isArray(data) ? data : data?.servers || [];
}

export async function mcpEnable(name) {
  await grok(["mcp", "enable", name], { timeout: 30_000 });
  return { ok: true, name, enabled: true };
}

export async function mcpDisable(name) {
  await grok(["mcp", "disable", name], { timeout: 30_000 });
  return { ok: true, name, enabled: false };
}

export async function mcpRemove(name) {
  await grok(["mcp", "remove", name], { timeout: 30_000 });
  return { ok: true, name, removed: true };
}

/**
 * @param {{ name: string, url?: string, command?: string, transport?: string, scope?: string, args?: string[] }} opts
 */
export async function mcpAdd(opts) {
  const name = opts.name;
  if (!name) throw new Error("name required");
  const target = opts.url || opts.command;
  if (!target) throw new Error("url or command required");
  const args = ["mcp", "add", name, target];
  if (opts.transport) args.push("-t", opts.transport);
  else if (opts.url) args.push("-t", "http");
  if (opts.scope) args.push("-s", opts.scope);
  if (Array.isArray(opts.args) && opts.args.length) {
    args.push("--", ...opts.args);
  }
  const { stdout, stderr } = await grok(args, { timeout: 60_000 });
  return { ok: true, name, stdout, stderr };
}

export async function mcpDoctor() {
  try {
    const { stdout, stderr } = await grok(["mcp", "doctor"], { timeout: 60_000 });
    return { ok: true, output: stdout || stderr };
  } catch (e) {
    return { ok: false, error: e.message || String(e), output: e.stdout || e.stderr || "" };
  }
}

export async function pluginList({ available = false } = {}) {
  const args = ["plugin", "list", "--json"];
  if (available) args.push("--available");
  const { stdout } = await grok(args, { timeout: 60_000 });
  const data = parseJson(stdout, []);
  return Array.isArray(data) ? data : data?.plugins || [];
}

export async function pluginInstall(source, { trust = true } = {}) {
  if (!source) throw new Error("source required");
  const args = ["plugin", "install", source];
  if (trust) args.push("--trust");
  const { stdout, stderr } = await grok(args, { timeout: 180_000 });
  return { ok: true, source, stdout, stderr };
}

export async function pluginUninstall(name) {
  await grok(["plugin", "uninstall", name], { timeout: 60_000 });
  return { ok: true, name, uninstalled: true };
}

export async function pluginUpdate(name) {
  const args = name ? ["plugin", "update", name] : ["plugin", "update"];
  const { stdout, stderr } = await grok(args, { timeout: 180_000 });
  return { ok: true, name: name || "all", stdout, stderr };
}

export async function pluginEnable(name) {
  await grok(["plugin", "enable", name], { timeout: 30_000 });
  return { ok: true, name, enabled: true };
}

export async function pluginDisable(name) {
  await grok(["plugin", "disable", name], { timeout: 30_000 });
  return { ok: true, name, enabled: false };
}

function parseAgentMd(filePath, scope) {
  const raw = fs.readFileSync(filePath, "utf8");
  let name = path.basename(filePath).replace(/\.(md|toml)$/, "");
  let description = "";
  const fm = raw.match(/^---\n([\s\S]*?)\n---/);
  if (fm) {
    const n = fm[1].match(/^name:\s*[\"']?([^\"'\n]+)/m);
    const d = fm[1].match(/^description:\s*[>|]?\s*([\s\S]*?)(?=\n[a-zA-Z_]+:|\n*$)/m);
    if (n) name = n[1].trim();
    if (d) description = d[1].replace(/\n/g, " ").replace(/\s+/g, " ").trim().slice(0, 280);
  } else if (filePath.endsWith(".toml")) {
    const n = raw.match(/^#\s*(.+)$/m) || raw.match(/description\s*=\s*"([^"]+)"/);
    if (n) description = n[1].slice(0, 280);
  }
  return {
    id: `${scope}:${path.basename(filePath)}`,
    name,
    description,
    path: filePath,
    scope,
    kind: filePath.endsWith(".toml") ? "toml" : "md",
  };
}

function parsePersonaToml(filePath, scope) {
  const raw = fs.readFileSync(filePath, "utf8");
  const name = path.basename(filePath).replace(/\.toml$/, "");
  const d = raw.match(/description\s*=\s*"([^"]+)"/) || raw.match(/^#\s*(.+)$/m);
  return {
    id: `${scope}:${name}`,
    name,
    description: d ? d[1].slice(0, 280) : "",
    path: filePath,
    scope,
  };
}

export function listAgents(cwd) {
  const out = [];
  const roots = [
    { scope: "bundled", dir: path.join(GROK_HOME, "bundled", "agents") },
    { scope: "user", dir: path.join(GROK_HOME, "agents") },
  ];
  if (cwd) roots.push({ scope: "project", dir: path.join(cwd, ".grok", "agents") });
  for (const { scope, dir } of roots) {
    if (!fs.existsSync(dir)) continue;
    try {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!ent.isFile()) continue;
        if (!/\.(md|toml)$/.test(ent.name)) continue;
        out.push(parseAgentMd(path.join(dir, ent.name), scope));
      }
    } catch {
      /* */
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export function listPersonas(cwd) {
  const out = [];
  const roots = [
    { scope: "bundled", dir: path.join(GROK_HOME, "bundled", "personas") },
    { scope: "user", dir: path.join(GROK_HOME, "personas") },
  ];
  if (cwd) roots.push({ scope: "project", dir: path.join(cwd, ".grok", "personas") });
  // also config.toml [subagents.personas.*] — skip deep parse; files first
  for (const { scope, dir } of roots) {
    if (!fs.existsSync(dir)) continue;
    try {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!ent.isFile() || !ent.name.endsWith(".toml")) continue;
        out.push(parsePersonaToml(path.join(dir, ent.name), scope));
      }
    } catch {
      /* */
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Create a minimal user skill SKILL.md
 */
export function createSkill({ name, description, body }) {
  const id = String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-|-$/g, "");
  if (!id) throw new Error("name required");
  const dir = path.join(GROK_HOME, "skills", id);
  fs.mkdirSync(dir, { recursive: true });
  const skillPath = path.join(dir, "SKILL.md");
  if (fs.existsSync(skillPath)) throw new Error(`skill already exists: ${id}`);
  const md = `---
name: ${id}
description: >
  ${String(description || "User skill").replace(/\n/g, " ")}
---

${body || `# ${id}\n\nDescribe what this skill should do.\n`}
`;
  fs.writeFileSync(skillPath, md);
  return { ok: true, id, path: skillPath };
}

/** Soft-disable skill by renaming SKILL.md → SKILL.md.off */
export function setSkillEnabled(skillDirOrId, enabled) {
  let dir = skillDirOrId;
  if (!dir.includes(path.sep)) {
    // search
    for (const root of [
      path.join(GROK_HOME, "skills"),
      path.join(GROK_HOME, "bundled", "skills"),
    ]) {
      const cand = path.join(root, skillDirOrId);
      if (fs.existsSync(cand)) {
        dir = cand;
        break;
      }
    }
  }
  const on = path.join(dir, "SKILL.md");
  const off = path.join(dir, "SKILL.md.off");
  if (enabled) {
    if (fs.existsSync(off) && !fs.existsSync(on)) fs.renameSync(off, on);
    else if (!fs.existsSync(on)) throw new Error("skill not found");
  } else {
    if (fs.existsSync(on)) fs.renameSync(on, off);
    else throw new Error("skill not found or already off");
  }
  return { ok: true, path: dir, enabled };
}
