/**
 * Worktree operations — CLI + git wrappers for Desk UI.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const execFileAsync = promisify(execFile);
const GROK_HOME = process.env.GROK_HOME || path.join(os.homedir(), ".grok");
const GROK_BIN = process.env.GROK_BIN || path.join(GROK_HOME, "bin", "grok");

async function run(cmd, args, opts = {}) {
  const { stdout, stderr } = await execFileAsync(cmd, args, {
    timeout: opts.timeout || 60_000,
    maxBuffer: 4 * 1024 * 1024,
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env || {}) },
  });
  return { stdout: (stdout || "").trim(), stderr: (stderr || "").trim() };
}

export async function listWorktreesCli() {
  try {
    const { stdout } = await run(GROK_BIN, ["worktree", "list", "--json", "--all"], {
      timeout: 15_000,
    });
    if (!stdout) return [];
    const data = JSON.parse(stdout);
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.worktrees)) return data.worktrees;
    return [];
  } catch {
    return null; // fall back to sqlite in caller
  }
}

export async function removeWorktree(id, { force = true } = {}) {
  if (!id) throw new Error("id required");
  const args = ["worktree", "rm", String(id)];
  if (force) args.push("-f");
  const { stdout, stderr } = await run(GROK_BIN, args, { timeout: 60_000 });
  return { ok: true, stdout, stderr };
}

export async function gcWorktrees() {
  const { stdout, stderr } = await run(GROK_BIN, ["worktree", "gc"], { timeout: 60_000 });
  return { ok: true, stdout, stderr };
}

/**
 * Create a git worktree under sibling dir.
 * @param {{ sourceRepo: string, name?: string, ref?: string, branch?: string }} opts
 */
export async function createWorktree(opts) {
  const sourceRepo = path.resolve(opts.sourceRepo || "");
  if (!sourceRepo || !fs.existsSync(sourceRepo)) {
    throw new Error("sourceRepo missing or not found");
  }
  // must be a git repo
  try {
    await run("git", ["-C", sourceRepo, "rev-parse", "--is-inside-work-tree"]);
  } catch {
    throw new Error("sourceRepo is not a git repository");
  }

  const name =
    (opts.name || `desk-${Date.now().toString(36)}`).replace(/[^a-zA-Z0-9._-]/g, "-");
  const parent = path.dirname(sourceRepo);
  const base = path.basename(sourceRepo);
  const dest = path.join(parent, `${base}-wt-${name}`);
  if (fs.existsSync(dest)) throw new Error(`path already exists: ${dest}`);

  const ref = opts.ref || opts.branch || "HEAD";
  const branch = opts.branch || `desk/${name}`;

  // Create new branch from ref and attach worktree
  try {
    await run("git", ["-C", sourceRepo, "worktree", "add", "-b", branch, dest, ref]);
  } catch (e) {
    // branch may exist — try without -b
    try {
      await run("git", ["-C", sourceRepo, "worktree", "add", dest, branch]);
    } catch (e2) {
      throw new Error(e2.message || e.message || String(e2));
    }
  }

  return {
    ok: true,
    path: dest,
    sourceRepo,
    branch,
    ref,
    name,
  };
}

/**
 * Merge worktree branch into target branch of source repo.
 */
export async function mergeWorktree({ sourceRepo, worktreePath, targetBranch = "main", force = false }) {
  const src = path.resolve(sourceRepo);
  const wt = path.resolve(worktreePath);
  if (!fs.existsSync(src) || !fs.existsSync(wt)) {
    throw new Error("sourceRepo or worktreePath missing");
  }

  // current branch of worktree
  const { stdout: branch } = await run("git", ["-C", wt, "rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch || branch === "HEAD") throw new Error("worktree has detached HEAD");

  // dirty check
  const { stdout: status } = await run("git", ["-C", wt, "status", "--porcelain"]);
  if (status && !force) {
    throw new Error("worktree has uncommitted changes — commit first or pass force");
  }

  // ensure target exists
  await run("git", ["-C", src, "fetch", "--all", "--prune"]).catch(() => {});
  // checkout target in source (main worktree)
  const { stdout: cur } = await run("git", ["-C", src, "rev-parse", "--abbrev-ref", "HEAD"]);
  if (cur !== targetBranch) {
    await run("git", ["-C", src, "checkout", targetBranch]);
  }
  await run("git", ["-C", src, "merge", "--no-edit", branch]);
  return { ok: true, mergedBranch: branch, targetBranch, sourceRepo: src };
}

export async function showWorktree(id) {
  try {
    const { stdout } = await run(GROK_BIN, ["worktree", "show", String(id), "--json"], {
      timeout: 10_000,
    });
    return stdout ? JSON.parse(stdout) : null;
  } catch {
    return null;
  }
}
