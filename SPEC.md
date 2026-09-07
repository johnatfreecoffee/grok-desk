# Spec: Session truth — Desk mirrors the terminal exactly

Grok Desk stops keeping its own copy of the truth. `~/.grok/sessions/<urlenc-cwd>/<id>/`
becomes the single source of truth and Desk becomes a **cursor-based projection** of it.

Shipped-and-locked scope from v0.2.0 (one product: Speak, Folders, Phone connector) is in
`docs/SPEC-one-product-v0.2.0.md`. It stays working; it is not re-opened here.

## Done

- Every chat in Desk is a projection of `~/.grok/sessions/<cwd>/<id>/` and shows the same
  content as the terminal: user turns, reply text, thinking, tool calls with status, plan,
  subagents, context usage.
- Leaving a chat and returning — desktop or phone, mid-turn or idle — resumes exactly where
  it left off, nothing missing, nothing duplicated. Same for closing/reopening the PWA and
  for a full page reload.
- A session running in the **terminal** appears live in Desk and streams as it happens.
  Read-only while a live pid owns it, and the UI says so. Sendable once that process exits.
- Two or more chats stream at once; acting on one never disturbs another. `stop` only stops
  the session it names.
- A subagent strip at the top of a chat shows every subagent for that session — type,
  description, status, duration, tool count — and opens the child session.
- Full history is reachable: no silent 4000 / 8000 / 200-row cut, no duplicate-content drops.
- No turn is ever killed by a Desk timer.
- Desk never causes the CLI to lose turns (no `chat_history.jsonl` clobber).

## Not doing

- Leader mode / a shared `grok agent` backend between TUI and Desk (`~/.grok/leader.sock`).
- Writing into `~/.grok/sessions` beyond what the spawned `grok agent` already writes.
  Delete stays the only Desk-initiated write, and it gains an ownership guard.
- A UI redesign. Existing Desk chrome, dark / blue.
- **Purple / violet / indigo / fuchsia.** Grok marks stay blue.
- New PARITY rows: `/compact`, `/rewind` file restore, `/memory`, `/hooks` stay 🟡.
- Rewriting the ACP bridge's *send* path. It stays how prompts go out.
- Cloud, Supabase, Cloudflare. Local only.
- App Store / payment listing (human gate).

## Accept

- `npm run test:feed` — projector unit tests over real fixture session dirs: cursor resume,
  monotonic seq, no dupes, no drops, torn-line tolerance, ownership detection.
- `npm run smoke:switch` — leave A mid-turn, open B, prompt B, return to A mid-turn. A's
  stream is complete and still running; B unaffected.
- `npm run smoke:reload` — drop the WS mid-turn, reconnect at cursor. Content, thinking and
  tools all survive and the turn completes.
- `npm run smoke:cli` — start a session in a real terminal `grok`, prompt it. Desk's feed
  matches that session's `updates.jsonl` in content, live within 1 s, and Desk refuses to
  `session/load` it while its pid is alive.
- Existing `smoke`, `smoke:turns`, `smoke:isolation`, `smoke:resume`, `test:speak`,
  `test:auto` green. `test:store` rewritten against the code that actually ships, and wired
  into CI alongside `test:feed`.
- No WS frame reaches the client without a `sessionId`.
- Sending the same short message twice keeps both.
- Sidebar poll plus a live turn stay under 5% CPU with ~950 sessions on disk.
- Hunt at desktop ~1280 · tablet ~768 portrait + ~1024 landscape · phone ~390, plus a
  two-client lane (Mac + phone on the same chat) and a CLI-concurrency lane. One full run,
  zero findings.

## Keep

- Local lock (AuthGate), Electron shell, Tailscale phone PWA path.
- launchd `dev.freecoffee.grok-desk`.
- ACP pool for sending prompts.
- Speak, Folders, Phone connector exactly as shipped in v0.2.0.
- Desk dark / blue. Blue Grok pill + `GrokMark` / `GrokChip`.
