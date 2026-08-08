/** HTTP client for /api/build/* — never touches chat WS */

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return res.json() as Promise<T>;
}

export type SlashCommand = {
  id: string;
  cmd: string;
  aliases?: string[];
  category: string;
  label: string;
  action: string;
};

export type SkillInfo = {
  id: string;
  name: string;
  description: string;
  path: string;
  dir?: string;
  scope: string;
  enabled?: boolean;
};

export type McpServer = {
  name: string;
  url?: string | null;
  command?: string | null;
  transport?: string;
  enabled: boolean;
  scope?: string;
};

export type PluginInfo = {
  name: string;
  status?: string;
  version?: string | null;
  path?: string | null;
  source?: string | null;
  marketplace?: string | null;
  repo_key?: string;
  enabled?: boolean;
};

export type AgentDef = {
  id: string;
  name: string;
  description: string;
  path: string;
  scope: string;
  kind?: string;
};

export type PersonaDef = {
  id: string;
  name: string;
  description: string;
  path: string;
  scope: string;
};

export type ModelInfo = {
  id: string;
  name: string;
  description: string;
  context: number | null;
  reasoningEfforts?: { id: string; label: string; default?: boolean }[];
  defaultEffort?: string | null;
};

export type RadarProposal = {
  id: string;
  priority?: string;
  text: string;
  source?: string;
};

export type RadarSnapshot = {
  date: string;
  summary?: string;
  local_version?: string | null;
  binary_version?: string | null;
  desk_gap_proposals?: RadarProposal[];
  new_models?: string[];
  changelog_bullets?: string[];
};

export type MemoryBank = {
  id: string;
  scope: string;
  name: string;
  path: string;
  bytes: number;
  mtime: string;
  preview?: string;
  lines?: number;
  content?: string;
};

export type HookInfo = {
  id: string;
  name: string;
  scope: string;
  path: string;
  events: string[];
  commandCount: number;
  mtime: string;
};

export type MarketPlugin = {
  id: string;
  name: string;
  version: string | null;
  description?: string;
  marketplace?: string | null;
  status: string;
  skills?: string[];
  mcp?: string[];
  source?: string | null;
};

export type SubagentInfo = {
  id: string;
  type: string;
  description: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  toolCalls: number | null;
  turns: number | null;
};

export type DeskView =
  | "chat"
  | "home"
  | "tasks"
  | "skills"
  | "mcp"
  | "plan"
  | "arch"
  | "radar"
  | "marketplace"
  | "settings"
  | "hooks"
  | "memory"
  | "doctor"
  | "workflows"
  | "worktrees"
  | "media"
  | "usage"
  | "personas";

export const buildApi = {
  health: () => get<{ ok: boolean; version: { version: string | null } }>("/api/build/health"),
  slash: () => get<{ ok: boolean; commands: SlashCommand[] }>("/api/build/slash"),
  skills: (cwd?: string | null) =>
    get<{ ok: boolean; skills: SkillInfo[] }>(
      `/api/build/skills${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`,
    ),
  mcp: () => get<{ ok: boolean; servers: McpServer[] }>("/api/build/mcp"),
  models: () => get<{ ok: boolean; models: ModelInfo[] }>("/api/build/models"),
  plan: (sessionId: string, cwd?: string | null) =>
    get<{
      ok: boolean;
      content: string | null;
      path?: string | null;
      source?: string | null;
      mtime?: string | null;
      error?: string;
    }>(
      `/api/build/plan?sessionId=${encodeURIComponent(sessionId)}${
        cwd ? `&cwd=${encodeURIComponent(cwd)}` : ""
      }`,
    ),
  inspect: (cwd?: string | null) =>
    get<{
      ok: boolean;
      cwd?: string;
      rules?: { name: string; path: string }[];
      modules?: { name: string; path: string; count: number }[];
      skills?: SkillInfo[];
      error?: string;
    }>(`/api/build/inspect${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`),
  radar: () =>
    get<{
      ok: boolean;
      latest: RadarSnapshot | null;
      snapshots: { date: string; summary: string | null; proposalCount: number }[];
      queue: { id: string; text: string; priority: string; status: string }[];
      version: { version: string | null };
    }>("/api/build/radar"),
  radarRun: () => post<{ ok: boolean; latest: RadarSnapshot | null }>("/api/build/radar/run"),
  radarApprove: (body: { id?: string; text: string; priority?: string }) =>
    post<{ ok: boolean; item: unknown }>("/api/build/radar/approve", body),
  radarDigest: (opts?: { send?: boolean }) =>
    post<{ ok: boolean; dry?: boolean; output?: string }>("/api/build/radar/digest", opts || { dry: true }),
  memory: () => get<{ ok: boolean; banks: MemoryBank[] }>("/api/build/memory"),
  memoryFile: (id: string) =>
    get<{ ok: boolean; content?: string; error?: string; name?: string; path?: string }>(
      `/api/build/memory?id=${encodeURIComponent(id)}`,
    ),
  hooks: () => get<{ ok: boolean; hooks: HookInfo[] }>("/api/build/hooks"),
  hookFile: (id: string) =>
    get<{ ok: boolean; content?: string; error?: string }>(`/api/build/hooks?id=${encodeURIComponent(id)}`),
  marketplace: () =>
    get<{ ok: boolean; installed: MarketPlugin[]; catalog: MarketPlugin[] }>("/api/build/marketplace"),
  subagents: (sessionId: string, cwd?: string | null) =>
    get<{ ok: boolean; subagents: SubagentInfo[] }>(
      `/api/build/subagents?sessionId=${encodeURIComponent(sessionId)}${
        cwd ? `&cwd=${encodeURIComponent(cwd)}` : ""
      }`,
    ),
  doctor: () =>
    get<{
      ok: boolean;
      checks: { id: string; ok: boolean; detail: string }[];
      version: { version: string | null };
    }>("/api/build/doctor"),
  workflows: (cwd?: string | null) =>
    get<{
      ok: boolean;
      workflows: {
        id: string;
        name: string;
        file: string;
        scope: string;
        path: string;
        preview?: string;
        mtime?: string;
      }[];
      runs?: {
        id: string;
        name: string;
        status: string;
        phase?: string | null;
        sessionId?: string | null;
        path?: string | null;
        scriptPath?: string | null;
        mtime?: string | null;
        source?: string;
        toolCallId?: string | null;
      }[];
    }>(`/api/build/workflows${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`),
  worktrees: () =>
    get<{
      ok: boolean;
      worktrees: {
        id: string;
        path: string;
        sourceRepo?: string | null;
        repoName: string;
        kind: string;
        status: string;
        sessionId: string | null;
        gitRef: string | null;
        createdAt: string | null;
      }[];
      error?: string;
    }>("/api/build/worktrees"),
  worktreeAction: (body: Record<string, unknown>) =>
    post<{ ok: boolean; error?: string; path?: string; branch?: string }>(
      "/api/build/worktrees",
      body,
    ),
  usage: (sessionId?: string | null, cwd?: string | null) =>
    get<{
      ok: boolean;
      version: { version: string | null };
      auth: { present: boolean; method: string | null; hasToken?: boolean };
      modelCount: number;
      models: { id: string; name: string }[];
      note?: string;
      account?: { creditsRemaining: number | null; source: string; note?: string };
      sessionUsage?: {
        turns?: number | null;
        model?: string | null;
        inputTokens?: number | null;
        outputTokens?: number | null;
        reasoningTokens?: number | null;
        contextUsed?: number | null;
        contextLimit?: number | null;
        title?: string | null;
      } | null;
    }>(
      `/api/build/usage${
        sessionId
          ? `?sessionId=${encodeURIComponent(sessionId)}${
              cwd ? `&cwd=${encodeURIComponent(cwd)}` : ""
            }`
          : ""
      }`,
    ),
  file: (filePath: string, cwd?: string | null) =>
    get<{ ok: boolean; content?: string; path?: string; error?: string; truncated?: boolean }>(
      `/api/build/file?path=${encodeURIComponent(filePath)}${
        cwd ? `&cwd=${encodeURIComponent(cwd)}` : ""
      }`,
    ),
  sessionInfo: (sessionId: string, cwd?: string | null) =>
    get<{
      ok: boolean;
      title?: string | null;
      model?: string | null;
      numMessages?: number | null;
      nextTraceTurn?: number | null;
      cwd?: string | null;
      headBranch?: string | null;
      createdAt?: string | null;
      updatedAt?: string | null;
      error?: string;
    }>(
      `/api/build/session-info?sessionId=${encodeURIComponent(sessionId)}${
        cwd ? `&cwd=${encodeURIComponent(cwd)}` : ""
      }`,
    ),
  rewindPoints: (sessionId: string, cwd?: string | null) =>
    get<{
      ok: boolean;
      points: { promptIndex: number; createdAt: string | null; fileCount: number; files: string[] }[];
    }>(
      `/api/build/rewind?sessionId=${encodeURIComponent(sessionId)}${
        cwd ? `&cwd=${encodeURIComponent(cwd)}` : ""
      }`,
    ),
  rewindTo: (sessionId: string, promptIndex: number, cwd?: string | null) =>
    post<{ ok: boolean; promptIndex: number; hint?: string }>("/api/build/rewind", {
      sessionId,
      promptIndex,
      cwd,
    }),
  promptHistory: (sessionId: string, cwd?: string | null) =>
    get<{ ok: boolean; prompts: { id: string; content: string; preview: string }[] }>(
      `/api/build/history?sessionId=${encodeURIComponent(sessionId)}${
        cwd ? `&cwd=${encodeURIComponent(cwd)}` : ""
      }`,
    ),
  sessionRename: (sessionId: string, title: string) =>
    post<{ ok: boolean; title?: string }>("/api/build/session-rename", { sessionId, title }),
  sessionDelete: (sessionId: string, cwd?: string | null) =>
    post<{ ok: boolean; error?: string }>("/api/build/session-delete", { sessionId, cwd }),

  // Sprint C — native extensions
  mcpAction: (body: {
    action: "enable" | "disable" | "remove" | "add" | "doctor";
    name?: string;
    url?: string;
    command?: string;
    transport?: string;
    scope?: string;
    args?: string[];
  }) => post<{ ok: boolean; error?: string; output?: string; name?: string }>(
    "/api/build/mcp",
    body,
  ),
  plugins: (available?: boolean) =>
    get<{ ok: boolean; plugins: PluginInfo[] }>(
      `/api/build/plugins${available ? "?available=1" : ""}`,
    ),
  pluginAction: (body: {
    action: "install" | "uninstall" | "update" | "enable" | "disable";
    name?: string;
    source?: string;
    trust?: boolean;
  }) => post<{ ok: boolean; error?: string; stdout?: string }>("/api/build/plugins", body),
  agentDefs: (cwd?: string | null) =>
    get<{ ok: boolean; agents: AgentDef[]; personas: PersonaDef[] }>(
      `/api/build/agents${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`,
    ),
  skillAction: (body: {
    action: "create" | "enable" | "disable";
    name?: string;
    description?: string;
    body?: string;
    id?: string;
    path?: string;
  }) => post<{ ok: boolean; error?: string; id?: string; path?: string }>("/api/build/skills", body),
};
