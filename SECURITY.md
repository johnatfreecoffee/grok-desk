# Security

## Report a vulnerability

Open a **private** GitHub security advisory when possible, or contact the maintainer on the repo profile. Do **not** file public issues for unfixed secret exposures.

## Scope

Grok Desk is a **local** agent UI:

- HTTP/WS on `127.0.0.1` only by design  
- Secrets under Application Support / `.env` (gitignored)  
- Agent tools can run shell and edit files when you approve  
- Phone access is intended via **Tailscale** (private mesh), not a public Desk SaaS  

## Collaborators vs your machine

Forking this repo does **not** give anyone access to your Mac, Tailscale, Grok login, or `.env`.  
Only **merged** code changes affect the shared source tree; each user runs their own daemon.

## Hardening tips

- Use **Ask** permission mode on shared machines  
- Do not expose port 8787 on the public internet without auth  
- Prefer Tailscale Serve over raw port forwards  
- Rotate `XAI_API_KEY` / Resend keys if they ever land in a log or commit  
- Review PRs that touch `daemon/`, dependency pins, or install scripts carefully
