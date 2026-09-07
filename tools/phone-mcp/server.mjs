import { randomUUID, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

const HOME = os.homedir();
const GROK_BIN = process.env.GROK_BIN || path.join(HOME, ".grok/bin/grok");
const SESSIONS_ROOT = path.join(HOME, ".grok/sessions");
const STATE_DIR = path.join(HOME, ".grok/phone-mcp");
const JOBS_DIR = path.join(STATE_DIR, "jobs");
const PORT = Number(process.env.GROK_MCP_PORT || 3311);
const TOKEN = (process.env.GROK_MCP_TOKEN || "").trim();
const ALLOW_AUTO = process.env.GROK_MCP_ALLOW_AUTO === "1";
const ROOTS = (process.env.GROK_MCP_ROOTS || path.join(HOME, "Documents"))
  .split(":")
  .map((p) => p.trim())
  .filter(Boolean);

if (!TOKEN || TOKEN.length < 16) {
  console.error("GROK_MCP_TOKEN missing or too short. Refusing to start.");
  process.exit(1);
}

const tokenBuf = Buffer.from(TOKEN);

function tokensEqual(a) {
  const b = Buffer.from(String(a || ""));
  if (b.length !== tokenBuf.length) return false;
  return timingSafeEqual(b, tokenBuf);
}

function tokenFromReq(req) {
  const auth = String(req.headers.authorization || "");
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  if (req.headers["x-api-key"]) return String(req.headers["x-api-key"]).trim();
  if (req.query?.token) return String(req.query.token).trim();
  const m = String(req.path || "").match(/^\/t\/([^/]+)\//);
  if (m) return decodeURIComponent(m[1]);
  return "";
}

function json(res, code, body) {
  res.status(code).json(body);
}

async function ensureDirs() {
  await mkdir(JOBS_DIR, { recursive: true });
}

function textResult(obj) {
  const text = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
  return { content: [{ type: "text", text }] };
}

function errResult(message) {
  return { isError: true, content: [{ type: "text", text: message }] };
}

async function resolvedRoots() {
  const out = [];
  for (const r of ROOTS) {
    try {
      out.push(await realpath(r));
    } catch {
      // skip missing roots
    }
  }
  return out;
}

async function assertCwd(cwd) {
  if (!cwd || typeof cwd !== "string") throw new Error("cwd is required");
  const abs = path.resolve(cwd);
  const real = await realpath(abs).catch(() => abs);
  const roots = await resolvedRoots();
  const ok = roots.some((r) => real === r || real.startsWith(r + path.sep));
  if (!ok) {
    throw new Error(`cwd must be inside GROK_MCP_ROOTS (${ROOTS.join(", ")})`);
  }
  return real;
}

function skipSessionPath(p) {
  return /worktrees|subagent-/i.test(p);
}

async function loadSummaries({ query = "", limit = 15 } = {}) {
  const items = [];
  let groups = [];
  try {
    groups = await readdir(SESSIONS_ROOT, { withFileTypes: true });
  } catch {
    return [];
  }
  const q = query.trim().toLowerCase();
  for (const g of groups) {
    if (!g.isDirectory()) continue;
    if (skipSessionPath(g.name)) continue;
    const gpath = path.join(SESSIONS_ROOT, g.name);
    let sessions = [];
    try {
      sessions = await readdir(gpath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const s of sessions) {
      if (!s.isDirectory()) continue;
      const dir = path.join(gpath, s.name);
      if (skipSessionPath(dir)) continue;
      const sumPath = path.join(dir, "summary.json");
      try {
        const d = JSON.parse(await readFile(sumPath, "utf8"));
        const cwd = d?.info?.cwd || decodeURIComponent(g.name);
        const title = d.generated_title || d.session_summary || "(no title)";
        const summary = d.session_summary || "";
        const hay = `${title} ${summary} ${cwd} ${s.name}`.toLowerCase();
        if (q && !hay.includes(q)) continue;
        items.push({
          id: d?.info?.id || s.name,
          title,
          summary,
          cwd,
          model: d.current_model_id || null,
          created_at: d.created_at || null,
          last_active_at: d.last_active_at || d.updated_at || null,
          num_messages: d.num_messages || 0,
          agent_name: d.agent_name || null,
        });
      } catch {
        // ignore unreadable summaries
      }
    }
  }
  items.sort((a, b) => String(b.last_active_at || "").localeCompare(String(a.last_active_at || "")));
  return items.slice(0, Math.max(1, Math.min(Number(limit) || 15, 50)));
}

async function loadSession(id) {
  const matches = [];
  let groups = [];
  try {
    groups = await readdir(SESSIONS_ROOT, { withFileTypes: true });
  } catch {
    throw new Error("no sessions directory");
  }
  for (const g of groups) {
    if (!g.isDirectory()) continue;
    const dir = path.join(SESSIONS_ROOT, g.name, id);
    try {
      const d = JSON.parse(await readFile(path.join(dir, "summary.json"), "utf8"));
      matches.push({ dir, d });
    } catch {
      // not here
    }
  }
  if (!matches.length) throw new Error(`session not found: ${id}`);
  matches.sort((a, b) =>
    String(b.d.last_active_at || b.d.updated_at || "").localeCompare(
      String(a.d.last_active_at || a.d.updated_at || "")
    )
  );
  const { dir, d } = matches[0];
  return {
    id: d?.info?.id || id,
    title: d.generated_title || d.session_summary || "(no title)",
    summary: d.session_summary || "",
    cwd: d?.info?.cwd || null,
    model: d.current_model_id || null,
    created_at: d.created_at || null,
    last_active_at: d.last_active_at || d.updated_at || null,
    num_messages: d.num_messages || 0,
    agent_name: d.agent_name || null,
    git_root_dir: d.git_root_dir || null,
    head_branch: d.head_branch || null,
    dir,
  };
}

function tailText(buf, max = 8000) {
  const s = buf.toString("utf8");
  return s.length <= max ? s : s.slice(s.length - max);
}

function extractAssistantText(log) {
  const lines = log.split("\n");
  const chunks = [];
  for (const line of lines) {
    if (!line.startsWith("{")) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.type === "text" && typeof ev.data === "string") chunks.push(ev.data);
      else if (ev.type === "assistant" && typeof ev.data === "string") chunks.push(ev.data);
      else if (typeof ev.text === "string") chunks.push(ev.text);
    } catch {
      // ignore
    }
  }
  const text = chunks.join("");
  if (text.trim()) return text.length > 6000 ? `${text.slice(0, 2500)}\n…\n${text.slice(-2500)}` : text;
  return tailText(Buffer.from(log), 4000);
}

async function startGrok({ prompt, cwd, resumeId, maxTurns, model }) {
  const jobId = randomUUID();
  const sessionId = resumeId || randomUUID();
  const promptPath = path.join(JOBS_DIR, `${jobId}.prompt.txt`);
  const logPath = path.join(JOBS_DIR, `${jobId}.log`);
  const metaPath = path.join(JOBS_DIR, `${jobId}.json`);
  await writeFile(promptPath, prompt, { mode: 0o600 });
  const args = [
    "--prompt-file",
    promptPath,
    "--cwd",
    cwd,
    "--output-format",
    "streaming-json",
    "--max-turns",
    String(maxTurns),
    "--no-subagents",
    "--verbatim",
  ];
  if (model) args.push("-m", model);
  if (resumeId) args.push("--resume", resumeId);
  else args.push("--session-id", sessionId);
  if (ALLOW_AUTO) args.push("--always-approve");
  else args.push("--permission-mode", "auto");

  const out = createWriteStream(logPath, { flags: "a", mode: 0o600 });
  await new Promise((resolve, reject) => {
    out.on("open", resolve);
    out.on("error", reject);
  });

  const child = spawn(GROK_BIN, args, {
    cwd,
    env: {
      ...process.env,
      HOME,
      PATH: `${path.dirname(GROK_BIN)}:${process.env.PATH || ""}`,
    },
    stdio: ["ignore", out, out],
    detached: true,
  });
  child.unref();
  const meta = {
    jobId,
    sessionId,
    pid: child.pid,
    cwd,
    resume: Boolean(resumeId),
    startedAt: new Date().toISOString(),
    status: "running",
    logPath,
    promptPath,
    model: model || null,
    maxTurns,
  };
  await writeFile(metaPath, JSON.stringify(meta, null, 2));
  child.on("exit", async (code, signal) => {
    try {
      const cur = JSON.parse(await readFile(metaPath, "utf8"));
      cur.status = code === 0 ? "exited" : "failed";
      cur.exitCode = code;
      cur.signal = signal || null;
      cur.finishedAt = new Date().toISOString();
      await writeFile(metaPath, JSON.stringify(cur, null, 2));
    } catch {
      // ignore
    }
    out.end();
  });
  return meta;
}

async function loadJob(jobId) {
  const metaPath = path.join(JOBS_DIR, `${jobId}.json`);
  const meta = JSON.parse(await readFile(metaPath, "utf8"));
  let log = "";
  try {
    log = await readFile(meta.logPath, "utf8");
  } catch {
    log = "";
  }
  let alive = false;
  if (meta.pid) {
    try {
      process.kill(meta.pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
  }
  return {
    ...meta,
    alive,
    status: alive ? "running" : meta.status || "unknown",
    excerpt: extractAssistantText(log),
  };
}

function createServer() {
  const server = new McpServer({
    name: "grok-build-bridge",
    version: "1.0.0",
    instructions:
      "This Mac runs Grok Build. Use grok_sessions_list / grok_session_get to check work. Use grok_run to start a headless coding job (returns immediately with jobId + sessionId). Poll grok_job_status. Use grok_reply to continue a session. cwd must be under ~/Documents. Mac must be awake.",
  });

  server.registerTool(
    "grok_sessions_list",
    {
      description: "List recent Grok Build sessions on this Mac (title, cwd, last active).",
      inputSchema: {
        limit: z.number().int().min(1).max(50).optional().describe("Max sessions, default 15"),
        query: z.string().optional().describe("Optional filter on title, summary, cwd, or id"),
      },
    },
    async ({ limit, query }) => {
      const items = await loadSummaries({ query: query || "", limit: limit || 15 });
      return textResult({ count: items.length, sessions: items });
    }
  );

  server.registerTool(
    "grok_sessions_search",
    {
      description: "Search Grok Build sessions by keyword in title, summary, cwd, or id.",
      inputSchema: {
        query: z.string().describe("Search keyword"),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async ({ query, limit }) => {
      const items = await loadSummaries({ query, limit: limit || 15 });
      return textResult({ count: items.length, sessions: items });
    }
  );

  server.registerTool(
    "grok_session_get",
    {
      description: "Get one Grok Build session by id: title, cwd, summary, timestamps.",
      inputSchema: {
        sessionId: z.string().describe("Session UUID"),
      },
    },
    async ({ sessionId }) => {
      try {
        return textResult(await loadSession(sessionId));
      } catch (e) {
        return errResult(String(e.message || e));
      }
    }
  );

  server.registerTool(
    "grok_run",
    {
      description:
        "Start a new headless Grok Build job on this Mac. Returns immediately with jobId and sessionId. Poll grok_job_status. cwd must be inside ~/Documents.",
      inputSchema: {
        prompt: z.string().describe("Task for Grok Build"),
        cwd: z.string().describe("Absolute project directory under ~/Documents"),
        maxTurns: z.number().int().min(1).max(40).optional().describe("Default 12"),
        model: z.string().optional().describe("Model id, default CLI default (grok-4.6)"),
      },
    },
    async ({ prompt, cwd, maxTurns, model }) => {
      try {
        const realCwd = await assertCwd(cwd);
        const meta = await startGrok({
          prompt,
          cwd: realCwd,
          maxTurns: maxTurns || 12,
          model: model || undefined,
        });
        return textResult({
          ok: true,
          jobId: meta.jobId,
          sessionId: meta.sessionId,
          pid: meta.pid,
          cwd: meta.cwd,
          note: "Job is running on the Mac. Poll grok_job_status with this jobId.",
        });
      } catch (e) {
        return errResult(String(e.message || e));
      }
    }
  );

  server.registerTool(
    "grok_reply",
    {
      description: "Resume an existing Grok Build session with a new prompt. Starts a background job.",
      inputSchema: {
        sessionId: z.string().describe("Existing session UUID"),
        prompt: z.string().describe("Follow-up prompt"),
        cwd: z
          .string()
          .optional()
          .describe("Project dir; defaults to the session cwd if omitted"),
        maxTurns: z.number().int().min(1).max(40).optional(),
        model: z.string().optional(),
      },
    },
    async ({ sessionId, prompt, cwd, maxTurns, model }) => {
      try {
        const sess = await loadSession(sessionId);
        const realCwd = await assertCwd(cwd || sess.cwd);
        const meta = await startGrok({
          prompt,
          cwd: realCwd,
          resumeId: sessionId,
          maxTurns: maxTurns || 12,
          model: model || undefined,
        });
        return textResult({
          ok: true,
          jobId: meta.jobId,
          sessionId,
          pid: meta.pid,
          cwd: meta.cwd,
          note: "Resume job running. Poll grok_job_status with this jobId.",
        });
      } catch (e) {
        return errResult(String(e.message || e));
      }
    }
  );

  server.registerTool(
    "grok_job_status",
    {
      description: "Poll a background grok_run / grok_reply job: running or done, plus output excerpt.",
      inputSchema: {
        jobId: z.string().describe("Job UUID returned by grok_run or grok_reply"),
      },
    },
    async ({ jobId }) => {
      try {
        return textResult(await loadJob(jobId));
      } catch (e) {
        return errResult(String(e.message || e));
      }
    }
  );

  server.registerTool(
    "grok_inspect",
    {
      description: "Run `grok inspect --json` for a project directory (read-only config discovery).",
      inputSchema: {
        cwd: z.string().describe("Absolute project directory under ~/Documents"),
      },
    },
    async ({ cwd }) => {
      try {
        const realCwd = await assertCwd(cwd);
        const out = await new Promise((resolve, reject) => {
          const child = spawn(GROK_BIN, ["inspect", "--json"], {
            cwd: realCwd,
            env: { ...process.env, HOME, PATH: `${path.dirname(GROK_BIN)}:${process.env.PATH || ""}` },
          });
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (d) => {
            stdout += d;
          });
          child.stderr.on("data", (d) => {
            stderr += d;
          });
          child.on("error", reject);
          child.on("close", (code) => {
            if (code === 0) resolve(stdout);
            else reject(new Error(stderr || stdout || `inspect exited ${code}`));
          });
        });
        return textResult(out.slice(0, 12000));
      } catch (e) {
        return errResult(String(e.message || e));
      }
    }
  );

  return server;
}

const transports = Object.create(null);

async function handleMcp(req, res) {
  const sessionId = req.headers["mcp-session-id"];
  try {
    if (sessionId && transports[sessionId]) {
      await transports[sessionId].handleRequest(req, res, req.body);
      return;
    }
    if (req.method === "POST" && isInitializeRequest(req.body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports[sid] = transport;
        },
      });
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && transports[sid]) delete transports[sid];
      };
      const server = createServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }
    if (req.method === "GET" && !sessionId) {
      json(res, 200, { ok: true, name: "grok-build-bridge", transport: "streamable-http" });
      return;
    }
    json(res, 400, {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: No valid session ID provided" },
      id: null,
    });
  } catch (err) {
    console.error("mcp error", err);
    if (!res.headersSent) {
      json(res, 500, {
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
}

function requireAuth(req, res, next) {
  if (req.method === "OPTIONS") return next();
  if (req.path === "/health") return next();
  if (!tokensEqual(tokenFromReq(req))) {
    res.setHeader("WWW-Authenticate", 'Bearer realm="grok-build-bridge"');
    return json(res, 401, { error: "unauthorized" });
  }
  next();
}

const app = express();
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, mcp-session-id, mcp-protocol-version, x-api-key");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});
app.use(express.json({ limit: "4mb" }));
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "grok-build-bridge" });
});
app.use(requireAuth);
app.all("/mcp", handleMcp);
app.all("/t/:token/mcp", handleMcp);

await ensureDirs();
app.listen(PORT, "127.0.0.1", () => {
  console.log(`grok-build-bridge listening on 127.0.0.1:${PORT}`);
});
