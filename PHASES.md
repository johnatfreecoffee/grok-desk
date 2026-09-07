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

- [ ] **P1 Feed projector** — `daemon/session-feed.js`
  - Cursor `{updatesBytes, eventsBytes, seq}`; `seq` from `_meta.eventId` suffix
  - Incremental tail from byte offset; hold a trailing partial line (torn CLI appends)
  - Normalize `updates.jsonl` + `events.jsonl` → one ordered `FeedEvent[]`
  - Derived, no timers: `live`, `phase`, `owner` (`~/.grok/active_sessions.json` + pid probe),
    `context` (`signals.json`), `subagents`
  - `GET /api/sessions/:id/feed?from=` · `scripts/feed-unit.mjs`
  - Proof: `npm run test:feed`; feed of a real 4 MB `updates.jsonl` equals a full parse and
    resumes from an arbitrary seq

- [ ] **P2 Per-session live tail + protocol**
  - Per-session watchers + one cheap root watcher; retire the recursive tree watch
  - WS `subscribe` / `unsubscribe` / `feed`
  - Stamp `sessionId` on every daemon→client frame; scope `stop`, `queue_update`, `error`
    and the `*_resolved` frames
  - Proof: CLI-side turn visible in the feed < 1 s; no frame without `sessionId`; `stop`
    from the phone leaves the Mac's other turn running

- [ ] **P3 Client projection** — `web/src/lib/sessionFeed.ts`
  - App renders from the feed; cursor in `localStorage`; resubscribe on visibility + reconnect
  - Delete the dead `lib/sessionStore.ts` layer and the four divergent finalize paths
  - Rewrite `scripts/session-store-unit.mjs` against the code that ships
  - Proof: `npm run smoke:switch` · `npm run smoke:reload`; sending "ok" twice keeps both

- [ ] **P4 Ownership + no clobber**
  - Read `active_sessions.json`; refuse `session/load` while a live pid owns the session
  - "Running in Terminal" state, read-only composer, auto-takeover when the pid exits
  - Ownership guard on `deleteSession`
  - Proof: `npm run smoke:cli`; a terminal turn during a Desk view loses nothing either side

- [ ] **P5 Retire the shadow stores**
  - Delete the 18 m wall / 6 m stall auto-abandon; stalled turn = badge + manual Stop
  - Stop writing `desk-messages.json` (read-only legacy fallback)
  - Fix the dead `desk-index` prune (`idx.sessions` vs `idx.sessionIds`); atomic writes
  - Replace the 4000 / 8000 / 200-row truncation with a tail window + "load earlier"
  - Proof: a > 18 min turn completes untouched; full history reachable

- [ ] **P6 Terminal fidelity**
  - Subagent strip at the top of the chat: type, description, status, duration, tools;
    opens the child session; shows `output.json`
  - Real tool status from `events.jsonl`; context meter from `signals.json`
  - Background task output from `background_tasks_manifest.json` + `terminal/*.log`
  - Surface `session_kind: headless`; real toggle for `showSubagentSessions`
  - Proof: side by side with a live terminal session — same content, order, subagents

- [ ] **P7 Scale + PWA**
  - Kill the O(n²) `pruneSubagentsFromDeskIndex` / `isSubagentSession` per poll
  - Tailscale HTTPS so the service worker + Web Push actually register on the phone
    (`http://...ts.net` is not a secure context; the vite-plugin-pwa manifest is already fine)
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

- [ ] One full hunt with zero findings
- [ ] Ship `main`, rebuild UI, kick launchd
