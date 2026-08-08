/**
 * ACP terminal host — implements client-side terminal methods for Grok agent.
 * Methods: terminal/create | x.ai/terminal/create, output, kill, wait_for_exit
 */
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import os from "node:os";

let nextTermId = 1;

export class TerminalHost extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, TermSlot>} */
    this.terms = new Map();
  }

  /**
   * @param {string} method
   * @param {object} params
   * @param {{ cwd?: string, sessionId?: string|null }} ctx
   */
  async handle(method, params = {}, ctx = {}) {
    const m = String(method || "").replace(/^x\.ai\//, "");
    if (m === "terminal/create" || m === "terminal/new") {
      return this.create(params, ctx);
    }
    if (m === "terminal/output" || m === "terminal/read") {
      return this.output(params);
    }
    if (m === "terminal/kill" || m === "terminal/close") {
      return this.kill(params);
    }
    if (m === "terminal/wait_for_exit" || m === "terminal/wait") {
      return this.waitForExit(params);
    }
    if (m === "terminal/write" || m === "terminal/input") {
      return this.write(params);
    }
    throw new Error(`unsupported terminal method: ${method}`);
  }

  isTerminalMethod(method) {
    const m = String(method || "");
    return (
      m === "terminal/create" ||
      m === "terminal/output" ||
      m === "terminal/kill" ||
      m === "terminal/wait_for_exit" ||
      m === "terminal/write" ||
      m.startsWith("x.ai/terminal/") ||
      m.startsWith("terminal/")
    );
  }

  create(params, ctx) {
    const id = `term_${nextTermId++}`;
    const cwd = params.cwd || params.workingDirectory || ctx.cwd || os.homedir();
    const cmd = params.command || params.cmd || process.env.SHELL || "/bin/zsh";
    const args = Array.isArray(params.args) ? params.args : [];
    // If command is a full shell line:
    const useShell = !params.args && params.command && /\s/.test(params.command);

    const child = useShell
      ? spawn(process.env.SHELL || "/bin/zsh", ["-lc", params.command], {
          cwd,
          env: { ...process.env, TERM: "xterm-256color" },
          stdio: ["pipe", "pipe", "pipe"],
        })
      : spawn(cmd, args, {
          cwd,
          env: { ...process.env, TERM: "xterm-256color" },
          stdio: ["pipe", "pipe", "pipe"],
        });

    /** @type {TermSlot} */
    const slot = {
      id,
      cwd,
      command: useShell ? params.command : `${cmd} ${args.join(" ")}`.trim(),
      proc: child,
      stdout: "",
      stderr: "",
      exitCode: null,
      signal: null,
      exited: false,
      waiters: [],
      sessionId: ctx.sessionId || null,
    };
    this.terms.set(id, slot);

    const push = (stream, chunk) => {
      const text = chunk.toString("utf8");
      if (stream === "stdout") slot.stdout += text;
      else slot.stderr += text;
      // cap 512KB each
      if (slot.stdout.length > 512_000) slot.stdout = slot.stdout.slice(-400_000);
      if (slot.stderr.length > 512_000) slot.stderr = slot.stderr.slice(-400_000);
      this.emit("output", {
        terminalId: id,
        sessionId: slot.sessionId,
        stream,
        chunk: text,
        stdout: slot.stdout,
        stderr: slot.stderr,
      });
    };

    child.stdout?.on("data", (c) => push("stdout", c));
    child.stderr?.on("data", (c) => push("stderr", c));
    child.on("exit", (code, signal) => {
      slot.exited = true;
      slot.exitCode = code;
      slot.signal = signal;
      for (const w of slot.waiters) w({ exitCode: code, signal });
      slot.waiters = [];
      this.emit("exit", {
        terminalId: id,
        sessionId: slot.sessionId,
        exitCode: code,
        signal,
      });
    });

    return {
      terminalId: id,
      id,
      pid: child.pid,
      cwd,
    };
  }

  output(params) {
    const id = params.terminalId || params.id;
    const slot = this.terms.get(id);
    if (!slot) throw new Error(`unknown terminal ${id}`);
    const since = Number(params.since || 0) || 0;
    const out = (slot.stdout + (slot.stderr ? "\n" + slot.stderr : "")).slice(since);
    return {
      terminalId: id,
      output: out,
      stdout: slot.stdout,
      stderr: slot.stderr,
      exited: slot.exited,
      exitCode: slot.exitCode,
    };
  }

  write(params) {
    const id = params.terminalId || params.id;
    const slot = this.terms.get(id);
    if (!slot) throw new Error(`unknown terminal ${id}`);
    const data = params.data || params.input || params.text || "";
    if (slot.proc?.stdin?.writable) {
      slot.proc.stdin.write(String(data));
    }
    return { ok: true };
  }

  kill(params) {
    const id = params.terminalId || params.id;
    const slot = this.terms.get(id);
    if (!slot) return { ok: true, alreadyGone: true };
    try {
      slot.proc?.kill(params.signal || "SIGTERM");
    } catch {
      /* */
    }
    return { ok: true };
  }

  waitForExit(params) {
    const id = params.terminalId || params.id;
    const slot = this.terms.get(id);
    if (!slot) throw new Error(`unknown terminal ${id}`);
    if (slot.exited) {
      return { exitCode: slot.exitCode, signal: slot.signal };
    }
    const timeoutMs = Number(params.timeoutMs || params.timeout || 600_000);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("terminal wait timeout"));
      }, timeoutMs);
      slot.waiters.push((result) => {
        clearTimeout(timer);
        resolve(result);
      });
    });
  }

  disposeAll() {
    for (const [id, slot] of this.terms) {
      try {
        slot.proc?.kill("SIGTERM");
      } catch {
        /* */
      }
      this.terms.delete(id);
    }
  }
}

/**
 * @typedef {{
 *   id: string,
 *   cwd: string,
 *   command: string,
 *   proc: import('node:child_process').ChildProcess,
 *   stdout: string,
 *   stderr: string,
 *   exitCode: number|null,
 *   signal: string|null,
 *   exited: boolean,
 *   waiters: Function[],
 *   sessionId: string|null,
 * }} TermSlot
 */
