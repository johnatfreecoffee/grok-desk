# Security

## Report a vulnerability

Open a **private** security advisory on GitHub if available, or email the maintainer listed on the repo profile. Please do not file public issues for unfixed secret exposures.

## Scope

Grok Desk is a **local** agent UI:

- HTTP/WS on `127.0.0.1` only
- Secrets under Application Support / `.env` (gitignored)
- Agent tools can run shell and edit files when you approve

## Hardening tips

- Use **Ask** permission mode on shared machines
- Do not expose port 8787 to the public internet without auth
- Tailscale Serve is preferred for phone access over raw port forwards
- Rotate `XAI_API_KEY` / Resend keys if they ever land in a log or commit
