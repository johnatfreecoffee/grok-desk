# Spec: One product — Grok Desk

Grok Folders, grok-speak, and grok-phone-mcp collapse into **Grok Desk**. One install, one repo, one Settings pane. Sellable as a single local Mac product.

## Done

- Installing / running Grok Desk is enough. No sibling `~/Documents/grok-speak`, `grok-folders`, or `grok-phone-mcp` required for Speak, the menu-bar folder launcher, or the grok.com phone connector.
- **Speak** engine lives in this repo (`tools/speak/`). Desk synthesizes via the bundled `grok-speak` binary. TUI `/speak` can be installed from Settings. Existing per-reply Concise / Casual / Full + player still works. Prefs stay `~/.grok/speak.toml`.
- **Folders** is a native macOS menu-bar extra bundled here (`native/folders/`). Same NSMenu behavior as today’s Grok Folders (comet, Terminal icon, hover-dwell, recents, never above `$HOME`). Desk Settings turns it on/off and sets hover / default open / root. Existing `~/Library/Application Support/GrokFolders/state.json` is reused.
- **Phone connector** (grok.com MCP) is vendored here (`tools/phone-mcp/`). Local Streamable HTTP MCP on port 3311, token in `~/.grok/phone-mcp/token`. Desk Settings: enable/disable, health, copy URL, copy/rotate token. John’s existing Cloudflare tunnel (`https://grok-mcp.freecoffee.dev`) keeps working if already installed; public URL is a setting, not hardcoded as the only path.
- Settings modal has three first-class sections, same chrome as Speak / Phone push today: **Speak**, **Folders**, **Phone connector**.
- README / package.json present one product. Old Documents folders become stubs that point here.

## Not doing

- Porting Folders to an Electron Tray / HTML popover. Native `NSMenu` stays.
- Rewriting Speak from Python to Node.
- Merging the MCP HTTP server onto Desk’s `:8787` (grok.com needs a dedicated MCP URL; keep `:3311`).
- Building a multi-tenant cloud MCP / SaaS.
- Auto-speaking every reply.
- Changing TUI `/speak` semantics.
- App Store / payment listing (human gate after this factory).
- Deleting GitHub history of grok-speak. Stub + redirect only.
- Purple / violet / indigo / fuchsia.

## Accept

- `speakBin()` resolves `tools/speak/bin/grok-speak` (repo-relative) before `~/.grok/bin/grok-speak` and before `~/Documents/grok-speak`.
- `npm run test:speak` green. `npm run build` green.
- Folders: Settings enable → comet in the menu bar; disable → quit + unload launch agent. Hover and “open with Grok vs Terminal” persist in existing state.json.
- Phone connector: Settings enable → `http://127.0.0.1:3311/health` ok; disable → stop launch agent. Token never shown in full in the UI after first copy (masked; copy/rotate only).
- Settings at desktop + ~390 phone. Existing `settings-section` / `field` / `modal-hint` chrome. No new layout language.
- Old repos: `~/Documents/grok-speak`, `grok-folders`, `grok-phone-mcp` README-only stubs pointing at grok-desk. Do not delete git remotes.
- Ship `main` on github.com/johnatfreecoffee/grok-desk.

## Keep

- Local lock (AuthGate). Electron + PWA + ACP pool.
- Desk dark / blue. No purple.
- Existing Speak player on replies (subscription OAuth, no API key).
- Tailscale phone PWA path.
- Desk launchd `dev.freecoffee.grok-desk`.
- Folders bundle id `dev.freecoffee.GrokFolders` so an already-installed extra keeps working.
- Phone MCP tools: `grok_sessions_list` `grok_sessions_search` `grok_session_get` `grok_run` `grok_reply` `grok_job_status` `grok_inspect`. cwd rooted in `~/Documents`.
- Optional xAI API-key realtime mic if a key is already set (do not resurrect it as required).
