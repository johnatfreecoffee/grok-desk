/**
 * ACP bridge — one long-lived `grok agent stdio` process, shared by browser
 * WebSocket clients. Text path only (CLI auth / subscription). Voice never
 * goes through here.
 */
import { spawn } from "node:child_process";
import readline from "node:readline";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TerminalHost } from "./terminal-host.js";

/** Normalize ask_user_question params into UI-friendly questions[]. */
function normalizeQuestions(params) {
  const raw =
    params?.questions ||
    params?.input?.questions ||
    (Array.isArray(params) ? params : null) ||
    [];
  if (!Array.isArray(raw)) return [];
  return raw.map((q, i) => {
    const options = Array.isArray(q?.options)
      ? q.options.map((o, j) => ({
          id: String(o?.id || o?.label || `opt_${j}`),
          label: String(o?.label || o?.name || o?.id || `Option ${j + 1}`),
          description: o?.description ? String(o.description) : "",
          preview: o?.preview != null ? String(o.preview) : null,
        }))
      : [];
    return {
      id: String(q?.id || `q_${i}`),
      question: String(q?.question || q?.prompt || q?.text || `Question ${i + 1}`),
      multiSelect: Boolean(q?.multi_select ?? q?.multiSelect),
      options,
    };
  });
}

function resolveGrokBin() {
  if (process.env.GROK_BIN && fs.existsSync(process.env.GROK_BIN)) {
    return process.env.GROK_BIN;
  }
  const home = os.homedir();
  const candidates = [
    path.join(home, ".grok", "bin", "grok"),
    "/usr/local/bin/grok",
    "/opt/homebrew/bin/grok",
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return "grok";
}

export class AcpBridge extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.grokBin = opts.grokBin || resolveGrokBin();
    this.cwd = opts.cwd || process.env.GROK_CWD || os.homedir();
    this.alwaysApprove = opts.alwaysApprove !== false;
    /** ask | auto | always-approve — when not always-approve, permission cards fire */
    this.permissionMode = opts.permissionMode || (this.alwaysApprove ? "always-approve" : "ask");
    this.proc = null;
    this.rl = null;
    this.nextId = 1;
    this.pending = new Map(); // id → { resolve, reject }
    /** JSON-RPC id → pending human permission */
    this.pendingPermissions = new Map();
    /** requestId → pending x.ai/ask_user_question | exit_plan_mode */
    this.pendingExtRequests = new Map();
    this.sessionId = null;
    this.ready = false;
    this.starting = null;
    this.bufferLines = [];
    /** Serialize ALL session-mutating RPCs (prompt/new/load/close). */
    this.rpcChain = Promise.resolve();
    /** Bump to ignore late loadSession results after timeout/abandon. */
    this.loadToken = 0;
    /** Permission card timeout ms */
    this.permissionTimeoutMs = Number(opts.permissionTimeoutMs || 300_000);
    /** @type {string[]} remembered allow patterns (prefix match on title/detail) */
    this.allowedPatterns = Array.isArray(opts.allowedPatterns) ? opts.allowedPatterns : [];
    this.terminalHost = new TerminalHost();
    this.terminalHost.on("output", (ev) => this.emit("terminal_output", ev));
    this.terminalHost.on("exit", (ev) => this.emit("terminal_exit", ev));
  }

  setAllowedPatterns(patterns) {
    this.allowedPatterns = Array.isArray(patterns) ? patterns.map(String) : [];
  }

  setPermissionMode(mode) {
    const m = String(mode || "always-approve");
    this.permissionMode = m;
    // auto: still prompt via ACP when escalated; only always-approve skips cards
    this.alwaysApprove = m === "always-approve" || m === "yolo" || m === "bypassPermissions";
  }

  /** Run fn on the serial RPC chain. */
  _enqueueRpc(fn) {
    const next = this.rpcChain.then(fn, fn);
    this.rpcChain = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  status() {
    return {
      agentAlive: !!(this.proc && !this.proc.killed),
      ready: this.ready,
      sessionId: this.sessionId,
      cwd: this.cwd,
      grokBin: this.grokBin,
      alwaysApprove: this.alwaysApprove,
      permissionMode: this.permissionMode,
      pendingPermissions: this.pendingPermissions.size,
      pendingExtRequests: this.pendingExtRequests.size,
    };
  }

  async ensure() {
    if (this.ready && this.proc && !this.proc.killed) return;
    if (this.starting) return this.starting;
    this.starting = this._start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async _start() {
    if (this.proc) this._teardown();

    const args = ["agent"];
    if (this.alwaysApprove) args.push("--always-approve");
    args.push("stdio");

    console.log(`[acp] spawn ${this.grokBin} ${args.join(" ")}  cwd=${this.cwd}`);
    this.proc = spawn(this.grokBin, args, {
      cwd: this.cwd,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.stderr.on("data", (buf) => {
      const s = buf.toString().trim();
      if (s) console.log(`[acp:stderr] ${s}`);
    });

    this.proc.on("exit", (code, signal) => {
      console.log(`[acp] agent exited code=${code} signal=${signal}`);
      this.ready = false;
      this.sessionId = null;
      for (const [, p] of this.pending) {
        p.reject(new Error("agent process exited"));
      }
      this.pending.clear();
      this.emit("agent_exit", { code, signal });
      this.proc = null;
    });

    this.rl = readline.createInterface({ input: this.proc.stdout });
    this.rl.on("line", (line) => this._onLine(line));

    await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
      clientInfo: { name: "grok-desk", version: "0.1.0" },
    });

    // Do NOT auto session/new on warm start — that orphaned empty chats every
    // daemon restart and polluted the sidebar. Session is created by newSession
    // or attached by loadSession when the user actually opens a chat.
    this.sessionId = null;
    this.ready = true;
    console.log(`[acp] agent ready (no session yet) cwd=${this.cwd}`);
    this.emit("ready", { sessionId: null, cwd: this.cwd });
  }

  _onLine(line) {
    if (!line || !line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.warn("[acp] non-json line:", line.slice(0, 200));
      return;
    }

    // JSON-RPC response
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) p.reject(Object.assign(new Error(msg.error.message || "acp error"), msg.error));
        else p.resolve(msg.result);
      }
      this.emit("rpc", msg);
      return;
    }

    // Notifications / server→client requests
    if (msg.method) {
      if (msg.method === "session/request_permission" && msg.id !== undefined) {
        this._handlePermissionRequest(msg);
        return;
      }
      // Interactive cards (TUI parity)
      if (
        msg.id !== undefined &&
        (msg.method === "x.ai/ask_user_question" ||
          msg.method === "ask_user_question" ||
          msg.method === "x.ai/exit_plan_mode" ||
          msg.method === "exit_plan_mode")
      ) {
        this._handleExtInteraction(msg);
        return;
      }
      // Terminal host (agent asks client to run PTY/shell)
      if (msg.id !== undefined && this.terminalHost.isTerminalMethod(msg.method)) {
        void this._handleTerminalRequest(msg);
        return;
      }
      // Worktree apply etc. — pass through as notification if no id; with id = request
      if (
        msg.id !== undefined &&
        (String(msg.method).startsWith("x.ai/git/worktree/") ||
          String(msg.method).startsWith("fs/") ||
          String(msg.method).startsWith("x.ai/fs/"))
      ) {
        // Let unknown methods fail explicitly so agent can fall back
        this._write({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: `Desk does not host ${msg.method} yet` },
        });
        return;
      }
      // Unknown server→client request with id: don't hang the agent
      if (msg.id !== undefined) {
        console.warn("[acp] unhandled request method", msg.method);
        this._write({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: `Method not found: ${msg.method}` },
        });
        return;
      }
      this.emit("notification", msg);
      return;
    }
  }

  async _handleTerminalRequest(msg) {
    try {
      const result = await this.terminalHost.handle(msg.method, msg.params || {}, {
        cwd: this.cwd,
        sessionId: this.sessionId,
      });
      this._write({ jsonrpc: "2.0", id: msg.id, result: result || {} });
    } catch (e) {
      this._write({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32000, message: e.message || String(e) },
      });
    }
  }

  _handlePermissionRequest(msg) {
    const rpcId = msg.id;
    const params = msg.params || {};
    const options = Array.isArray(params.options)
      ? params.options
      : Array.isArray(params.permissionOptions)
        ? params.permissionOptions
        : [];
    const toolCall = params.toolCall || params.tool_call || params.request || params;
    const title =
      toolCall?.title ||
      toolCall?.name ||
      params.title ||
      params.toolName ||
      "Tool permission";
    const detail =
      (typeof toolCall?.rawInput === "object" &&
        (toolCall.rawInput.command ||
          toolCall.rawInput.path ||
          toolCall.rawInput.target_file ||
          toolCall.rawInput.description)) ||
      toolCall?.detail ||
      params.description ||
      "";

    // Interactive tools open their own Desk cards via x.ai/* — auto-allow the permission gate
    const titleL = String(title).toLowerCase();
    if (
      /ask_user_question|ask user|exit_plan_mode|enter_plan_mode/i.test(titleL) ||
      /ask_user_question|exit_plan_mode/i.test(String(toolCall?.name || ""))
    ) {
      this._write({
        jsonrpc: "2.0",
        id: rpcId,
        result: { outcome: { outcome: "selected", optionId: "allow_always" } },
      });
      return;
    }

    // Always-approve / yolo: instant allow (legacy Desk behavior)
    if (this.alwaysApprove) {
      this._write({
        jsonrpc: "2.0",
        id: rpcId,
        result: {
          outcome: { outcome: "selected", optionId: "allow_always" },
        },
      });
      return;
    }

    // Remembered allow patterns (prefix / includes match)
    const hay = `${title} ${detail}`.toLowerCase();
    for (const pat of this.allowedPatterns) {
      const p = String(pat || "").toLowerCase().trim();
      if (p && hay.includes(p)) {
        console.log("[acp] permission auto-allow pattern", p);
        this._write({
          jsonrpc: "2.0",
          id: rpcId,
          result: { outcome: { outcome: "selected", optionId: "allow_always" } },
        });
        return;
      }
    }

    const requestId = `perm_${rpcId}_${Date.now().toString(36)}`;
    const timer = setTimeout(() => {
      if (!this.pendingPermissions.has(requestId)) return;
      console.warn("[acp] permission timeout — deny", requestId);
      this.resolvePermission(requestId, { decision: "deny", reason: "timeout" });
    }, this.permissionTimeoutMs);

    this.pendingPermissions.set(requestId, { rpcId, timer, params, createdAt: Date.now() });
    console.log("[acp] permission_request", requestId, String(title).slice(0, 80));
    this.emit("permission_request", {
      requestId,
      rpcId,
      sessionId: this.sessionId,
      cwd: this.cwd,
      title: String(title),
      detail: String(detail || "").slice(0, 2000),
      options: options.map((o) => ({
        optionId: o.optionId || o.id || o.name,
        name: o.name || o.label || o.optionId || o.id,
        kind: o.kind || o.type || null,
      })),
      raw: params,
    });
  }

  /**
   * Resolve a pending permission card.
   * @param {string} requestId
   * @param {{ decision?: 'allow'|'allow_always'|'deny', optionId?: string, reason?: string }} choice
   */
  resolvePermission(requestId, choice = {}) {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return false;
    this.pendingPermissions.delete(requestId);
    if (pending.timer) clearTimeout(pending.timer);

    const opts = Array.isArray(pending.params?.options)
      ? pending.params.options
      : Array.isArray(pending.params?.permissionOptions)
        ? pending.params.permissionOptions
        : [];
    const ids = opts.map((o) => o.optionId || o.id || o.name).filter(Boolean);

    let optionId = choice.optionId;
    if (!optionId) {
      const d = choice.decision || "allow";
      if (d === "allow_always" || d === "always") {
        optionId =
          ids.find((x) => /always|allow_always|allow-always/i.test(String(x))) ||
          ids.find((x) => /allow/i.test(String(x))) ||
          "allow_always";
      } else if (d === "deny" || d === "reject") {
        optionId =
          ids.find((x) => /reject|deny|cancel/i.test(String(x))) ||
          "reject_once";
      } else {
        optionId =
          ids.find((x) => /allow_once|allow-once|once/i.test(String(x))) ||
          ids.find((x) => /^allow$/i.test(String(x))) ||
          ids.find((x) => /allow/i.test(String(x))) ||
          "allow_once";
      }
    }

    try {
      const result =
        choice.decision === "deny" || /reject|deny/i.test(String(optionId))
          ? {
              outcome: {
                outcome: "selected",
                optionId,
                ...(choice.reason ? { message: String(choice.reason).slice(0, 500) } : {}),
              },
            }
          : {
              outcome: { outcome: "selected", optionId },
            };
      this._write({ jsonrpc: "2.0", id: pending.rpcId, result });
      this.emit("permission_resolved", { requestId, optionId, decision: choice.decision });
      return true;
    } catch (e) {
      console.warn("[acp] resolvePermission failed", e.message);
      return false;
    }
  }

  /** Deny all open permission cards (stop / abandon). */
  flushPermissions(reason = "abandoned") {
    for (const requestId of [...this.pendingPermissions.keys()]) {
      this.resolvePermission(requestId, { decision: "deny", reason });
    }
    for (const requestId of [...this.pendingExtRequests.keys()]) {
      const kind = this.pendingExtRequests.get(requestId)?.kind;
      if (kind === "exit_plan_mode") {
        this.resolveExtRequest(requestId, { type: "Rejected", reason: String(reason) });
      } else {
        this.resolveExtRequest(requestId, { type: "SkipInterview" });
      }
    }
  }

  /**
   * x.ai/ask_user_question + x.ai/exit_plan_mode — blocking cards for the user.
   */
  _handleExtInteraction(msg) {
    const rpcId = msg.id;
    const method = String(msg.method || "");
    const params = msg.params || {};
    const isPlan = /exit_plan_mode/i.test(method);
    const kind = isPlan ? "exit_plan_mode" : "ask_user_question";
    const requestId = `ext_${kind}_${rpcId}_${Date.now().toString(36)}`;

    // Cancel previous same-kind card
    for (const [rid, p] of [...this.pendingExtRequests.entries()]) {
      if (p.kind === kind) {
        console.log("[acp] replacing pending", kind, rid);
        if (p.timer) clearTimeout(p.timer);
        this.pendingExtRequests.delete(rid);
        try {
          this._write({
            jsonrpc: "2.0",
            id: p.rpcId,
            result: isPlan
              ? { type: "Rejected", reason: "superseded" }
              : { type: "SkipInterview" },
          });
        } catch {
          /* */
        }
        this.emit("ext_request_cancelled", { requestId: rid, kind });
      }
    }

    const timer = setTimeout(() => {
      if (!this.pendingExtRequests.has(requestId)) return;
      console.warn("[acp] ext request timeout", kind, requestId);
      if (isPlan) {
        this.resolveExtRequest(requestId, { type: "Rejected", reason: "timeout" });
      } else {
        this.resolveExtRequest(requestId, { type: "SkipInterview" });
      }
    }, this.permissionTimeoutMs);

    this.pendingExtRequests.set(requestId, { rpcId, timer, params, kind, createdAt: Date.now() });

    if (isPlan) {
      const plan =
        params.planContent ||
        params.plan ||
        params.content ||
        (typeof params === "string" ? params : "") ||
        "";
      console.log("[acp] exit_plan_mode", requestId);
      this.emit("plan_approval_request", {
        requestId,
        rpcId,
        sessionId: this.sessionId,
        cwd: this.cwd,
        plan: String(plan).slice(0, 50_000),
        raw: params,
      });
      return;
    }

    const questions = normalizeQuestions(params);
    console.log("[acp] ask_user_question", requestId, questions.length);
    this.emit("question_request", {
      requestId,
      rpcId,
      sessionId: this.sessionId,
      cwd: this.cwd,
      questions,
      raw: params,
    });
  }

  /**
   * @param {string} requestId
   * @param {Record<string, unknown>} result  internally-tagged AskUserQuestionExtResponse | ExitPlanMode result
   */
  resolveExtRequest(requestId, result = {}) {
    const pending = this.pendingExtRequests.get(requestId);
    if (!pending) return false;
    this.pendingExtRequests.delete(requestId);
    if (pending.timer) clearTimeout(pending.timer);
    try {
      this._write({ jsonrpc: "2.0", id: pending.rpcId, result });
      this.emit("ext_request_resolved", {
        requestId,
        kind: pending.kind,
        result,
      });
      return true;
    } catch (e) {
      console.warn("[acp] resolveExtRequest failed", e.message);
      return false;
    }
  }

  _write(obj) {
    if (!this.proc?.stdin?.writable) throw new Error("agent stdin not writable");
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }

  request(method, params = {}, timeoutMs = 120000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`acp timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        this._write({ jsonrpc: "2.0", id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  /**
   * Send a user prompt. Streams session/update notifications via events.
   * Resolves when the prompt turn completes (session/prompt result).
   *
   * @param {string} text
   * @param {{ onUpdate?: Function, promptBlocks?: object[] }} opts
   *   promptBlocks — ACP content blocks (text + image). When set, used as-is.
   */
  async prompt(text, { onUpdate, promptBlocks } = {}) {
    return this._enqueueRpc(async () => {
      await this.ensure();
      if (!this.sessionId) throw new Error("no session");

      const handler = (msg) => {
        if (msg.method !== "session/update") return;
        const update = msg.params?.update || msg.params;
        if (onUpdate) onUpdate(update, msg.params);
        this.emit("session_update", update, msg.params);
      };
      this.on("notification", handler);

      const prompt =
        Array.isArray(promptBlocks) && promptBlocks.length
          ? promptBlocks
          : [{ type: "text", text: text || "" }];

      try {
        const result = await this.request(
          "session/prompt",
          {
            sessionId: this.sessionId,
            prompt,
          },
          600000, // long agent runs
        );
        return result;
      } finally {
        this.off("notification", handler);
      }
    });
  }

  /**
   * Best-effort cancel — MUST NOT wait on rpcChain (hung prompt would block cancel forever).
   * Fire cancel JSON-RPC without enqueuing; reject in-flight prompt so the chain can advance.
   */
  async cancelSession() {
    if (!this.sessionId) return false;
    const sid = this.sessionId;
    // Fail pending RPCs so rpcChain unblocks (hung session/prompt especially)
    this._rejectPending(new Error("session cancelled"));
    try {
      // Fire-and-forget cancel — do not await via request() (that re-queues on chain)
      this._write({
        jsonrpc: "2.0",
        id: this.nextId++,
        method: "session/cancel",
        params: { sessionId: sid },
      });
      return true;
    } catch {
      try {
        this._write({
          jsonrpc: "2.0",
          id: this.nextId++,
          method: "session/prompt/cancel",
          params: { sessionId: sid },
        });
        return true;
      } catch {
        return false;
      }
    }
  }

  _rejectPending(err) {
    for (const [, p] of this.pending) {
      try {
        p.reject(err);
      } catch {
        /* */
      }
    }
    this.pending.clear();
  }

  async newSession(cwd) {
    return this._enqueueRpc(async () => {
      if (cwd) this.cwd = cwd;
      await this.ensure();
      // Close old if protocol supports it — best effort
      if (this.sessionId) {
        try {
          await this.request("session/close", { sessionId: this.sessionId }, 10000);
        } catch {
          /* optional method */
        }
      }
      console.log(`[acp] session/new cwd=${this.cwd}`);
      const res = await this.request("session/new", {
        cwd: this.cwd,
        mcpServers: [],
      });
      this.sessionId = res.sessionId;
      console.log(`[acp] session ready id=${this.sessionId} cwd=${this.cwd}`);
      this.emit("ready", { sessionId: this.sessionId, cwd: this.cwd });
      return res;
    });
  }

  /**
   * Resume an existing on-disk session (same as TUI /resume).
   * Tries session/load then session/resume for ACP version skew.
   * loadToken: ignore late results after timeout/abandon.
   */
  async loadSession(sessionId, cwd) {
    const token = ++this.loadToken;
    return this._enqueueRpc(async () => {
      if (token !== this.loadToken) {
        throw new Error("loadSession superseded");
      }
      if (cwd) this.cwd = cwd;
      await this.ensure();
      if (token !== this.loadToken) throw new Error("loadSession superseded");
      if (this.sessionId && this.sessionId !== sessionId) {
        try {
          await this.request("session/close", { sessionId: this.sessionId }, 10000);
        } catch {
          /* */
        }
      }

      const params = {
        sessionId,
        cwd: this.cwd,
        mcpServers: [],
      };

      let res;
      try {
        res = await this.request("session/load", params, 20000);
      } catch (e1) {
        try {
          res = await this.request("session/resume", params, 20000);
        } catch (e2) {
          try {
            res = await this.request("session/load", { sessionId, mcpServers: [] }, 20000);
          } catch {
            throw new Error(
              `Could not load session: ${e1.message || e1}; resume: ${e2.message || e2}`,
            );
          }
        }
      }
      if (token !== this.loadToken) {
        throw new Error("loadSession superseded");
      }
      this.sessionId = res?.sessionId || sessionId;
      this.emit("ready", { sessionId: this.sessionId, cwd: this.cwd });
      return { ...res, sessionId: this.sessionId, cwd: this.cwd };
    });
  }

  _teardown() {
    this.flushPermissions("agent_stopped");
    try {
      this.terminalHost?.disposeAll();
    } catch {
      /* */
    }
    this._rejectPending(new Error("agent stopped"));
    // Reset serial chain so newSession/load aren't stuck behind a dead prompt
    this.rpcChain = Promise.resolve();
    this.loadToken = (this.loadToken || 0) + 1;
    try {
      this.rl?.close();
    } catch {
      /* */
    }
    try {
      this.proc?.kill("SIGTERM");
    } catch {
      /* */
    }
    this.rl = null;
    this.proc = null;
    this.ready = false;
    this.sessionId = null;
  }

  stop() {
    this._teardown();
  }

  /** Kill agent process and spin a fresh process (UI Restart / hard abandon). */
  async restart() {
    // Drop in-flight start so we don't attach to a dying process
    this.starting = null;
    this._teardown();
    // Brief gap so OS reaps the child before we respawn
    await new Promise((r) => setTimeout(r, 300));
    await this.ensure();
    return this.status();
  }
}
