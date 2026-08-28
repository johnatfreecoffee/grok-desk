# Spec: Speak in Desk + same CLI session

## Done
- Opening a Grok CLI/TUI chat in Desk (Mac or phone) is **that same session**. Send stays on the same `sessionId`. Never `session/new` because ACP resume was slow or `history_only`.
- Each finished assistant reply has **Concise / Casual / Full** plus a mini player (play/pause, ±15s, scrub, speed).
- Speak uses **subscription OAuth** (`grok-speak` → `POST /v1/tts` via `~/.grok/auth.json`). No console API key required.
- Composer **dictation** is TUI `/voice` (Grok STT + login). No API-key realtime mic. No API key in Settings.

## Not doing
- Porting Grok Speak.app (Swift) into Electron.
- Replacing the optional realtime mic with TTS.
- Auto-speaking every reply.
- Changing TUI `/speak` (CLI skill stays).

## Accept
- Click a CLI session in the sidebar → history of **that** id. Send continues **that** id (same `chat_history.jsonl`).
- Banner never says “fresh turn” for a real session id.
- Concise/Casual/Full on a reply plays Grok voice; repeat uses the cached clip.
- Phone PWA (~390) shows the same buttons + player.
- `npm run build` green. Smoke: isolation + new resume harness.

## Keep
- Local lock (AuthGate).
- Electron + PWA + ACP pool.
- Desk dark / blue. No purple.
- Optional API-key realtime mic if a key is already set.
