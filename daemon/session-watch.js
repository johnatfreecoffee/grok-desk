/**
 * P2 — fs watchers for the session feed.
 *
 * Retires `fs.watch(sessionsRoot, { recursive: true })`, which walked ~950
 * session directories and turned every append during a live turn into a global
 * `projects_tick` (every client then re-scanned the whole sidebar).
 *
 * Two things watch now:
 *   1. ONE non-recursive watcher on ~/.grok/sessions. It only notices project
 *      groups appearing / disappearing and feeds the debounced `projects_tick`
 *      so the sidebar keeps working.
 *   2. ONE fs.watch per *subscribed* session directory, created when the first
 *      client subscribes to that session and torn down when the last one
 *      leaves. A change fires a debounced `poll(sessionId)` — the delta goes to
 *      that session's subscribers only.
 *
 * Failure is per session, never fatal: a watch that cannot be installed
 * (EMFILE, or a session dir the CLI has not created yet) degrades to a ~1 s
 * interval poll for THAT session and logs once. The daemon never dies because
 * a watcher did.
 *
 * This module never writes into ~/.grok/sessions.
 */
import fs from "node:fs";
import { findSessionDir } from "./session-store.js";

/** Coalesce a burst of appends into one push. */
const DEBOUNCE_MS = Number(process.env.DESK_FEED_DEBOUNCE_MS || 100);
/** Fallback cadence when fs.watch is unavailable for a session. */
const FALLBACK_POLL_MS = Number(process.env.DESK_FEED_POLL_MS || 1000);
/** Root watcher debounce — sidebar refresh, not a live tail. */
const ROOT_DEBOUNCE_MS = Number(process.env.DESK_ROOT_DEBOUNCE_MS || 500);

function isNoise(filename) {
  if (!filename) return false;
  const f = String(filename);
  return f.endsWith(".lock") || f.endsWith(".tmp") || f === ".DS_Store";
}

/** Direct children of the sessions root — one entry per project group. */
function groupNames(root) {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort()
      .join("\n");
  } catch {
    return "";
  }
}

/**
 * One cheap watcher on the sessions root, for project groups only.
 *
 * `recursive: false` is not enough on its own: on macOS Node's fs.watch is
 * FSEvents-backed and still reports changes deep inside the tree, which would
 * put us right back to a global tick on every append during a live turn. So the
 * callback re-lists the root's direct children (87 entries — cheap) and only
 * fires when that set actually changed. Everything else is somebody's session
 * appending, and that belongs to a per-session watcher.
 *
 * @param {{ root: string, onChange: () => void, debounceMs?: number }} opts
 * @returns {{ close: () => void, ok: boolean, groups: () => number }}
 */
export function startRootWatcher({ root, onChange, debounceMs = ROOT_DEBOUNCE_MS }) {
  let timer = null;
  let known = groupNames(root);
  const fire = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      const now = groupNames(root);
      if (now === known) return; // a session appended; not a group change
      known = now;
      try {
        onChange();
      } catch (e) {
        console.warn("[watch] root onChange failed:", e.message);
      }
    }, debounceMs);
  };
  let watcher = null;
  try {
    watcher = fs.watch(root, { recursive: false }, (_ev, filename) => {
      if (isNoise(filename)) return;
      fire();
    });
    watcher.on("error", (e) => console.warn("[watch] root watcher error:", e.message));
  } catch (e) {
    console.warn("[watch] root watch failed:", e.message);
  }
  return {
    ok: Boolean(watcher),
    groups: () => (known ? known.split("\n").length : 0),
    close() {
      if (timer) clearTimeout(timer);
      timer = null;
      try {
        watcher?.close();
      } catch {
        /* */
      }
    },
  };
}

/**
 * Per-session watcher pool. Membership is driven entirely by
 * `sync(subscribedSessions())` — nothing here decides what to watch.
 */
export class SessionWatchers {
  /**
   * @param {{
   *   onFire: (sessionId: string) => void,
   *   resolveDir?: (sessionId: string) => string|null,
   *   debounceMs?: number,
   *   pollMs?: number,
   * }} opts
   */
  constructor({ onFire, resolveDir, debounceMs = DEBOUNCE_MS, pollMs = FALLBACK_POLL_MS } = {}) {
    if (typeof onFire !== "function") throw new TypeError("SessionWatchers needs onFire");
    this.onFire = onFire;
    this.resolveDir = resolveDir || ((id) => findSessionDir(id));
    this.debounceMs = debounceMs;
    this.pollMs = pollMs;
    /** sessionId → { dir, watcher, timer, interval, degraded, logged } */
    this.entries = new Map();
    this._emfileLogged = false;
  }

  /** Reconcile the watcher set against the ids that actually have subscribers. */
  sync(ids) {
    const want = new Set((ids || []).map(String));
    for (const id of [...this.entries.keys()]) {
      if (!want.has(id)) this.remove(id);
    }
    for (const id of want) {
      if (!this.entries.has(id)) this.add(id);
      else this._upgrade(id);
    }
    return this.stats();
  }

  has(sessionId) {
    return this.entries.has(String(sessionId));
  }

  add(sessionId) {
    const id = String(sessionId);
    if (this.entries.has(id)) return;
    const entry = { dir: null, watcher: null, timer: null, interval: null, degraded: false };
    this.entries.set(id, entry);
    this._attach(id, entry);
  }

  remove(sessionId) {
    const id = String(sessionId);
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.entries.delete(id);
    this._detach(entry);
    return true;
  }

  stopAll() {
    for (const entry of this.entries.values()) this._detach(entry);
    this.entries.clear();
  }

  stats() {
    let watched = 0;
    let degraded = 0;
    for (const e of this.entries.values()) {
      if (e.watcher) watched += 1;
      if (e.degraded) degraded += 1;
    }
    return { sessions: this.entries.size, watched, degraded };
  }

  /* ------------------------------------------------------------- internals */

  _detach(entry) {
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.interval) clearInterval(entry.interval);
    entry.timer = null;
    entry.interval = null;
    try {
      entry.watcher?.close();
    } catch {
      /* */
    }
    entry.watcher = null;
  }

  /** Install a real fs.watch, or degrade this session to an interval poll. */
  _attach(id, entry) {
    let dir = null;
    try {
      dir = this.resolveDir(id);
    } catch {
      dir = null;
    }
    if (!dir) {
      // The CLI has not created the dir yet (brand-new chat). Poll until it does.
      this._degrade(id, entry, "session dir not on disk yet");
      return;
    }
    entry.dir = dir;
    try {
      const watcher = fs.watch(dir, { recursive: false }, (_ev, filename) => {
        if (isNoise(filename)) return;
        this._kick(id);
      });
      watcher.on("error", (e) => {
        this._degrade(id, entry, `watcher error: ${e.message}`);
      });
      entry.watcher = watcher;
      if (entry.interval) {
        clearInterval(entry.interval);
        entry.interval = null;
      }
      entry.degraded = false;
    } catch (e) {
      if (e?.code === "EMFILE" && !this._emfileLogged) {
        this._emfileLogged = true;
        console.warn(
          "[watch] EMFILE — out of file handles; affected sessions fall back to interval polling",
        );
      }
      this._degrade(id, entry, e.message || String(e));
    }
  }

  /** A degraded session retries the real watcher whenever its dir shows up. */
  _upgrade(id) {
    const entry = this.entries.get(id);
    if (!entry || entry.watcher) return;
    this._attach(id, entry);
  }

  _degrade(id, entry, why) {
    entry.degraded = true;
    if (!entry.logged) {
      entry.logged = true;
      console.warn(`[watch] ${String(id).slice(0, 8)} → interval poll (${why})`);
    }
    if (entry.interval) return;
    entry.interval = setInterval(() => {
      // Try to graduate back to a real watcher once the dir exists.
      if (!entry.watcher) {
        let dir = null;
        try {
          dir = this.resolveDir(id);
        } catch {
          dir = null;
        }
        if (dir && dir !== entry.dir) {
          entry.dir = dir;
          this._attach(id, entry);
        } else if (dir && !entry.dir) {
          this._attach(id, entry);
        }
      }
      this._fire(id);
    }, this.pollMs);
    if (typeof entry.interval.unref === "function") entry.interval.unref();
  }

  /**
   * Throttle: the first change schedules one fire; every change inside that
   * window is absorbed. Bounded latency, at most 1 push per debounce window.
   */
  _kick(id) {
    const entry = this.entries.get(id);
    if (!entry || entry.timer) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      this._fire(id);
    }, this.debounceMs);
    if (typeof entry.timer.unref === "function") entry.timer.unref();
  }

  _fire(id) {
    if (!this.entries.has(id)) return;
    try {
      this.onFire(id);
    } catch (e) {
      console.warn(`[watch] poll ${String(id).slice(0, 8)} failed:`, e.message);
    }
  }
}
