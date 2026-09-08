# Grok Desk — session truth (Desk mirrors the terminal exactly)

Order: **Build P0–P7 → UI match → Hunt → Clean run**.

Machine: this Mac. Spec: `~/Documents/grok-desk/SPEC.md`. If it is not in the spec it does
not exist. Prior factory (one product v0.2.0) is closed — see `docs/SPEC-one-product-v0.2.0.md`.

## Build

- [x] **P0 Stop the bleeding** — four surgical client fixes, no architecture change
  - `web/src/App.tsx:1870` — take `mergeArtifacts` out of the connect-effect deps so
    toggling Artifacts / clicking a tool row mid-turn no longer tears down the WebSocket
  - `web/src/App.tsx:914-919` — restore `LAST_SESSION_KEY` on `hello` even when a turn is
    active (today reopening the PWA during any live turn lands you on the bridge session)
  - `web/src/App.tsx:2813-2819` — drop the `|| Boolean(liveSid)` tautology in `openSession`
    that forces `viewOnly` and permanently skips `resetTurnUi()`
  - `web/src/App.tsx:1474-1478` — remove the `?? draft` fallback in `onUpdate` that lets a
    foreign session's chunks mutate the viewed session's draft in place
  - Proof: click a tool mid-turn → socket stays up, stream continues. Reopen the PWA during
    a live turn → back on the chat you were reading.

- [x] **P1 Feed projector** — `daemon/session-feed.js`
  - Cursor `{updatesBytes, eventsBytes, seq}`; `seq` from `_meta.eventId` suffix
  - Incremental tail from byte offset; hold a trailing partial line (torn CLI appends)
  - Normalize `updates.jsonl` + `events.jsonl` → one ordered `FeedEvent[]`
  - Derived, no timers: `live`, `phase`, `owner` (`~/.grok/active_sessions.json` + pid probe),
    `context` (`signals.json`), `subagents`
  - `GET /api/sessions/:id/feed?from=` · `scripts/feed-unit.mjs`
  - Proof: `npm run test:feed`; feed of a real 4 MB `updates.jsonl` equals a full parse and
    resumes from an arbitrary seq

- [x] **P2 Per-session live tail + protocol**
  - Per-session watchers + one cheap root watcher; retire the recursive tree watch
  - WS `subscribe` / `unsubscribe` / `feed`
  - Stamp `sessionId` on every daemon→client frame; scope `stop`, `queue_update`, `error`
    and the `*_resolved` frames
  - Fix `turnSnapshot()` (`daemon/index.js:933-936`): `turnActive` is
    `globalBusy || parallelTurns.size > 0` but `activeSessionId` falls back to
    `bridge.sessionId`, so a parallel-only turn reports a session that is not live and the
    client marks the wrong chat "working"
  - Coalesce `phase_changed` before it reaches the wire — it is 88% of all events
    (163,785 of 186,302 swept; one session had 2,527)
  - Gate the UI's live/"working" state on **`live && owner`**, not `live` alone: 56 of 958
    sessions carry a `turn_started` with no `turn_ended` from a CLI that died mid-turn
  - Proof: CLI-side turn visible in the feed < 1 s; no frame without `sessionId`; `stop`
    from the phone leaves the Mac's other turn running; a crashed-mid-turn session does not
    show as working

- [x] **P3 Client projection** — `web/src/lib/sessionFeed.ts`
  - App renders from the feed; cursor in `localStorage`; resubscribe on visibility + reconnect
  - Delete the dead `lib/sessionStore.ts` layer and the four divergent finalize paths
  - Rewrite `scripts/session-store-unit.mjs` against the code that ships
  - Proof: `npm run smoke:switch` · `npm run smoke:reload`; sending "ok" twice keeps both

- [ ] **P4 Ownership + no clobber**
  - Read `active_sessions.json`; refuse `session/load` while a live pid owns the session
  - "Running in Terminal" state, read-only composer, auto-takeover when the pid exits
  - Ownership guard on `deleteSession`
  - **Harden `owner` (found in P2 QC).** Three real gaps in the naive pid probe:
    1. `owner` is populated even when `read()` returns `ok:false` because the session dir
       does not exist. Gate the read-only composer on `owner && ok`, never `owner` alone.
    2. The probe only asks "is this pid alive" — a recycled pid after a reboot would make a
       random process look like the owner. Verify the process is actually `grok`.
    3. Normalize cwd with `realpath` before `encodeURIComponent`. The registry recorded
       `/private/tmp/...` while the process argv said `/tmp/...`; on macOS that symlink
       mismatch makes `findSessionDir` miss.
  - **Headless `grok -p` never registers in `active_sessions.json`** (found in P3), so
    read-only never fires for headless CLI runs. Detect those another way or say plainly
    that only TUI sessions are owned.
  - `GET /api/sessions/:id/feed` omits `working` (the WS `feed` frame has it). Make the two
    payloads the same shape.
  - Proof: `npm run smoke:cli`; a terminal turn during a Desk view loses nothing either side

- [ ] **P5 Retire the shadow stores**
  - Delete the 18 m wall / 6 m stall auto-abandon; stalled turn = badge + manual Stop
  - Stop writing `desk-messages.json` (read-only legacy fallback)
  - Fix the dead `desk-index` prune (`idx.sessions` vs `idx.sessionIds`); atomic writes
  - Replace the 4000 / 8000 / 200-row truncation with a tail window + "load earlier"
  - **The daemon does not kill its ACP children on SIGTERM** — that is how a worker leaked a
    `grok` process for 16 hours holding a stale ownership entry. Reap the pool on shutdown.
  - `deliverFeed` labels each frame's `fromSeq` with `handle.lastSeq` *at send time*, which
    can run ahead of the events the frame carries when a concurrent poll advances the handle.
    P3 works around it client-side by judging a gap on evidence; fix the label at the source.
  - Proof: a > 18 min turn completes untouched; full history reachable

- [ ] **P6 Terminal fidelity**
  - Subagent strip at the top of the chat: type, description, status, duration, tools;
    opens the child session; shows `output.json`. Source is `subagent_spawned` /
    `subagent_finished` + `subagents/*/meta.json` — **not** `task_backgrounded` /
    `task_completed`, which are background *shell* tasks (they belong in the background-task
    surface instead)
  - Real tool status from `events.jsonl`; context meter from `signals.json`
  - Background task output from `background_tasks_manifest.json` + `terminal/*.log`
  - Surface `session_kind: headless`; real toggle for `showSubagentSessions`
  - Proof: side by side with a live terminal session — same content, order, subagents

- [ ] **P7 Scale + PWA**
  - Kill the O(n²) `pruneSubagentsFromDeskIndex` / `isSubagentSession` per poll
  - Everything on the phone must work over plain HTTP: reconnect, resubscribe, cursor
    resume, add-to-home-screen. That is the phase's real deliverable.
  - **Web Push is human-gated (see below).** Do not work around it.
  - Reconnect / resubscribe on iOS PWA resume
  - Proof: CPU under load; PWA installs and push arrives on the phone

## UI match

- [ ] Existing Desk chrome; no new layout language; no purple
- [ ] Desktop ~1280 · tablet ~768 portrait + ~1024 landscape · phone ~390. Tap ≥ 40px

## Hunt

- [ ] Console · Network · Frontend (all viewports) · Backend · Broken-path
- [ ] **Two-client** — Mac + phone on the same chat at once
- [ ] **CLI-concurrency** — terminal `grok` and Desk on the same session

## Clean run

- [ ] Pre-existing smokes (`smoke`, `smoke:turns`, `smoke:isolation`, `smoke:resume`) open the
      WS with no cookie, so the local lock closes them with `4401 auth required`. They must
      read the local session cookie the way `smoke:feed` does before they can gate anything.
- [ ] One full hunt with zero findings
- [ ] Ship `main`, rebuild UI, kick launchd

## Human gate — Tailscale HTTPS (Web Push only)

`tailscale cert` returns *"your Tailscale account does not support getting TLS certs"* and
`CertDomains` is empty, so the tailnet has HTTPS certificates switched off. Desk is therefore
served as `http://johns-macbook-pro.tail106bb5.ts.net`, which is **not a secure context** — so
the service worker never registers and Web Push cannot work on the phone.

Enabling it is one toggle in the Tailscale admin console (DNS → HTTPS Certificates). It needs
John's Tailscale login: there is no API key or OAuth client on this machine, and minting one
also requires that console. Routing Desk through the existing Cloudflare tunnel *would* give a
real cert, but the spec says local only, no Cloudflare — so that is not an option.

**Nothing else is blocked.** The PWA, the WebSocket, cursor resume and add-to-home-screen all
work over HTTP. Only Web Push waits on this.

After John enables it: `tailscale serve --bg --https=443 http://127.0.0.1:8787`, then confirm
the service worker registers and a push arrives.
