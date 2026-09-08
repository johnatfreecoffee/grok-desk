/**
 * Multi-worker ACP pool — N independent `grok agent stdio` processes.
 * Each worker owns at most one live ACP session at a time.
 * Never touches the global turn controller; index.js owns busy/queues.
 */
import { EventEmitter } from "node:events";
import os from "node:os";
import { AcpBridge } from "./acp-bridge.js";

const DEFAULT_MAX = Number(process.env.DESK_MAX_WORKERS || 4);
/** How long a non-default worker may sit idle before it is reaped. */
const DEFAULT_IDLE_MS = Number(process.env.DESK_WORKER_IDLE_MS || 10 * 60 * 1000);

export class AcpPool extends EventEmitter {
  /**
   * @param {{ maxWorkers?: number, alwaysApprove?: boolean, cwd?: string }} opts
   */
  constructor(opts = {}) {
    super();
    this.max = Math.max(1, Math.min(16, opts.maxWorkers || DEFAULT_MAX));
    this.alwaysApprove = opts.alwaysApprove !== false;
    this.permissionMode = opts.permissionMode || (this.alwaysApprove ? "always-approve" : "ask");
    /** @type {Map<string, WorkerSlot>} */
    this.workers = new Map();
    /** sessionId → workerId */
    this.sessionToWorker = new Map();
    this._nextId = 1;
    this.idleMs = Number.isFinite(Number(opts.idleMs)) ? Number(opts.idleMs) : DEFAULT_IDLE_MS;
    /** Set by stopAll — the pool is shutting down and must not respawn. */
    this.stopped = false;
    /** Kept so `bridge.status()` still answers after shutdown without respawning. */
    this._lastDefault = null;
    /** pids SIGTERMed but not yet confirmed dead. @type {Set<number>} */
    this._dying = new Set();
    const boot = this._spawn(opts.cwd || process.env.GROK_CWD || os.homedir());
    this.defaultId = boot.id;
    this._lastDefault = boot;
  }

  /** Update mode for future spawns; existing workers get setPermissionMode on bridge. */
  setPermissionMode(mode) {
    this.permissionMode = mode || "always-approve";
    this.alwaysApprove =
      this.permissionMode === "always-approve" ||
      this.permissionMode === "yolo" ||
      this.permissionMode === "bypassPermissions";
    for (const w of this.workers.values()) {
      w.bridge.setPermissionMode(this.permissionMode);
    }
  }

  /** @returns {WorkerSlot} */
  get defaultWorker() {
    let w = this.workers.get(this.defaultId);
    if (!w) {
      // Shutdown must never resurrect a `grok agent` on the way out.
      if (this.stopped) return this._lastDefault;
      w = this._spawn();
      this.defaultId = w.id;
    }
    this._lastDefault = w;
    return w;
  }

  /** Back-compat: primary bridge used by most of index.js */
  get bridge() {
    return this.defaultWorker.bridge;
  }

  size() {
    return this.workers.size;
  }

  list() {
    return [...this.workers.values()].map((w) => this._public(w));
  }

  status() {
    const list = this.list();
    return {
      maxWorkers: this.max,
      workerCount: list.length,
      busyCount: list.filter((w) => w.busy).length,
      workers: list,
    };
  }

  /**
   * @param {string|null|undefined} sessionId
   * @returns {WorkerSlot|null}
   */
  findBySession(sessionId) {
    if (!sessionId) return null;
    const wid = this.sessionToWorker.get(String(sessionId));
    if (wid && this.workers.has(wid)) return this.workers.get(wid);
    for (const w of this.workers.values()) {
      const sid = w.sessionId || w.bridge.sessionId;
      if (sid && String(sid) === String(sessionId)) return w;
    }
    return null;
  }

  /**
   * Acquire a worker for a session/cwd.
   * Prefers existing binding; then idle free; then spawn.
   * @returns {WorkerSlot|null} null if pool full and none free
   */
  acquire({ sessionId = null, cwd = null, preferFree = true } = {}) {
    const take = (w) => {
      w.lastUsedAt = Date.now();
      return w;
    };
    if (sessionId) {
      const bound = this.findBySession(sessionId);
      if (bound) return take(bound);
    }

    if (preferFree) {
      // Prefer idle workers with no session (fresh)
      for (const w of this.workers.values()) {
        if (!w.busy && !w.bridge.sessionId && !w.sessionId) {
          if (cwd) w.bridge.cwd = cwd;
          return take(w);
        }
      }
      // Idle worker that can be rebound
      for (const w of this.workers.values()) {
        if (!w.busy) {
          if (cwd) w.bridge.cwd = cwd;
          return take(w);
        }
      }
    }

    if (this.workers.size < this.max) {
      return this._spawn(cwd || undefined);
    }
    return null;
  }

  /**
   * Force-allocate a new worker for parallel dispatch (throws if full).
   * @returns {WorkerSlot}
   */
  spawn(cwd) {
    if (this.workers.size >= this.max) {
      const err = new Error(`Agent pool full (max ${this.max}). Stop an agent or wait.`);
      err.code = "POOL_FULL";
      throw err;
    }
    return this._spawn(cwd);
  }

  bindSession(worker, sessionId, cwd) {
    if (!worker) return;
    worker.lastUsedAt = Date.now();
    if (worker.sessionId && worker.sessionId !== sessionId) {
      this.sessionToWorker.delete(worker.sessionId);
    }
    worker.sessionId = sessionId || null;
    if (cwd) {
      worker.cwd = cwd;
      worker.bridge.cwd = cwd;
    }
    if (sessionId) this.sessionToWorker.set(String(sessionId), worker.id);
  }

  clearSession(worker) {
    if (!worker) return;
    if (worker.sessionId) this.sessionToWorker.delete(worker.sessionId);
    worker.sessionId = null;
  }

  setBusy(worker, busy) {
    if (!worker) return;
    worker.busy = Boolean(busy);
    // Idle age is measured from the last time a worker actually did something,
    // so a worker that just finished a turn is not reaped a second later.
    worker.lastUsedAt = Date.now();
  }

  /** Any worker currently mid-turn? */
  anyBusy() {
    for (const w of this.workers.values()) {
      if (w.busy) return true;
    }
    return false;
  }

  busySessionIds() {
    const ids = [];
    for (const w of this.workers.values()) {
      if (w.busy) {
        const sid = w.sessionId || w.bridge.sessionId;
        if (sid) ids.push(sid);
      }
    }
    return ids;
  }

  async stopWorker(workerId, { restartDefault = true } = {}) {
    const w = this.workers.get(workerId);
    if (!w) return false;
    if (w.sessionId) this.sessionToWorker.delete(w.sessionId);
    // The bridge only SIGTERMs and then forgets the pid. An agent that is wedged
    // (or ignoring SIGTERM) then outlives the pool with nobody holding a handle
    // to it — one of those survived 16 hours holding a stale ownership entry.
    const pids = w.bridge?.livePids?.() || [w.bridge?.proc?.pid];
    try {
      w.bridge.stop();
    } catch {
      /* */
    }
    for (const pid of pids) this._escalate(pid);
    this.workers.delete(workerId);
    if (workerId === this.defaultId) {
      if (this.workers.size > 0) {
        this.defaultId = [...this.workers.keys()][0];
      } else if (restartDefault && !this.stopped) {
        const nw = this._spawn();
        this.defaultId = nw.id;
        this._lastDefault = nw;
      }
    }
    this.emit("worker_stopped", { workerId });
    return true;
  }

  async restartAll() {
    const ids = [...this.workers.keys()];
    for (const id of ids) {
      await this.stopWorker(id, { restartDefault: false });
    }
    const w = this._spawn();
    this.defaultId = w.id;
    this._lastDefault = w;
    await w.bridge.ensure();
    return this.status();
  }

  /* ------------------------------------------------------------- P5 reaping */

  /**
   * Reap idle workers.
   *
   * Nothing called `stopWorker` before this, so every worker a parallel
   * dispatch spawned lived until the daemon restarted (3–4 left over after a
   * test run was normal). Each one holds a `grok agent` child, and each child
   * holds a session — which is how a leaked worker kept a stale ownership entry
   * alive for 16 hours.
   *
   * The default worker is never reaped: it is the warm path for the next
   * prompt. A busy worker is never reaped. Everything else goes once it has
   * been idle for `idleMs`.
   *
   * @returns {Promise<string[]>} the worker ids that were stopped
   */
  async reapIdle({ idleMs = this.idleMs, now = Date.now() } = {}) {
    if (this.stopped) return [];
    const reaped = [];
    for (const [id, w] of [...this.workers]) {
      if (id === this.defaultId) continue;
      if (w.busy) continue;
      const age = now - (w.lastUsedAt || w.createdAt || now);
      if (age < idleMs) continue;
      console.log(`[pool] reap ${id} — idle ${Math.round(age / 1000)}s`);
      // eslint-disable-next-line no-await-in-loop
      await this.stopWorker(id, { restartDefault: false });
      reaped.push(id);
    }
    return reaped;
  }

  /**
   * SIGTERM has been sent to `pid`; make sure it actually dies.
   *
   * `AcpBridge._teardown()` sends SIGTERM and immediately drops `proc`, so
   * nothing followed up. This keeps the pid until it is confirmed gone.
   */
  _escalate(pid, graceMs = 700) {
    if (!Number.isInteger(pid) || pid <= 0) return;
    this._dying.add(pid);
    const t = setTimeout(() => {
      this._dying.delete(pid);
      try {
        process.kill(pid, 0);
      } catch {
        return; // already reaped by SIGTERM — the normal case
      }
      try {
        console.warn(`[pool] SIGKILL agent pid ${pid} — ignored SIGTERM`);
        process.kill(pid, "SIGKILL");
      } catch {
        /* */
      }
    }, graceMs);
    t.unref?.();
  }

  /**
   * pids of the `grok agent` children this pool is responsible for: the live
   * workers, plus anything stopped whose death has not been confirmed yet.
   */
  childPids() {
    const out = new Set(this._dying);
    for (const w of this.workers.values()) {
      for (const pid of w.bridge?.livePids?.() || []) {
        if (Number.isInteger(pid) && pid > 0) out.add(pid);
      }
    }
    return [...out];
  }

  /**
   * Shutdown: SIGTERM every `grok agent` child and refuse to spawn again.
   *
   * The daemon used to call `bridge.stop()`, which only ever touched the
   * DEFAULT worker — every other worker's `grok agent` was orphaned on
   * SIGTERM. Returns the pids it signalled so the caller can SIGKILL whatever
   * ignored SIGTERM before the process exits.
   */
  stopAll() {
    const pids = this.childPids();
    this.stopped = true;
    for (const [id, w] of [...this.workers]) {
      if (w.sessionId) this.sessionToWorker.delete(w.sessionId);
      try {
        w.bridge.stop();
      } catch {
        /* */
      }
      this.workers.delete(id);
    }
    console.log(`[pool] stopAll — signalled ${pids.length} agent child(ren)`);
    return pids;
  }

  /**
   * @param {string} [cwd]
   * @returns {WorkerSlot}
   */
  _spawn(cwd) {
    const id = `w${this._nextId++}`;
    const bridge = new AcpBridge({
      alwaysApprove: this.alwaysApprove,
      permissionMode: this.permissionMode,
      cwd: cwd || process.env.GROK_CWD || os.homedir(),
    });
    /** @type {WorkerSlot} */
    const w = {
      id,
      bridge,
      sessionId: null,
      cwd: cwd || bridge.cwd,
      busy: false,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    };
    this.workers.set(id, w);

    bridge.on("agent_exit", (info) => {
      w.busy = false;
      this.emit("agent_exit", {
        workerId: id,
        sessionId: w.sessionId || bridge.sessionId || null,
        ...info,
      });
    });

    bridge.on("ready", (info) => {
      if (info?.sessionId) {
        w.sessionId = info.sessionId;
        this.sessionToWorker.set(String(info.sessionId), id);
      }
      if (info?.cwd) w.cwd = info.cwd;
      this.emit("ready", { workerId: id, ...info });
    });

    bridge.on("permission_request", (req) => {
      this.emit("permission_request", { workerId: id, ...req });
    });

    console.log(`[pool] spawn ${id} (size=${this.workers.size}/${this.max}) cwd=${w.cwd}`);
    this.emit("worker_spawned", { workerId: id });
    return w;
  }

  _public(w) {
    const st = w.bridge.status();
    return {
      workerId: w.id,
      sessionId: w.sessionId || st.sessionId || null,
      cwd: w.cwd || st.cwd || null,
      busy: w.busy,
      agentAlive: st.agentAlive,
      ready: st.ready,
      isDefault: w.id === this.defaultId,
      createdAt: w.createdAt,
      lastUsedAt: w.lastUsedAt || w.createdAt,
    };
  }
}

/**
 * @typedef {{
 *   id: string,
 *   bridge: import('./acp-bridge.js').AcpBridge,
 *   sessionId: string|null,
 *   cwd: string|null,
 *   busy: boolean,
 *   createdAt: number,
 *   lastUsedAt: number,
 * }} WorkerSlot
 */
