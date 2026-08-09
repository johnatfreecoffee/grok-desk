# Grok Desk

**I took Grok Build out of the terminal and gave it a real interface.**

Grok Desk is a **local** visual desk for [Grok Build](https://x.ai/build): Electron on Mac, installable phone PWA, one shared engine on *your* machine. Same CLI agent power — multi-agent pool, skills, MCP, plugins, workflows, plan mode, question cards, worktrees — without living in a black box of green text.

This project was **built with Grok Build** (dogfooded end-to-end) and is open source so other developers can improve it.

| | |
|--|--|
| **Repo** | https://github.com/johnatfreecoffee/grok-desk |
| **License** | [MIT](LICENSE) |
| **Hosting** | **Not a cloud app.** Daemon runs on your Mac (`127.0.0.1`). Phone reaches it over **Tailscale** (your private mesh), not a public SaaS backend. |

> Slash / surface parity vs the TUI: [`docs/PARITY.md`](docs/PARITY.md)

---

## How it works (simple stack)

```
┌─────────────┐     ┌─────────────┐
│  Mac app    │     │  Phone PWA  │
│  (Electron) │     │  (Safari)   │
└──────┬──────┘     └──────┬──────┘
       │  localhost        │  Tailscale → your Mac
       ▼                   ▼
┌──────────────────────────────────┐
│  Grok Desk daemon (Node)         │  ← http://127.0.0.1:8787
│  HTTP + WebSocket                │
└──────────────┬───────────────────┘
               │ ACP (stdio)
               ▼
┌──────────────────────────────────┐
│  grok agent  (Grok CLI)          │  ← your CLI login / subscription
│  sessions, tools, skills, MCP    │
└──────────────────────────────────┘
```

| Piece | Role |
|-------|------|
| **`web/`** | React + Vite PWA UI (chat, modules, mobile layout) |
| **`daemon/`** | Local Node server: serves UI, WebSocket bridge, multi-agent pool, push, radar |
| **`desktop/`** | Electron shell that opens the UI and keeps the engine handy |
| **Grok CLI** | Real agent (`grok agent stdio`). Desk does **not** reimplement the model stack |
| **Tailscale** | Optional: phone reaches *your* Mac over a private VPN-like mesh (no public port forward required for the usual setup) |
| **Voice (optional)** | xAI realtime if you set `XAI_API_KEY` in `.env` / Settings |

**What is *not* in the cloud:** chat history, Desk settings, and agent sessions stay on the machine under `~/.grok` and `~/Library/Application Support/GrokDesk/`. There is no Grok Desk multi-tenant server.

---

## Requirements

- **macOS** (primary: launchd + `.app` scripts; Linux may run the daemon with care)
- **Node.js ≥ 20**
- **[Grok CLI](https://x.ai/build)** installed and **logged in** (`grok --version` works in Terminal)
- Optional: [Tailscale](https://tailscale.com/) on Mac + phone for remote UI
- Optional: xAI API key only if you want **voice**

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
cp .env.example .env   # optional — voice / radar only
```

### 3. Build the UI and start the engine

```bash
npm run build          # builds web/ → web/dist
npm start              # starts daemon on http://127.0.0.1:8787
```

Open **http://127.0.0.1:8787** in a browser. You should see the desk; sending a message uses your Grok CLI agent.

### 4. Mac desktop app (optional)

```bash
npm run make-app
open -a "Grok Desk"
# also installs/copies to ~/Applications when the script succeeds
```

### 5. Always-on engine (optional, recommended)

Keeps the daemon running after reboots / closed windows (user launchd):

```bash
./scripts/install-launchd.sh
# UI: http://127.0.0.1:8787
# Stop: launchctl bootout gui/$(id -u)/dev.freecoffee.grok-desk
```

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

### 7. Optional config (`.env`)

See [`.env.example`](.env.example). Common:

| Variable | Purpose |
|----------|---------|
| `XAI_API_KEY` | Voice mode only |
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
| Voice missing | `XAI_API_KEY` in `.env` or Settings |
| Stream “stuck” green on phone | Hard-refresh PWA; ensure latest `main` and daemon restarted |

---

## License

[MIT](LICENSE) — use it, fork it, ship improvements.

## Disclaimer

Grok Desk is an **unofficial** community client for the Grok Build CLI. Grok, xAI, and related marks belong to their owners. Not affiliated with or endorsed by xAI.
