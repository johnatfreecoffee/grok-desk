/**
 * Shared harness for the P3 client-projection smokes.
 *
 * Everything here is throwaway: each smoke boots its OWN daemon on its OWN
 * port with a scratch GROK_HOME and a scratch project cwd under os.tmpdir().
 * It never touches ~/.grok/sessions, never talks to the daemon on :8787, and
 * kills the whole process group (daemon + any `grok agent stdio` it spawned)
 * on the way out.
 *
 * The auth cookie is read the way `smoke-feed-ws.mjs` reads it — the local lock
 * closes a cookie-less socket with 4401, which is why the older smokes fail.
 */
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import WebSocket from "ws";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------- auth */

/** Live local-lock session cookie, or null when the daemon is unlocked. */
export function authCookie() {
  const p = path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "GrokDesk",
    "auth-sessions.json",
  );
  try {
    const bag = JSON.parse(fs.readFileSync(p, "utf8"))?.sessions || {};
    const now = Date.now();
    let best = null;
    for (const [token, s] of Object.entries(bag)) {
      const exp = Number(s?.expiresAt) || 0;
      if (exp <= now) continue;
      if (!best || exp > best.exp) best = { token, exp };
    }
    return best ? `gd_session=${best.token}` : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------ client store */

/** The store the app actually ships. Loaded straight from web/src. */
export async function loadFeedStore() {
  if (!globalThis.localStorage) {
    const bag = new Map();
    globalThis.localStorage = {
      getItem: (k) => (bag.has(k) ? bag.get(k) : null),
      setItem: (k, v) => bag.set(k, String(v)),
      removeItem: (k) => bag.delete(k),
      clear: () => bag.clear(),
    };
  }
  return import(pathToFileURL(path.join(ROOT, "web/src/lib/sessionFeed.ts")).href);
}

/* ----------------------------------------------------------------- daemon */

export class Scratch {
  constructor(tag) {
    this.tag = tag;
    this.root = fs.mkdtempSync(path.join(os.tmpdir(), `grok-desk-${tag}-`));
    this.home = path.join(this.root, "grok-home");
    this.cwd = path.join(this.root, "proj");
    fs.mkdirSync(path.join(this.home, "sessions"), { recursive: true });
    fs.mkdirSync(this.cwd, { recursive: true });
    // The grok CLI needs its auth/config; the session store stays scratch.
    for (const f of ["auth.json", "config.toml", "agent_id"]) {
      const src = path.join(os.homedir(), ".grok", f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(this.home, f));
    }
    this.port = 8800 + Math.floor(Math.random() * 120);
    this.proc = null;
    this.logPath = path.join(this.root, "daemon.log");
  }

  sessionDir(sessionId, cwd = this.cwd) {
    return path.join(this.home, "sessions", encodeURIComponent(cwd), sessionId);
  }

  async startDaemon() {
    const log = fs.openSync(this.logPath, "a");
    this.proc = spawn(process.execPath, [path.join(ROOT, "daemon/index.js")], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(this.port), GROK_HOME: this.home },
      stdio: ["ignore", log, log],
      detached: true, // own process group → one kill takes the grok children too
    });
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (Date.now() > deadline) throw new Error("daemon did not come up");
      try {
        const r = await fetch(`http://127.0.0.1:${this.port}/api/auth/status`);
        if (r.ok || r.status === 401) return this.port;
      } catch {
        /* not listening yet */
      }
      await sleep(200);
    }
  }

  daemonLog(lines = 40) {
    try {
      return fs.readFileSync(this.logPath, "utf8").split("\n").slice(-lines).join("\n");
    } catch {
      return "";
    }
  }

  /** Kill the daemon's whole process group, then verify nothing survived. */
  async stop() {
    const pid = this.proc?.pid;
    if (pid) {
      for (const sig of ["SIGTERM", "SIGKILL"]) {
        try {
          process.kill(-pid, sig);
        } catch {
          /* already gone */
        }
        await sleep(sig === "SIGTERM" ? 900 : 300);
        try {
          process.kill(pid, 0);
        } catch {
          break; // reaped
        }
      }
    }
    // Belt and braces: nothing from this process group may be left behind.
    for (const line of this.survivorLines()) {
      const p = Number(line.trim().split(/\s+/)[0]);
      if (Number.isInteger(p) && p > 0) {
        try {
          process.kill(p, "SIGKILL");
        } catch {
          /* */
        }
      }
    }
    try {
      fs.rmSync(this.root, { recursive: true, force: true });
    } catch {
      /* */
    }
  }

  /**
   * Anything still alive in this smoke's process group — the daemon and every
   * `grok agent stdio` it spawned. This is the proof that nothing is left
   * running; `ps` never shows GROK_HOME, so the pgid is what identifies them.
   */
  survivorLines() {
    const pgid = this.proc?.pid;
    if (!pgid) return [];
    try {
      return execSync("ps -eo pid=,pgid=,command=", { encoding: "utf8" })
        .split("\n")
        .filter((l) => Number(l.trim().split(/\s+/)[1]) === pgid)
        .map((l) => l.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  survivors() {
    return this.survivorLines().join("\n");
  }
}

/* -------------------------------------------------------------------- ws */

/**
 * One Desk client: a socket plus the real `SessionFeedStore`, wired exactly
 * the way `App.tsx` wires them (subscribe at the cursor, refetch on a gap).
 */
export class Client {
  constructor(name, port, feedmod) {
    this.name = name;
    this.port = port;
    this.feed = feedmod;
    this.store = new feedmod.SessionFeedStore();
    this.frames = [];
    this.gaps = 0;
    this.gapLog = [];
    this.ws = null;
    this.subs = new Map();
    this.onFrame = null;
  }

  async open() {
    const cookie = authCookie();
    this.ws = new WebSocket(`ws://127.0.0.1:${this.port}/ws`, {
      headers: cookie ? { Cookie: cookie } : {},
    });
    this.ws.on("message", (raw) => {
      let m;
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      this.frames.push(m);
      if (m.type === "feed" && m.sessionId) this.applyFeed(m);
      this.onFrame?.(m);
    });
    await new Promise((res, rej) => {
      this.ws.once("open", res);
      this.ws.once("error", rej);
      this.ws.once("close", (c) => rej(new Error(`closed ${c}`)));
    });
    await this.wait((f) => f.type === "hello", 20_000, "hello");
    return this;
  }

  applyFeed(frame) {
    const sid = String(frame.sessionId);
    const res = this.store.applyFeed(sid, frame);
    if (res.gap) {
      this.gaps += 1;
      this.gapLog.push(
        `${sid.slice(0, 8)} frame.fromSeq=${frame.fromSeq} frame.seq=${frame.seq} ` +
          `store.seq=${res.state.seq} catchUp=${Boolean(frame.catchUp)} events=${
            (frame.events || []).length
          }`,
      );
      this.send({ type: "subscribe", sessionId: sid, fromSeq: res.state.seq, cwd: this.subs.get(sid) });
    }
  }

  send(obj) {
    this.ws.send(JSON.stringify(obj));
  }

  /** Subscribe at the store's own cursor — the P3 contract. */
  subscribe(sessionId, cwd) {
    this.subs.set(sessionId, cwd);
    this.send({
      type: "subscribe",
      sessionId,
      fromSeq: this.store.cursor(sessionId),
      cwd,
    });
  }

  unsubscribe(sessionId) {
    this.subs.delete(sessionId);
    this.send({ type: "unsubscribe", sessionId });
  }

  state(sessionId) {
    return this.store.get(sessionId);
  }

  transcript(sessionId) {
    return (this.state(sessionId)?.messages || []).map((m) => `${m.role}:${m.content}`);
  }

  assistantText(sessionId) {
    return (this.state(sessionId)?.messages || [])
      .filter((m) => m.role === "assistant")
      .map((m) => m.content)
      .join("");
  }

  since() {
    return this.frames.length;
  }

  async wait(pred, ms = 20_000, label = "frame", from = 0) {
    const deadline = Date.now() + ms;
    let i = from;
    for (;;) {
      while (i < this.frames.length) {
        const f = this.frames[i++];
        if (pred(f)) return f;
      }
      if (Date.now() > deadline) throw new Error(`${this.name}: timeout waiting for ${label}`);
      await sleep(30);
    }
  }

  /** Wait until a predicate over this session's projected state holds. */
  async until(sessionId, pred, ms = 120_000, label = "state") {
    const deadline = Date.now() + ms;
    for (;;) {
      const st = this.state(sessionId);
      if (st && pred(st)) return st;
      if (Date.now() > deadline) throw new Error(`${this.name}: timeout waiting for ${label}`);
      await sleep(60);
    }
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      /* */
    }
  }
}

/* ------------------------------------------------------------- reporting */

export function reporter() {
  const state = { failures: 0 };
  return {
    ok: (m) => console.log("  ✓", m),
    bad: (m) => {
      state.failures += 1;
      console.log("  ✗", m);
    },
    check: (cond, good, bad) => {
      if (cond) console.log("  ✓", good);
      else {
        state.failures += 1;
        console.log("  ✗", bad || good);
      }
    },
    get failures() {
      return state.failures;
    },
    fail: () => {
      state.failures += 1;
    },
  };
}

/** Read the assistant text straight out of updates.jsonl — disk truth. */
export function diskAssistantText(dir) {
  try {
    return fs
      .readFileSync(path.join(dir, "updates.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((r) => r?.params?.update?.sessionUpdate === "agent_message_chunk")
      .map((r) => r.params.update.content?.text || "")
      .join("");
  } catch {
    return "";
  }
}
