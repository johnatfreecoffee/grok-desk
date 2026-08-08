# Grok Desk ↔ Grok Build parity matrix

Track until every row is ✅ or **N/A** (TUI-only).  
Source of truth for slash list: `~/.grok/docs/user-guide/04-slash-commands.md`

Legend: ✅ native · 🟡 partial · ❌ missing · N/A not applicable

| Surface | Status | Notes |
|---------|--------|-------|
| `/new` | ✅ | New chat / new in project |
| `/resume` | ✅ | Sidebar + load_session |
| `/dashboard` | 🟡 | Peek + rename/stop/delete/open; more TUI parity left |
| `/compact` | 🟡 | Prompt inject only |
| `/context` | ✅ | Ctx drawer + usage |
| `/session-info` | ✅ | Chat drawer from summary |
| `/fork` | ✅ | Fork dialog ± worktree |
| `/rewind` | 🟡 | Timeline + soft rewind (/rewind); file snapshot restore later |
| `/edit-prompt` | N/A | Minimal TUI only |
| `/copy` | ✅ | Copy chat |
| `/export` | ✅ | Download markdown |
| `/quit` | N/A | Close app |
| `/home` | ✅ | Agents home |
| `/delete` | ✅ | Agents peek + API |
| `/rename` | ✅ | Agents peek + API |
| `/model` `/effort` | ✅ | Model picker |
| `/always-approve` `/auto` | ✅ | Ask/Auto/Plan/YOLO chips |
| `/multiline` | ✅ | Shift+Enter |
| `/history` | ✅ | Chat History drawer |
| `/compact-mode` | ✅ | Settings + toggle |
| `/vim-mode` | N/A | Terminal nav |
| `/minimal` `/fullscreen` | N/A | TUI render modes |
| `/plan` `/view-plan` | ✅ | Plan board + exit_plan_mode approval card |
| `/memory` family | 🟡 | Memory browser + flush/dream via agent |
| `/hooks` | 🟡 | Browse hooks; edit on disk |
| `/plugins` `/marketplace` | ✅ | Native install/uninstall/update |
| `/skills` | ✅ | List + create + enable/disable + invoke |
| `/mcps` | ✅ | Native list/add/enable/disable/remove/doctor |
| `/imagine` `/imagine-video` | ✅ | Media studio |
| `/loop` `/goal` `/deep-research` | 🟡 | Launch via prompt |
| `/workflow(s)` | ✅ | Live runs board + catalog + pause/resume/stop |
| `/theme` | N/A | Desk dark (blue accents) |
| `/feedback` | ✅ | Composer /feedback |
| `/btw` | ✅ | Side-question panel |
| `/doctor` | ✅ | Doctor module |
| `/release-notes` | 🟡 | Radar / local CHANGELOG |
| `/docs` `/tutorial` | 🟡 | Module Info + external docs |
| `/import-claude` | 🟡 | Prompt inject (CLI import) |
| `/config-agents` `/personas` | ✅ | Roles view — agents + personas browse |
| `/login` `/logout` | 🟡 | Account/usage |
| `/usage` | 🟡 | Session stats; no $ balance |
| `/privacy` | ✅ | Settings Privacy section |
| `/settings` | 🟡 | Desk settings modal |
| `/timestamps` | ✅ | Toggle + settings |
| `ask_user_question` | ✅ | QuestionCard via x.ai/ask_user_question |
| Multi-agent pool | ✅ | ACP pool |
| Permissions cards | ✅ | |
| Worktrees UI | ✅ | |
| Phone PWA | ✅ | |
| Module help Info | ✅ | |
| Public OSS repo | ✅ | github.com/johnatfreecoffee/grok-desk |
| X.com launch | ❌ | After OSS live |

## Gates
- **Parity v1:** no ❌ left (only N/A)
- **OSS:** clean secrets + LICENSE + README + CI
- **Launch:** X.com thread after public repo
