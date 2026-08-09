# Contributing to Grok Desk

Thanks for helping turn Grok Build’s power into a better visual desk.

## What we want

- Parity with Grok Build surfaces — track [`docs/PARITY.md`](docs/PARITY.md)
- Reliable chat (desktop + phone), streaming, session restore
- Clearer docs and non-Mac notes
- Native CLI/ACP/disk behavior over “prompt fakes”

## Security model for random collaborators (read this)

Open source does **not** mean strangers can write to production or see your secrets.

| Mechanism | What it does |
|-----------|----------------|
| **Fork + PR** | Contributors work on **their** copy. Changes only enter this repo if a **Pull Request** is opened and **merged** by someone with write access. |
| **No write access by default** | Cloning or starring does not grant push to `main`. |
| **CI on PRs** | GitHub Actions builds the web UI and runs checks on each PR (`.github/workflows/ci.yml`). Broken builds are visible before merge. |
| **Review** | Maintainers read the diff. You can require reviews / branch protection in GitHub Settings → Branches. |
| **Secrets stay out of git** | `.env`, Application Support, VAPID keys, session dumps are **gitignored**. Never paste API keys into issues or PRs. |
| **Each person runs locally** | Contributors run the daemon on **their** machine with **their** Grok login. Your Mac, Tailscale, and keys are never shared by the repo. |
| **Supply chain** | Prefer small PRs. Review dependency bumps carefully. Do not commit `node_modules`. |

If someone sends a malicious PR (e.g. exfiltrating env vars), **don’t merge it**. CI is not a substitute for reading the diff.

### Recommended GitHub settings (maintainers)

In the repo on GitHub:

1. **Settings → Branches → Branch protection** for `main`:  
   - Require PR before merge  
   - Require status checks to pass (`CI` / `build`)  
   - Optionally require 1 review  
2. **Settings → Actions** — allow Actions for this repo (already used by CI).  
3. **Settings → Secrets** — only for *deploy* secrets if you add any later; this project needs none for the local desk.  
4. Never add collaborator **Admin** lightly; prefer **Write** only for trusted co-maintainers.

## Setup (contributors)

```bash
git clone https://github.com/YOUR_USER/grok-desk.git   # your fork
cd grok-desk
npm install && npm install --prefix web
cp .env.example .env   # optional
npm run build && npm start
```

Needs Node ≥ 20 and a working `grok` CLI login for agent turns.

## Workflow

1. Fork → clone **your** fork  
2. `git checkout -b feat/short-name`  
3. Change code; keep UI **sky/blue** (no purple/violet product accents)  
4. `npm run build` must pass  
5. Update `docs/PARITY.md` if you add a surface  
6. Push to **your** fork → Open PR into `johnatfreecoffee/grok-desk`  
7. Describe what you changed and how you tested (desktop / phone if relevant)

## Style

- Daemon: plain ESM Node  
- Web: React + TypeScript (Vite)  
- Prefer small, focused PRs  

## Secrets

Never commit:

- `.env`  
- `~/Library/Application Support/GrokDesk/**`  
- Session dumps under `~/.grok/sessions`  
- Private keys / VAPID private material  

## Code of conduct (minimal)

Be respectful. No spam PRs. Security issues: prefer private report — see [SECURITY.md](SECURITY.md).
