# Grok Desk

**I took Grok Build out of the terminal and gave it a real interface.**

Grok Desk is a **local** Mac product for [Grok Build](https://x.ai/build): one install, one Settings pane.

- **Desk** — visual Grok Build (Electron on Mac, installable phone PWA)
- **Speak** — subscription TTS, bundled in `tools/speak` (same Grok login, no API key)
- **Folders** — native menu-bar extra (`native/folders`) — Settings → Folders
- **Phone connector** — grok.com MCP (`tools/phone-mcp`, port 3311) — Settings → Phone connector

Same CLI agent power — multi-agent pool, skills, MCP, plugins, workflows, plan mode, question cards, worktrees — without living in a black box of green text.

This project was **built with Grok Build** (dogfooded end-to-end) and is open source so other developers can improve it.

| | |
|--|--|
| **Repo** | https://github.com/johnatfreecoffee/grok-desk |
| **License** | [MIT](LICENSE) |
| **Hosting** | **Not a cloud SaaS.** Daemon runs on your Mac (`127.0.0.1`). Phone reaches it over **Tailscale** (your private mesh), not a public backend. |

> Slash / surface parity vs the TUI: [`docs/PARITY.md`](docs/PARITY.md)

---

## How it works (simple stack)

```
┌─────────────┐     ┌─────────────┐     ┌──────────────────┐
│  Mac app    │     │  Phone PWA  │     │ grok.com Custom  │
│  (Electron) │     │  (Safari)   │     │ connector        │
└──────┬──────┘     └──────┬──────┘     └────────┬─────────┘
       │  localhost        │  Tailscale          │  token
       ▼                   ▼                     ▼
┌──────────────────────────────┐     ┌─────────────────────┐
│  Grok Desk daemon (Node)     │     │ Phone MCP :3311     │
│  http://127.0.0.1:8787       │     │ tools/phone-mcp     │
│  Speak TTS · Settings        │     │ (not Desk :8787)    │
└──────────────┬───────────────┘     └──────────┬──────────┘
               │ ACP (stdio)                    │ grok CLI jobs
               ▼                                ▼
┌──────────────────────────────────────────────────────────┐
│  grok agent  (Grok CLI)                                  │  ← your CLI login / subscription
└──────────────────────────────────────────────────────────┘

Menu bar: comet is part of Grok Desk (native NSMenu). Close the window; the comet stays. Quit Grok Desk to stop.
```

| Piece | Role |
|-------|------|
| **`web/`** | React + Vite PWA UI (chat, modules, mobile layout) |
| **`daemon/`** | Local Node server: serves UI, WebSocket bridge, multi-agent pool, push, radar |
| **`desktop/`** | Electron shell that opens the UI and keeps the engine handy |
| **`tools/speak/`** | Bundled Speak TTS (`grok-speak`). Prefs: `~/.grok/speak.toml` |
| **`native/folders/`** | Native macOS menu-bar extra. Enable in Settings → Folders |
| **`tools/phone-mcp/`** | grok.com Streamable HTTP MCP on port 3311. Enable in Settings → Phone connector |
| **Grok CLI** | Real agent (`grok agent stdio`). Desk does **not** reimplement the model stack |
| **Tailscale** | Optional: phone reaches *your* Mac over a private mesh (no public port forward for the usual setup) |
| **Voice (optional)** | xAI realtime mic if you already set `XAI_API_KEY` in `.env` / Settings — not required |

**What is *not* in the cloud:** chat history, Desk settings, Speak prefs, Folders state, the phone-connector token, and agent sessions stay on the machine under `~/.grok` and `~/Library/Application Support/`. There is no Grok Desk multi-tenant server.

---

## Requirements

- **macOS** (primary: launchd + `.app` scripts; Linux may run the daemon with care)
- **Node.js ≥ 20**
- **[Grok CLI](https://x.ai/build)** installed and **logged in** (`grok --version` works in Terminal)
- Optional: [Tailscale](https://tailscale.com/) on Mac + phone for remote UI
- Speak TTS is **bundled** (subscription — same Grok login, no API key)
- Folders comet starts with Grok Desk (Settings can hide it). Phone connector stays off until you enable it, then Desk keeps it healthy.
- Dictation in the composer is the same as TUI `/voice` (subscription STT, no API key)

---

## Setup (detailed)

### 1. Prerequisites

```bash
node -v          # v20+
grok --version   # CLI present
# Complete Grok CLI login if you haven't (same as using the TUI)
```

### 2. Clone and install

```bash
git clone https://github.com/johnatfreecoffee/grok-desk.git
cd grok-desk
npm install
npm install --prefix web
cp .env.example .env   # optional — realtime mic / radar only
```

### 3. Build the UI and start the engine

```bash
npm run build          # builds web/ → web/dist
npm start              # starts daemon on http://127.0.0.1:8787
```

Open **http://127.0.0.1:8787** in a browser. You should see the desk; sending a message uses your Grok CLI agent.

Speak is ready from this tree (`tools/speak`). Per-reply **Concise / Casual / Full** on a message. Settings → Speak installs TUI `/speak` if you want it in the CLI too.

### 4. Mac desktop app (optional)

```bash
npm run make-app
open -a "Grok Desk"
# also installs/copies to ~/Applications when the script succeeds
# installs the Speak binary; rebuilds Folders / Phone MCP only if you already enabled them
```

### 5. Always-on engine (optional, recommended)

Keeps the daemon running after reboots / closed windows (user launchd):

```bash
./scripts/install-launchd.sh
# UI: http://127.0.0.1:8787
# Stop: launchctl bootout gui/$(id -u)/dev.freecoffee.grok-desk
```

Same rule: Speak bin is installed; Folders extra and Phone MCP are **not** auto-enabled.

### 6. Phone = same app, same machine (Tailscale)

Nothing is “hosted in the cloud” for chat. The phone is a **remote window** onto the daemon on your Mac.

1. Install **Tailscale** on the Mac and the phone; sign into the **same** tailnet.
2. Mac: engine running (`npm start` or launchd).
3. On the Mac:

```bash
./scripts/phone-serve.sh
```

That script starts/ensures launchd and turns on **Tailscale Serve** so your phone can open a MagicDNS URL to port `8787`.

4. **iPhone:** Tailscale app **on** → Safari → URL the script printed → Share → **Add to Home Screen**.
5. Prefer **HTTPS** Serve (required for installable PWA + Web Push). If Serve isn’t enabled yet, open the enable link the script prints, then re-run it.
6. Away from home: Tailscale mesh works over LTE; **Mac must be awake and online**.

**Security note:** Prefer Tailscale over opening `8787` on your router. The daemon binds **localhost** by default; Tailscale Serve is the supported remote path.

### 7. Folders (menu bar)

Settings → **Folders** → enable. A Grok comet appears in the menu bar. Click a folder to open it in Grok Build or Terminal. Hover-dwell and “open with” persist in `~/Library/Application Support/GrokFolders/state.json`. Never walks above `$HOME`.

### 8. Phone connector (grok.com)

Settings → **Phone connector** → enable. Local Streamable HTTP MCP on **port 3311**, token in `~/.grok/phone-mcp/token`. Copy URL / token (token is masked after first copy; rotate from Settings). Add a custom connector in [grok.com/connectors](https://grok.com/connectors). An existing Cloudflare tunnel keeps working if you already installed one; the public URL is a setting, not the only path.

### 9. Optional config (`.env`)

See [`.env.example`](.env.example). Common:

| Variable | Purpose |
|----------|---------|
| `XAI_API_KEY` | Optional realtime mic only — not required for Speak |
| `PORT` | Default `8787` |
| `RADAR_DIGEST_TO` / `RESEND_API_KEY` | Weekly feature-radar email (optional) |

**Never commit `.env`.** Prefs and push keys also live under Application Support (gitignored).

---

## Dev workflow

```bash
npm run dev            # UI + daemon for development
npm run smoke          # harness (needs daemon + grok)
npm run smoke:turns    # turn resilience checks
```

| Path | Role |
|------|------|
| `desktop/` | Electron shell |
| `daemon/` | Engine (HTTP, WS, ACP pool, push, radar) |
| `web/` | React PWA |
| `tools/speak/` | Bundled Speak TTS |
| `native/folders/` | Native Folders extra |
| `tools/phone-mcp/` | grok.com phone MCP (:3311) |
| `scripts/` | launchd, app bundle, phone serve, smoke |
| `docs/PARITY.md` | What still needs TUI parity |

---

## Contributing (we want this)

PRs and issues are welcome — especially:

- Closing rows in [`docs/PARITY.md`](docs/PARITY.md)
- Mobile UX / reliability
- Docs and setup for non-Mac platforms

**How collaboration works (high level):**

1. You **fork** the repo (your copy).
2. You open a **branch**, make changes, push to *your* fork.
3. You open a **Pull Request** into this repo.
4. **CI** runs (build + basic checks) — see `.github/workflows/ci.yml`.
5. Maintainers **review** before anything lands on `main`. Random people cannot push straight to `main` without access.
6. Secrets never belong in git (see [SECURITY.md](SECURITY.md) / [CONTRIBUTING.md](CONTRIBUTING.md)).

Full contributor guide: **[CONTRIBUTING.md](CONTRIBUTING.md)**.

---

## Security model (users)

- Daemon listens on **`127.0.0.1` only** — not the open internet by default
- Phone connector is a separate localhost MCP (`:3311`); the token is the lock
- Sessions/secrets stay on **your** disk
- Tool permission modes: Ask / Auto / YOLO (phone can default YOLO)
- Agent tools can edit files and run shell **when you allow them** — treat this like giving Grok Build itself access

Report vulnerabilities privately when possible: [SECURITY.md](SECURITY.md).

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Port in use | `lsof -ti:8787 \| xargs kill` then `npm start` |
| Agent not ready | `grok --version` + CLI login in Terminal first |
| Blank UI | `npm run build --prefix web`, restart daemon |
| Phone can’t connect | Mac awake; Tailscale on both; re-run `./scripts/phone-serve.sh` |
| Speak missing | Settings → Speak → Install TUI `/speak`; confirm `grok login` |
| Folders comet gone | Settings → Folders → enable |
| Phone MCP down | Settings → Phone connector → enable; `curl -sS http://127.0.0.1:3311/health` |
| Realtime mic missing | `XAI_API_KEY` in `.env` or Settings (optional; Speak does not need it) |
| Stream “stuck” green on phone | Hard-refresh PWA; ensure latest `main` and daemon restarted |

---

## License

[MIT](LICENSE) — use it, fork it, ship improvements.

## Disclaimer

Grok Desk is an **unofficial** community client for the Grok Build CLI. Grok, xAI, and related marks belong to their owners. Not affiliated with or endorsed by xAI.
