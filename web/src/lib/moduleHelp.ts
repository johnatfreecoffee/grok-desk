/** Help copy for every Desk page / module */

export type ModuleHelp = {
  id: string;
  title: string;
  summary: string;
  what: string;
  how: string[];
  tips?: string[];
};

export const MODULE_HELP: Record<string, ModuleHelp> = {
  home: {
    id: "home",
    title: "Agents",
    summary: "Multi-agent control room — see live workers and past sessions.",
    what: "Shows the ACP worker pool (up to 4 parallel Grok agents) plus your recent sessions. Dispatch starts a new agent without killing work already running.",
    how: [
      "Click a live worker or session card to open that chat.",
      "Type an optional first prompt, then Dispatch / Go to spawn an agent.",
      "Busy count shows how many workers are mid-turn.",
      "Use while another chat is working — Phase 2 pool keeps turns alive.",
    ],
    tips: ["Primary worker is your default chat brain.", "Phone uses the same roster over Tailscale."],
  },
  chat: {
    id: "chat",
    title: "Chat",
    summary: "Main conversation with Grok on this Mac.",
    what: "Streams thoughts, tools, and replies from the local Grok CLI agent (ACP). Attachments, queue, stop, voice (if keyed), and artifacts rail live here.",
    how: [
      "Type a message and Send (Enter). While busy, Send queues a follow-up.",
      "⌘N new chat · ⌘O folder · ⌘B sidebar · ⌘. artifacts · ⌘K command palette · Esc stop.",
      "Mode chips: Agent = ask permissions · YOLO = always-approve · Plan opens the plan board.",
      "Model picker switches model/effort for the next turns.",
      "Open the right rail for terminal output, files, tasks, and previews.",
    ],
    tips: ["Leave a chat mid-turn — work continues; open it again to watch.", "Mail sessions are read-only."],
  },
  tasks: {
    id: "tasks",
    title: "Tasks map",
    summary: "Spatial view of tools and subagents for the active session.",
    what: "Live tool stream from the current turn plus disk-recorded subagents under that session’s subagents/ folder.",
    how: [
      "Open a chat first so the map has a sessionId.",
      "Watch tools appear while a turn runs (auto-refresh when busy).",
      "Subagent cards show type, status, duration, and tool counts.",
    ],
    tips: ["Empty map = no tools yet — start a task that uses shell, search, or subagents."],
  },
  skills: {
    id: "skills",
    title: "Skills",
    summary: "Browse, create, toggle, and invoke Grok skills.",
    what: "Lists bundled, user, and project skills (SKILL.md packages). Create writes ~/.grok/skills/<id>. Disable renames SKILL.md → SKILL.md.off.",
    how: [
      "New → name + description + body.",
      "Invoke jumps to Chat and runs the skill.",
      "Enable/Disable for user/project skills (not bundled).",
    ],
    tips: ["Project skills appear when a project cwd is active."],
  },
  mcp: {
    id: "mcp",
    title: "MCP servers",
    summary: "Native grok mcp add / enable / disable / remove.",
    what: "Lists MCP servers via CLI JSON (falls back to config.toml). Mutations call grok mcp. OAuth for some servers may still need TUI.",
    how: [
      "Add HTTP URL or stdio command.",
      "Enable/Disable or Remove per row.",
      "Doctor runs grok mcp doctor.",
    ],
  },
  personas: {
    id: "personas",
    title: "Agents & Personas",
    summary: "Browse subagent types and persona definitions.",
    what: "Reads bundled/user/project agent .md/.toml and persona .toml files under ~/.grok and project .grok.",
    how: [
      "Switch Agents vs Personas tabs.",
      "View opens the file contents.",
      "Edit on disk; refresh to reload.",
    ],
    tips: ["Live pool of running workers is under Agents (home), not this library."],
  },
  memory: {
    id: "memory",
    title: "Memory",
    summary: "Browse Grok memory banks and AgentMemory.",
    what: "Opens global, workspace, and project memory files (including ~/AgentMemory). Flush/Dream run through the agent.",
    how: [
      "Click a bank on the left to read it.",
      "Flush writes the current session into memory.",
      "Dream consolidates memories (experimental memory features).",
    ],
    tips: ["Canonical shared bank: ~/AgentMemory."],
  },
  plan: {
    id: "plan",
    title: "Plan board",
    summary: "Review plan.md before the agent codes.",
    what: "Loads the session plan file when present, or live plan stream entries. Approve / revise sends chat instructions.",
    how: [
      "Enter plan mode from the button (or Plan chip).",
      "Read the plan markdown in the board.",
      "Approve & implement or Request changes.",
    ],
  },
  hooks: {
    id: "hooks",
    title: "Hooks",
    summary: "Lifecycle scripts Grok runs on session/tool events.",
    what: "Lists JSON hook files under ~/.grok/hooks with events and command counts. View raw JSON for each file.",
    how: [
      "Select a hook file to inspect.",
      "Edit files on disk; they load next session.",
      "Trust project hooks carefully — they can run shell.",
    ],
  },
  arch: {
    id: "arch",
    title: "Architecture map",
    summary: "What Grok loads for the current project folder.",
    what: "Maps AGENTS.md / CLAUDE.md rules, .grok modules (skills, hooks, agents, workflows), and project skills for the active cwd.",
    how: [
      "Open a project chat so cwd is set.",
      "Use the map to see rules and modules at a glance.",
      "Add missing AGENTS.md or .grok/* when the map looks empty.",
    ],
  },
  radar: {
    id: "radar",
    title: "Feature radar",
    summary: "Daily scan of Grok Build / xAI + Desk gap proposals.",
    what: "Runs (or shows) local radar snapshots. Approve queues items for the weekly digest; optional Resend email when configured.",
    how: [
      "Scan now to refresh today’s snapshot.",
      "Approve proposals to queue them.",
      "Digest dry-runs the weekly email body.",
      "Reply BUILD n on the email thread to ship via Agent Mail.",
    ],
  },
  marketplace: {
    id: "marketplace",
    title: "Marketplace",
    summary: "Native plugin install / uninstall / update.",
    what: "Installed list from grok plugin list; catalog from marketplace cache. Actions call grok plugin directly.",
    how: [
      "Install by name or git URL.",
      "Update one or Update all.",
      "Uninstall from installed cards.",
    ],
  },
  workflows: {
    id: "workflows",
    title: "Workflows",
    summary: "Live run board + saved Rhai catalog.",
    what: "Runs tab scans session workflows/ + recent workflow tool calls. Catalog launches /workflow. Pause/resume/stop/save use slash commands.",
    how: [
      "Runs auto-refresh every 8s.",
      "Launch from Catalog with optional JSON args.",
      "Pause / Resume / Stop use display names from the board.",
    ],
  },
  worktrees: {
    id: "worktrees",
    title: "Worktrees",
    summary: "Isolated git worktrees for parallel agents.",
    what: "Create, discard, merge into main, dispatch an agent into a worktree, or ask the agent to apply worktree code.",
    how: [
      "Open a project chat (cwd = repo).",
      "Name a worktree → Create.",
      "Dispatch here to run an agent in that path.",
      "Merge→main merges the worktree branch into main (confirm).",
      "Discard removes the worktree (confirm).",
    ],
    tips: ["Dirty worktrees block merge unless you force after cleanup."],
  },
  media: {
    id: "media",
    title: "Media studio",
    summary: "Image and video generation via Grok Build.",
    what: "Sends /imagine or /imagine-video prompts through the chat agent. Results appear in the session.",
    how: [
      "Pick Image or Video.",
      "Describe what you want → Generate.",
      "Switch to Chat to see the result path/output.",
    ],
  },
  usage: {
    id: "usage",
    title: "Usage & account",
    summary: "Auth, models, and session stats.",
    what: "Shows signed-in state, cached models, and per-session turn/token stats when available. SuperGrok dollar balance is not in local files.",
    how: [
      "Open a chat for session-level stats.",
      "Refresh to re-read disk summaries.",
      "Use TUI /usage or account console for billing credits.",
    ],
  },
  doctor: {
    id: "doctor",
    title: "Doctor",
    summary: "Local health checks for Grok Desk + Build.",
    what: "Verifies grok home, binary, auth, config, sessions, memory, MCP, worktrees DB, radar dir, etc.",
    how: [
      "Red rows need attention (missing auth, bad path).",
      "Refresh after fixing config.",
      "Pair with TUI /doctor for terminal diagnostics.",
    ],
  },
  settings: {
    id: "settings",
    title: "Settings",
    summary: "Desk prefs, push, voice key, session limits, permission mode.",
    what: "Persists to Application Support (not wiped by app rebuild). Includes phone push, session sidebar limits, and permission defaults.",
    how: [
      "Toggle phone push and notify-on-turn-end.",
      "Set max sessions/projects shown in the sidebar.",
      "permissionMode: ask vs always-approve; phoneAlwaysApprove keeps mobile YOLO.",
      "Always-allow patterns remember tools you approved forever (substring match).",
    ],
  },
  artifacts: {
    id: "artifacts",
    title: "Artifacts rail",
    summary: "Terminal, files, tasks, and previews for the live turn.",
    what: "Right-hand pane fed by tool stream + optional ACP PTY output. Not a second agent — a window on what the agent is doing.",
    how: [
      "Toggle with ⌘. or the panel button.",
      "Terminal: shell / live PTY output.",
      "Files/Preview: paths and content (fetches file when needed).",
      "Tasks: tools and plan items.",
    ],
  },
  sidebar: {
    id: "sidebar",
    title: "Sessions sidebar",
    summary: "Projects and chats from Grok sessions on disk.",
    what: "Groups sessions by project cwd (same as TUI). Pins, filters (desk/cli/mail), status dots (working/done/etc.).",
    how: [
      "Expand a project → click a chat to resume.",
      "New in project starts a chat in that folder.",
      "Pin important sessions; filter source and pins.",
      "⌘B toggles the sidebar.",
    ],
  },
  palette: {
    id: "palette",
    title: "Command palette",
    summary: "Search every slash command and Desk action.",
    what: "⌘K fuzzy finder for session, model, memory, extensions, automation, and view switches.",
    how: [
      "⌘K open · type to filter · Enter run · Esc close.",
      "view:… entries jump to modules.",
      "prompt:… entries fill or send chat commands.",
    ],
  },
};

export function getModuleHelp(id: string): ModuleHelp {
  return (
    MODULE_HELP[id] || {
      id,
      title: id,
      summary: "Grok Desk module.",
      what: "No detailed help is registered for this view yet.",
      how: ["Use the nav rail to explore other modules.", "⌘K opens the command palette."],
    }
  );
}
