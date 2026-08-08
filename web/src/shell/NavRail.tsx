import {
  Bot,
  Boxes,
  Brain,
  FolderGit2,
  FolderTree,
  Gauge,
  GitBranch,
  Home,
  Image,
  LayoutDashboard,
  MessageSquare,
  Network,
  Radar,
  Settings,
  Sparkles,
  Stethoscope,
  Store,
  Users,
  Webhook,
  Workflow,
} from "lucide-react";
import type { DeskView } from "../lib/buildClient";

const ITEMS: { id: DeskView; label: string; icon: typeof Home; desktopOnly?: boolean }[] = [
  { id: "home", label: "Agents", icon: LayoutDashboard },
  { id: "chat", label: "Chat", icon: MessageSquare },
  { id: "tasks", label: "Tasks", icon: Workflow },
  { id: "workflows", label: "Flows", icon: GitBranch, desktopOnly: true },
  { id: "skills", label: "Skills", icon: Sparkles },
  { id: "mcp", label: "MCP", icon: Network },
  { id: "personas", label: "Roles", icon: Users, desktopOnly: true },
  { id: "memory", label: "Memory", icon: Brain },
  { id: "plan", label: "Plan", icon: FolderTree },
  { id: "worktrees", label: "Trees", icon: FolderGit2, desktopOnly: true },
  { id: "media", label: "Media", icon: Image, desktopOnly: true },
  { id: "hooks", label: "Hooks", icon: Webhook },
  { id: "arch", label: "Map", icon: Boxes },
  { id: "radar", label: "Radar", icon: Radar },
  { id: "marketplace", label: "Store", icon: Store, desktopOnly: true },
  { id: "usage", label: "Usage", icon: Gauge, desktopOnly: true },
  { id: "doctor", label: "Doctor", icon: Stethoscope, desktopOnly: true },
  { id: "settings", label: "Settings", icon: Settings },
];

type Props = {
  view: DeskView;
  onChange: (v: DeskView) => void;
  onOpenPalette: () => void;
};

export function NavRail({ view, onChange, onOpenPalette }: Props) {
  return (
    <nav className="nav-rail" aria-label="Grok Desk modules">
      <button
        type="button"
        className="nav-rail-brand"
        title="Grok Desk"
        onClick={() => onChange("home")}
      >
        <Bot size={18} strokeWidth={2.25} />
      </button>
      <div className="nav-rail-items">
        {ITEMS.map((it) => {
          const Icon = it.icon;
          return (
            <button
              key={it.id}
              type="button"
              className={`nav-rail-btn ${view === it.id ? "active" : ""} ${it.desktopOnly ? "desktop-only-nav" : ""}`}
              title={it.label}
              aria-label={it.label}
              aria-current={view === it.id ? "page" : undefined}
              onClick={() => onChange(it.id)}
            >
              <Icon size={18} strokeWidth={2} />
              <span className="nav-rail-label">{it.label}</span>
            </button>
          );
        })}
      </div>
      <button
        type="button"
        className="nav-rail-btn nav-rail-palette"
        title="Command palette (⌘K)"
        aria-label="Command palette"
        onClick={onOpenPalette}
      >
        <span className="nav-kbd">⌘K</span>
      </button>
    </nav>
  );
}
