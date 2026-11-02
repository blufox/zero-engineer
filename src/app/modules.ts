import {
  Database,
  FolderGit2,
  House,
  Keyboard,
  Library,
  NotebookPen,
  Save,
  ScrollText,
  Server,
  Settings,
  Wrench,
  type LucideIcon,
} from "lucide-react";

export interface ModuleDef {
  id: string;
  label: string;
  path: string;
  icon: LucideIcon;
  description: string;
  /** Milestone from .docs/plan.md that delivers it; undefined = built. */
  milestone?: string;
  /** Pinned to the bottom of the sidebar. */
  footer?: boolean;
}

/** Single source of truth for navigation. Add a module here to get a sidebar entry. */
export const MODULES: ModuleDef[] = [
  { id: "home", label: "Home", path: "/", icon: House, description: "Overview of your hub" },
  { id: "tools", label: "Dev Tools", path: "/tools", icon: Wrench,
    description: "JSON, Base64, JWT, UUID, timestamps, regex, cron, hashes" },
  { id: "cheatsheets", label: "Cheat Sheets", path: "/cheatsheets", icon: Keyboard,
    description: "Vim and other keyboard and command references" },
  { id: "snippets", label: "Snippets & Notes", path: "/snippets", icon: NotebookPen,
    description: "Code snippets, notes and things you have learnt" },
  { id: "repos", label: "Repositories", path: "/repos", icon: FolderGit2,
    description: "Every git repo in your workspace with its status" },
  { id: "servers", label: "Running Servers", path: "/servers", icon: Server,
    description: "Apache, MySQL, artisan, runserver and other listeners" },
  { id: "databases", label: "Databases", path: "/databases", icon: Database,
    description: "Snapshot and restore local MySQL, Postgres and SQLite databases" },
  { id: "logs", label: "Logs", path: "/logs", icon: ScrollText,
    description: "Laravel and Django logs, grouped by error, with live tail" },
  { id: "glossary", label: "Glossary", path: "/glossary", icon: Library,
    description: "Design patterns, refactoring, architecture and principles" },
  { id: "configs", label: "Config Backup", path: "/configs", icon: Save,
    description: "Export zsh, git and oh-my-zsh configs to the data repo" },
  { id: "settings", label: "Settings", path: "/settings", icon: Settings, footer: true,
    description: "Data folder, theme, editor and scan paths" },
];
