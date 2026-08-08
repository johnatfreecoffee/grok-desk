# Contributing to Grok Desk

Thanks for helping close the gap with Grok Build.

## Setup

```bash
npm install && npm install --prefix web
cp .env.example .env   # optional
npm run build && npm start
```

Requires Node ≥ 20 and a working `grok` CLI login for full agent turns.

## Workflow

1. Branch from `main`
2. Keep UI **sky/blue** — no purple/violet/indigo product accents
3. Prefer native CLI/ACP/disk actions over faking every slash via prompts
4. Update `docs/PARITY.md` when you add a surface
5. `npm run build` must pass; smoke tests when you touch session/turn paths

## Style

- Daemon: plain ESM Node
- Web: React + TypeScript (Vite)
- Concise diffs; no drive-by refactors

## Secrets

Never commit `.env`, Application Support data, VAPID private keys, or session dumps.

## PRs

- One concern per PR when possible
- Describe user-visible behavior + how you tested
