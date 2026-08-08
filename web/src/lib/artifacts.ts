/**
 * Artifact stream — derived from ACP tool events for the right-hand pane.
 */
import type { PlanEntry, ToolCallView, TurnDraft } from "./turnState";
import { toolIconLabel } from "./turnState";

export type ArtifactKind = "terminal" | "file" | "diff" | "plan" | "image" | "task";

export type Artifact = {
  id: string;
  kind: ArtifactKind;
  title: string;
  path?: string;
  content?: string;
  status?: string;
  toolId?: string;
  updatedAt: number;
};

function extractPath(t: ToolCallView): string | undefined {
  const d = t.detail || t.description || "";
  // Absolute or relative file-ish paths
  const m = d.match(/(?:^|[\s`"'])(\/[\w./@+-]+(?:\.\w+)?)|(?:^|[\s`"'])((?:\.\/|[\w-]+\/)[\w./@+-]+)/);
  if (m) return (m[1] || m[2] || "").replace(/[`"']/g, "");
  if (d.includes("/") && d.length < 260 && !d.includes(" ")) return d;
  return undefined;
}

function isShell(t: ToolCallView): boolean {
  return toolIconLabel(t) === "shell" || t.isBackground === true;
}

function isEdit(t: ToolCallView): boolean {
  const k = toolIconLabel(t);
  return k === "edit" || k === "read";
}

/** Build artifact list from live/finished turn state. */
export function artifactsFromDraft(draft: TurnDraft | null): Artifact[] {
  if (!draft) return [];
  const out: Artifact[] = [];
  const now = Date.now();

  for (const t of draft.tools) {
    if (isShell(t) || t.output) {
      const body = t.output || [t.detail, t.description].filter(Boolean).join("\n") || undefined;
      if (isShell(t) || (body && body.length > 40 && !t.path)) {
        out.push({
          id: `term-${t.id}`,
          kind: "terminal",
          title: t.title || "shell",
          content: body,
          status: t.status,
          toolId: t.id,
          updatedAt: now,
        });
      }
    }
    const path = t.path || extractPath(t);
    if (path && (isEdit(t) || path.startsWith("/") || path.includes("."))) {
      const isDiff = Boolean(t.diff) || (isEdit(t) && toolIconLabel(t) === "edit");
      out.push({
        id: `file-${t.id}`,
        kind: isDiff ? "diff" : "file",
        title: path.split("/").pop() || path,
        path,
        content: t.diff || t.output || (t.detail !== path ? t.detail : undefined),
        status: t.status,
        toolId: t.id,
        updatedAt: now,
      });
    }
    if (t.isAgent) {
      out.push({
        id: `task-${t.id}`,
        kind: "task",
        title: t.title,
        content: t.detail || t.description,
        status: t.status,
        toolId: t.id,
        updatedAt: now,
      });
    }
  }

  if (draft.plan.length) {
    out.push({
      id: `plan-${draft.id}`,
      kind: "plan",
      title: "Plan",
      content: draft.plan.map((e) => `${statusMark(e)} ${e.content}`).join("\n"),
      status: draft.plan.some((p) => p.status === "in_progress") ? "in_progress" : "completed",
      updatedAt: now,
    });
  }

  // Dedupe by id
  const seen = new Set<string>();
  return out.filter((a) => {
    if (seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  });
}

function statusMark(e: PlanEntry): string {
  if (e.status === "completed") return "✓";
  if (e.status === "in_progress") return "›";
  return "·";
}

export function shouldAutoOpenArtifacts(arts: Artifact[]): boolean {
  return arts.some(
    (a) =>
      a.kind === "terminal" ||
      a.kind === "file" ||
      a.kind === "diff" ||
      a.kind === "plan" ||
      (a.kind === "task" && a.status === "in_progress"),
  );
}
