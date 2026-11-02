/** Wrappers for Rust commands that touch the system: repos, launching programs. */
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Settings } from "./settings";

export interface LastCommit {
  hash: string;
  subject: string;
  author: string;
  date: string;
}

export interface RepoInfo {
  name: string;
  path: string;
  group: string;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: number;
  modified: number;
  untracked: number;
  conflicted: number;
  stashes: number;
  lastCommit: LastCommit | null;
  remoteUrl: string | null;
  webUrl: string | null;
  stacks: string[];
  error: string | null;
}

export const isDirty = (r: RepoInfo) => r.staged + r.modified + r.untracked + r.conflicted > 0;

export const repos = {
  scan: (s: Pick<Settings, "scanRoots" | "excludedPaths">) =>
    invoke<RepoInfo[]>("scan_repos", { roots: s.scanRoots, excluded: s.excludedPaths }),
  fetch: (path: string, s: Pick<Settings, "scanRoots">) =>
    invoke<RepoInfo>("fetch_repo", { path, roots: s.scanRoots }),
};

export const launch = {
  editor: (path: string, s: Pick<Settings, "editorCommand" | "terminalCommand">) =>
    invoke<void>("open_in_editor", { path, editor: s.editorCommand, terminal: s.terminalCommand }),
  terminal: (path: string, s: Pick<Settings, "terminalCommand">) =>
    invoke<void>("open_terminal", { path, terminal: s.terminalCommand }),
  folder: (path: string) => invoke<void>("open_folder", { path }),
  url: (url: string) => openUrl(url),
};

// ---------------------------------------------------------------------------
// Running servers
// ---------------------------------------------------------------------------

export interface Listener {
  port: number;
  addresses: string[];
  pid: number | null;
}

export interface ProcessInfo {
  pid: number;
  name: string;
  cmdline: string;
  cwd: string | null;
  uptimeSecs: number;
  memoryKb: number;
  kind: string | null;
  role: string | null;
  projectPath: string | null;
  projectName: string | null;
  ports: Listener[];
  owned: boolean;
  /** What Stop signals (the artisan parent for `artisan serve`). */
  stopPid: number;
}

export interface ServiceInfo {
  unit: string;
  label: string;
  description: string;
  active: string;
  sub: string;
  ports: Listener[];
}

export interface ServersSnapshot {
  devServers: ProcessInfo[];
  workers: ProcessInfo[];
  services: ServiceInfo[];
  other: ProcessInfo[];
  unattributed: Listener[];
}

export const servers = {
  list: (s: Pick<Settings, "scanRoots">) => invoke<ServersSnapshot>("list_servers", { roots: s.scanRoots }),
  stop: (pid: number, force = false) => invoke<void>("stop_process", { pid, force }),
  alive: (pid: number) => invoke<boolean>("process_alive", { pid }),
};

/** True when bound to all interfaces, i.e. reachable from other machines on the network. */
export const isExposed = (l: Listener) => l.addresses.some((a) => a === "0.0.0.0" || a === "::");

// ---------------------------------------------------------------------------
// Config backup
// ---------------------------------------------------------------------------

export interface RepoRecord { path: string; rel: string; remote: string | null; commit: string | null }
export interface Skipped { path: string; reason: string }
export interface FileStatus { source: string; rel: string; size: number; state: "new" | "changed" | "same" }

export interface TrackedItem {
  input: string;
  path: string;
  kind: "file" | "dir" | "missing" | "blocked" | "outside-home";
  state: "never" | "in-sync" | "changed" | "missing" | "blocked";
  files: FileStatus[];
  repos: RepoRecord[];
  skipped: Skipped[];
  totalSize: number;
  removed: string[];
}

export interface StatusReport { items: TrackedItem[]; configsDir: string; lastExport: number | null }
export interface SecretHit { file: string; line: number; kind: string; preview: string }
export interface ExportSummary {
  added: string[]; updated: string[]; removed: string[]; unchanged: number; repos: number;
  skipped: Skipped[]; configsDir: string;
}

export const configs = {
  status: (dotfiles: string[]) => invoke<StatusReport>("config_status", { dotfiles }),
  scanSecrets: (dotfiles: string[]) => invoke<SecretHit[]>("scan_config_secrets", { dotfiles }),
  export: (dotfiles: string[], skip: string[]) => invoke<ExportSummary>("export_configs", { dotfiles, skip }),
  backupText: (source: string) => invoke<string | null>("config_backup_text", { source }),
  currentText: (source: string) => invoke<string | null>("config_current_text", { source }),
};

// ---------------------------------------------------------------------------
// App data backup (settings, snippets, cheat sheets, glossary ↔ <backupDir>/zero)
// ---------------------------------------------------------------------------

export interface CategoryStatus { name: string; local: number; backup: number; toExport: number; toImport: number; toRemove: number }
export interface AppDataStatus { backupDir: string | null; categories: CategoryStatus[]; secrets: SecretHit[] }
export interface SyncSummary { added: string[]; updated: string[]; removed: string[]; unchanged: number }

export const appData = {
  status: () => invoke<AppDataStatus>("app_data_status"),
  export: () => invoke<SyncSummary>("export_app_data"),
  import: () => invoke<SyncSummary>("import_app_data"),
};

// ---------------------------------------------------------------------------
// App integration
// ---------------------------------------------------------------------------

export interface AutostartStatus { enabled: boolean; exe: string; installed: boolean }

export const app = {
  autostartStatus: () => invoke<AutostartStatus>("autostart_status"),
  setAutostart: (enabled: boolean) => invoke<AutostartStatus>("set_autostart", { enabled }),
  /** Returns the archive size in bytes. */
  archiveData: (dataDir: string, dest: string) => invoke<number>("archive_data", { dataDir, dest }),
};
