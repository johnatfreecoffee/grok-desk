# Grok Desk — Speak + session identity

Order: **Build P1–P2 → UI match → Hunt → Clean run**.

Machine: this Mac (Desk is local Electron/PWA).

## Build

- [x] **P1 Session identity** — CLI chat stays the same chat
  - Prompt with a real sessionId never `session/new`
  - Load even when the ACP worker has no bound id
  - Longer resume timeout; client does not fork on `history_only`
- [x] **P2 Speak** — subscription TTS on each reply
  - Daemon `/api/speak*` via `grok-speak --synthesize`
  - Per-reply Concise / Casual / Full + mini player
  - Settings voice → `speak.toml`

## UI match

- [x] Speak chips match existing `mode-chip` / `copy-reply-btn` chrome
- [x] Settings Voice section: TTS first, API key optional underneath
- [x] Desktop + ~390 mobile. No purple.

## Hunt

- [x] Console / network / frontend / backend / broken-path
- [x] Resume smoke: unbind → prompt same id → no new session
- [x] Speak settings GET without API key

## Clean run

- [x] One hunt with zero findings
- [x] Ship `main`, rebuild UI, kick launchd
