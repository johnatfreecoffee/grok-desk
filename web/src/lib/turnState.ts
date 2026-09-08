/**
 * Live turn state — mirrors Grok TUI activity: thoughts, tools, plans, agents.
 */

export type ToolStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled" | string;

export type ToolCallView = {
  id: string;
  title: string;
  kind?: string;
  status: ToolStatus;
  detail?: string;
  description?: string;
  /**
   * The tool the CLI actually ran — `read_file`, `run_terminal_command`,
   * `spawn_subagent`, … Taken from the FIRST `tool_call` title (the CLI later
   * rewrites `title` into prose like ``Read `/path` ``) or from a
   * `tool_started` / `tool_completed` event's `tool_name`. This is the field
   * to classify on; `title` is display text and lies.
   */
  toolName?: string;
  /** `duration_ms` from the `tool_completed` event. */
  durationMs?: number;
  /** `outcome` from the `tool_completed` event — "success" / "error" / … */
  outcome?: string;
  isAgent?: boolean;
  isBackground?: boolean;
  /** Absolute/relative path when known */
  path?: string;
  /** Accumulated stdout / tool content (capped) */
  output?: string;
  /** Diff text when edit tools provide it */
  diff?: string;
  rawInput?: Record<string, unknown>;
};

export type PlanEntry = {
  content: string;
  status: string;
  priority?: string;
};

export type LivePhase = "idle" | "thinking" | "tooling" | "writing" | "queued";

export type TurnDraft = {
  id: string;
  content: string;
  thought: string;
  tools: ToolCallView[];
  plan: PlanEntry[];
  phase: LivePhase;
  lastActivity: string;
};

export function createTurnDraft(id: string): TurnDraft {
  return {
    id,
    content: "",
    thought: "",
    tools: [],
    plan: [],
    phase: "thinking",
    lastActivity: "Thinking…",
  };
}

/**
 * The tools the CLI uses to start and follow a child agent.
 *
 * These are real tool names off the wire, not guesses. The old heuristic
 * sniffed the word "agent" anywhere in the rendered title, which flagged every
 * ``Execute `AGENT_NAME=grok ~/AgentMemory/bin/mem …` `` shell row as a
 * subagent. Real subagents come from `subagent_spawned` and live in the strip.
 */
const AGENT_TOOLS = new Set(["spawn_subagent", "get_command_or_subagent_output"]);

/** The tool name the CLI reports, when the title has not been rewritten yet. */
export function normalizeToolName(title: string | undefined | null): string | undefined {
  const t = String(title || "").trim();
  // Rewritten display titles carry spaces/backticks; raw tool names never do.
  if (!t || /[\s`]/.test(t)) return undefined;
  return t.toLowerCase();
}

export function isAgentToolName(toolName?: string, kind?: string): boolean {
  if (toolName && AGENT_TOOLS.has(toolName)) return true;
  return String(kind || "").toLowerCase() === "subagent";
}

const OUTPUT_CAP = 256_000;

function cap(s: string, n = OUTPUT_CAP): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + "\n…[truncated]";
}

function toolDetail(update: Record<string, unknown>): string | undefined {
  const raw = update.rawInput as Record<string, unknown> | undefined;
  if (!raw) return undefined;
  if (typeof raw.description === "string" && raw.description) return raw.description;
  if (typeof raw.command === "string") {
    const c = raw.command.replace(/\s+/g, " ").trim();
    return c.length > 120 ? c.slice(0, 117) + "…" : c;
  }
  if (typeof raw.path === "string") return raw.path;
  if (typeof raw.target_file === "string") return raw.target_file;
  if (typeof raw.prompt === "string") {
    const p = raw.prompt.replace(/\s+/g, " ").trim();
    return p.length > 100 ? p.slice(0, 97) + "…" : p;
  }
  return undefined;
}

function toolPath(update: Record<string, unknown>): string | undefined {
  const raw = update.rawInput as Record<string, unknown> | undefined;
  if (raw) {
    for (const k of ["path", "target_file", "file_path", "file", "filename"]) {
      if (typeof raw[k] === "string" && raw[k]) return String(raw[k]);
    }
  }
  if (typeof update.path === "string") return update.path;
  return undefined;
}

function extractOutput(update: Record<string, unknown>): string | undefined {
  // Common ACP shapes
  const content = update.content;
  if (typeof content === "string" && content.trim()) return content;
  if (content && typeof content === "object") {
    const c = content as { text?: string; output?: string };
    if (typeof c.text === "string" && c.text) return c.text;
    if (typeof c.output === "string" && c.output) return c.output;
  }
  if (typeof update.output === "string") return update.output;
  if (typeof update.stdout === "string") return update.stdout;
  if (typeof update.stderr === "string") return update.stderr;
  if (typeof update.result === "string") return update.result;
  // content array of blocks
  if (Array.isArray(update.content)) {
    const parts = update.content
      .map((b) => {
        if (!b) return "";
        if (typeof b === "string") return b;
        if (typeof b === "object" && (b as { text?: string }).text) return String((b as { text: string }).text);
        if (typeof b === "object" && (b as { output?: string }).output) return String((b as { output: string }).output);
        return "";
      })
      .filter(Boolean);
    if (parts.length) return parts.join("");
  }
  // rawOutput
  const ro = update.rawOutput ?? update.raw_output;
  if (typeof ro === "string") return ro;
  if (ro && typeof ro === "object") {
    try {
      return JSON.stringify(ro, null, 2);
    } catch {
      /* */
    }
  }
  return undefined;
}

function extractDiff(update: Record<string, unknown>): string | undefined {
  if (typeof update.diff === "string") return update.diff;
  const raw = update.rawInput as Record<string, unknown> | undefined;
  if (raw && typeof raw.new_string === "string" && typeof raw.old_string === "string") {
    // rough unified-ish preview
    return `--- old\n+++ new\n@@\n-${String(raw.old_string).slice(0, 4000)}\n+${String(raw.new_string).slice(0, 4000)}`;
  }
  if (raw && typeof raw.contents === "string") return raw.contents.slice(0, OUTPUT_CAP);
  return undefined;
}

export function applyTurnUpdate(draft: TurnDraft, update: Record<string, unknown>): void {
  const kind = String(update.sessionUpdate || update.type || "");

  if (kind === "agent_message_chunk") {
    const content = update.content as { text?: string } | undefined;
    const text = content?.text ?? (update.text as string) ?? "";
    if (text) {
      draft.content += text;
      draft.phase = "writing";
      draft.lastActivity = "Writing…";
    }
    return;
  }

  if (kind === "agent_thought_chunk") {
    const content = update.content as { text?: string } | undefined;
    const text = content?.text ?? (update.text as string) ?? "";
    if (text) {
      draft.thought += text;
      if (draft.phase !== "writing" && draft.phase !== "tooling") {
        draft.phase = "thinking";
        draft.lastActivity = "Thinking…";
      }
    }
    return;
  }

  if (kind === "tool_call") {
    const id = String(
      update.toolCallId || update.tool_call_id || update.id || `t_${draft.tools.length}`,
    );
    const title = String(update.title || update.name || "tool");
    const tKind = update.kind ? String(update.kind) : undefined;
    const toolName = normalizeToolName(title);
    const agent = isAgentToolName(toolName, tKind);
    const out = extractOutput(update);
    const diff = extractDiff(update);
    draft.tools.push({
      id,
      title,
      toolName,
      kind: tKind,
      status: String(update.status || "pending"),
      detail: toolDetail(update),
      description:
        typeof (update.rawInput as { description?: string } | undefined)?.description === "string"
          ? (update.rawInput as { description: string }).description
          : undefined,
      isAgent: agent,
      path: toolPath(update),
      output: out ? cap(out) : undefined,
      diff: diff ? cap(diff) : undefined,
      rawInput:
        update.rawInput && typeof update.rawInput === "object"
          ? (update.rawInput as Record<string, unknown>)
          : undefined,
    });
    draft.phase = "tooling";
    draft.lastActivity = agent ? `Spawning agent · ${title}` : `Running · ${title}`;
    return;
  }

  if (kind === "tool_call_update") {
    const id = String(update.toolCallId || update.tool_call_id || update.id || "");
    const t = draft.tools.find((x) => x.id === id);
    if (t) {
      if (update.status) t.status = String(update.status);
      if (update.title) {
        // Keep the first raw tool name — later titles are rendered prose.
        if (!t.toolName) t.toolName = normalizeToolName(String(update.title));
        t.title = String(update.title);
      }
      const d = toolDetail(update);
      if (d) t.detail = d;
      const p = toolPath(update);
      if (p) t.path = p;
      const out = extractOutput(update);
      if (out) t.output = cap((t.output || "") + out);
      const diff = extractDiff(update);
      if (diff) t.diff = cap(diff);
      if (update.rawInput && typeof update.rawInput === "object") {
        t.rawInput = update.rawInput as Record<string, unknown>;
      }
      const running = t.status === "in_progress" || t.status === "pending";
      if (running) {
        draft.phase = "tooling";
        draft.lastActivity = t.isAgent ? `Agent working · ${t.title}` : `Running · ${t.title}`;
      } else if (t.status === "completed") {
        draft.lastActivity = `Done · ${t.title}`;
      } else if (t.status === "failed") {
        draft.lastActivity = `Failed · ${t.title}`;
      }
    }
    return;
  }

  if (kind === "plan") {
    const entries = (update.entries as PlanEntry[]) || [];
    if (Array.isArray(entries)) {
      draft.plan = entries.map((e) => ({
        content: String(e.content || ""),
        status: String(e.status || "pending"),
        priority: e.priority ? String(e.priority) : undefined,
      }));
      draft.lastActivity = "Updating plan…";
    }
    return;
  }

  if (kind === "task_backgrounded") {
    const id = String(update.tool_call_id || update.task_id || `bg_${draft.tools.length}`);
    const cmd = String(update.command || "").replace(/\s+/g, " ").trim();
    const short = cmd.length > 80 ? cmd.slice(0, 77) + "…" : cmd || "background task";
    const existing = draft.tools.find((x) => x.id === id);
    if (existing) {
      existing.isBackground = true;
      existing.status = "in_progress";
      existing.detail = short;
    } else {
      draft.tools.push({
        id,
        title: "background",
        status: "in_progress",
        detail: short,
        isBackground: true,
      });
    }
    draft.phase = "tooling";
    draft.lastActivity = "Background task running…";
    return;
  }

  if (kind === "user_message_chunk") {
    // ignore mid-stream user echo
    return;
  }
}

/** Real tool name → icon bucket. Exact matches first, prose title last. */
const TOOL_ICON: Record<string, string> = {
  run_terminal_command: "shell",
  read_file: "read",
  list_dir: "read",
  grep: "search",
  glob: "search",
  codebase_search: "search",
  search_replace: "edit",
  write_file: "edit",
  create_file: "edit",
  delete_file: "edit",
  todo_write: "plan",
  web_search: "web",
  web_fetch: "web",
  spawn_subagent: "agent",
  get_command_or_subagent_output: "agent",
};

export function toolIconLabel(t: ToolCallView): string {
  if (t.isAgent) return "agent";
  if (t.isBackground) return "bg";
  if (t.toolName && TOOL_ICON[t.toolName]) return TOOL_ICON[t.toolName];
  const n = t.title.toLowerCase();
  if (n.includes("terminal") || n.includes("bash") || n.includes("shell") || n.startsWith("execute"))
    return "shell";
  if (n.includes("read") || n.includes("file")) return "read";
  if (n.includes("search") || n.includes("grep")) return "search";
  if (n.includes("write") || n.includes("edit") || n.includes("replace")) return "edit";
  if (n.includes("web") || n.includes("fetch")) return "web";
  return "tool";
}

/** "1.2s" / "940ms" / "16m 10s" — one place so every surface reads the same. */
export function formatDuration(ms: number | null | undefined): string | null {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}s`;
  const mins = Math.floor(n / 60_000);
  const secs = Math.round((n % 60_000) / 1000);
  if (mins < 60) return secs ? `${mins}m ${secs}s` : `${mins}m`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}
