# Grok Desk

**Local visual desk for [Grok Build](https://x.ai/build)** — Electron + PWA UI over a Node daemon that drives `grok agent stdio` (ACP).

Not a terminal. Not a Slack clone. A monitor-first surface for multi-agent work: chat, skills, MCP, plugins, workflows, plan mode, question cards, worktrees, and more — with phone PWA over Tailscale optional.

| Layer | What |
|-------|------|
| **Text** | Grok CLI agent (your CLI login — no cloud Desk backend) |
| **Voice** | Optional xAI realtime mic (needs `XAI_API_KEY`) |
| **Phone** | Same UI via Tailscale Serve + optional Web Push |
| **UI** | Vite/React PWA — sky/blue accents only |

> **Parity:** see [`docs/PARITY.md`](docs/PARITY.md) for slash/command coverage vs Grok Build TUI.

## Requirements

- macOS (launchd + Electron app scripts are Mac-first; Linux/WSL daemon may work)
- Node.js **≥ 20**
- [Grok CLI](https://x.ai/build) installed and logged in (`~/.grok/bin/grok`)

## Quick start

```bash
git clone https://github.com/johnatfreecoffee/grok-desk.git
cd grok-desk
npm install
npm install --prefix web
cp .env.example .env   # optional voice / radar
npm run build
npm start              # → http://127.0.0.1:8787
```

### Desktop app (macOS)

```bash
npm run make-app
open -a "Grok Desk"   # or double-click Grok Desk.app / ~/Applications
```

### Always-on engine

```bash
./scripts/install-launchd.sh
# Open http://127.0.0.1:8787
# Unload: launchctl bootout gui/$(id -u)/dev.freecoffee.grok-desk
```

### Phone PWA (Tailscale)

```bash
./scripts/phone-serve.sh
```

Mac stays the brain; phone is a remote window. iOS 16.4+ Home Screen install + HTTPS (Tailscale Serve) for push.

## Dev

```bash
npm run dev            # vite + daemon
npm run smoke          # desk harness (needs daemon + grok)
npm run smoke:turns    # turn-resilience harness
```

## Layout

| Path | Role |
|------|------|
| `desktop/` | Electron shell |
| `daemon/` | HTTP + WebSocket + ACP pool + push + radar |
| `web/` | React PWA UI |
| `scripts/` | launchd, app bundle, phone serve, smoke |
| `docs/PARITY.md` | Build TUI ↔ Desk checklist |
| `.env.example` | Optional env vars |

## Configuration

- **Desk prefs / VAPID / voice key:** `~/Library/Application Support/GrokDesk/`
- **Grok sessions / skills / MCP:** `~/.grok/`
- **Optional `.env`:** `XAI_API_KEY`, `PORT`, `RESEND_API_KEY`, `RADAR_DIGEST_TO`, …

Copy `.env.example` → `.env`. **Never commit `.env`.**

## Security model

- Daemon binds **localhost only** (`127.0.0.1:8787`)
- No Desk cloud DB; sessions stay on your machine
- Tool permissions: Ask / Auto / YOLO chips (phone can default YOLO)
- Radar email / push are opt-in and env-configured



## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Port in use | `lsof -ti:8787 \| xargs kill` then `npm start` |
| Agent not ready | Confirm `grok --version` and CLI login work in a terminal |
| Blank UI | `npm run build --prefix web` then restart daemon |
| Phone can’t connect | Mac awake, Tailscale on both devices, re-run `./scripts/phone-serve.sh` |
| Voice missing | Set `XAI_API_KEY` in `.env` or Settings |

## Install checklist

1. Install [Node 20+](https://nodejs.org/) and [Grok CLI](https://x.ai/build); complete CLI login  
2. Clone this repo  
3. `npm install && npm install --prefix web && npm run build`  
4. `npm start` → open http://127.0.0.1:8787  
5. (Optional) `npm run make-app` for the Mac menubar app · `./scripts/install-launchd.sh` for always-on  

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Issues and PRs welcome — especially closing remaining rows in `docs/PARITY.md`.

## License

[MIT](LICENSE)

## Disclaimer

Grok Desk is an unofficial community client for the Grok Build CLI. Grok, xAI, and related marks are property of their owners. This project is not affiliated with or endorsed by xAI.
