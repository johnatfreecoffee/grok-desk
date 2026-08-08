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

function isAgentTool(title: string, kind?: string): boolean {
  const t = `${title} ${kind || ""}`.toLowerCase();
  return (
    t.includes("agent") ||
    t.includes("subagent") ||
    t.includes("spawn") ||
    t.includes("task(") ||
    t.startsWith("agent")
  );
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
    const agent = isAgentTool(title, tKind);
    const out = extractOutput(update);
    const diff = extractDiff(update);
    draft.tools.push({
      id,
      title,
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
      if (update.title) t.title = String(update.title);
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

export function toolIconLabel(t: ToolCallView): string {
  if (t.isAgent) return "agent";
  if (t.isBackground) return "bg";
  const n = t.title.toLowerCase();
  if (n.includes("terminal") || n.includes("bash") || n.includes("shell")) return "shell";
  if (n.includes("read") || n.includes("file")) return "read";
  if (n.includes("search") || n.includes("grep")) return "search";
  if (n.includes("write") || n.includes("edit") || n.includes("replace")) return "edit";
  if (n.includes("web") || n.includes("fetch")) return "web";
  return "tool";
}
