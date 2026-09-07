# Grok Desk — one product (Folders + Speak + Phone MCP)

Order: **Build P1–P4 → UI match → Hunt → Clean run**.

Machine: this Mac. Spec: `~/Documents/grok-desk/SPEC.md`. If it is not in the spec it does not exist.

## Build

- [x] **P1 Speak vendor** — engine in-repo, Settings TUI install
  - Copy grok-speak into `tools/speak/` (bin, commands, skills, hooks, install.sh, speak.toml.example)
  - `daemon/speak.js` `speakBin()` prefers repo `tools/speak/bin/grok-speak`
  - Settings Speak: ready status + “Install TUI /speak” (runs tools/speak/scripts/install.sh)
  - Proof: `npm run test:speak` · `speakBin()` does not need `~/Documents/grok-speak`

- [x] **P2 Folders into Desk** — native extra + Settings
  - Copy grok-folders into `native/folders/` (Sources, Resources, scripts)
  - `daemon/folders.js` + `/api/folders` GET/POST (enabled, hover, defaultOpen, lastPath, install/uninstall)
  - `web/src/components/settings/FoldersSettings.tsx` — Settings section after Speak
  - Reuse `~/Library/Application Support/GrokFolders/state.json` and launchd `dev.freecoffee.GrokFolders`
  - Proof: enable via API → comet in menu bar; disable → gone; existing state preserved

- [x] **P3 Phone connector into Desk** — MCP + Settings
  - Copy grok-phone-mcp into `tools/phone-mcp/` (server.mjs, package.json, start/install scripts)
  - `daemon/phone-mcp.js` + `/api/phone-mcp` GET/POST (enabled, health, publicUrl, token masked, rotate)
  - `web/src/components/settings/PhoneConnectorSettings.tsx` — Settings section
  - Keep port 3311, token file, tools list, cwd allowlist. Do not move MCP onto :8787
  - Public URL is a setting (default John’s tunnel if present)
  - Proof: enable → `/health` 200; disable → stopped; rotate token writes new file

- [x] **P4 One-product wrap**
  - README + package.json description = one product
  - moduleHelp Settings copy includes Folders + Phone connector
  - `make-app` / `always-on` install Speak bin + Folders extra when enabled in settings
  - Version `0.2.0`
  - Stub old Documents repos (README only, point here)
  - Proof: README lists Speak / Folders / Phone connector; old repos have no source left

## UI match

- [ ] Settings Speak / Folders / Phone connector match existing `settings-section` chrome
- [ ] Desktop ~1280 + tablet ~768/1024 + phone ~390. Tap ≥ 40px. No purple.

## Hunt

- [ ] Console / network / frontend / backend / broken-path
- [ ] Speak synthesize still works without sibling repo
- [ ] Folders enable/disable
- [ ] Phone MCP health + token mask

## Clean run

- [ ] One hunt with zero findings
- [ ] Ship `main`, rebuild UI, kick launchd
