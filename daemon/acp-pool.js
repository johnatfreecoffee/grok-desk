/**
 * Multi-worker ACP pool — N independent `grok agent stdio` processes.
 * Each worker owns at most one live ACP session at a time.
 * Never touches the global turn controller; index.js owns busy/queues.
 */
import { EventEmitter } from "node:events";
import os from "node:os";
import { AcpBridge } from "./acp-bridge.js";

const DEFAULT_MAX = Number(process.env.DESK_MAX_WORKERS || 4);

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
    const boot = this._spawn(opts.cwd || process.env.GROK_CWD || os.homedir());
    this.defaultId = boot.id;
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
      w = this._spawn();
      this.defaultId = w.id;
    }
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
    if (sessionId) {
      const bound = this.findBySession(sessionId);
      if (bound) return bound;
    }

    if (preferFree) {
      // Prefer idle workers with no session (fresh)
      for (const w of this.workers.values()) {
        if (!w.busy && !w.bridge.sessionId && !w.sessionId) {
          if (cwd) w.bridge.cwd = cwd;
          return w;
        }
      }
      // Idle worker that can be rebound
      for (const w of this.workers.values()) {
        if (!w.busy) {
          if (cwd) w.bridge.cwd = cwd;
          return w;
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
    if (worker) worker.busy = Boolean(busy);
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
    try {
      w.bridge.stop();
    } catch {
      /* */
    }
    this.workers.delete(workerId);
    if (workerId === this.defaultId) {
      if (this.workers.size > 0) {
        this.defaultId = [...this.workers.keys()][0];
      } else if (restartDefault) {
        const nw = this._spawn();
        this.defaultId = nw.id;
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
    await w.bridge.ensure();
    return this.status();
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
 * }} WorkerSlot
 */
