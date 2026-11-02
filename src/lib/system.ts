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
  editor: (path: string, s: Pick<Settings, "editorCommand" | "terminalCommand">, line?: number) =>
    invoke<void>("open_in_editor", { path, editor: s.editorCommand, terminal: s.terminalCommand, line: line ?? null }),
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

// ---------------------------------------------------------------------------
// Repo context ("Where was I?") and .env drift
// ---------------------------------------------------------------------------

export interface EnvDrift {
  path: string;
  exampleFile: string | null;
  hasEnv: boolean;
  missing: string[];
  extra: string[];
  empty: string[];
}
export interface CommitLine { hash: string; subject: string; date: string }
export interface ChangedFile { path: string; status: string; modified: number }
export interface TodoLine { file: string; line: number; text: string; source: "uncommitted" | "committed" }
export interface RepoContext {
  path: string;
  branch: string | null;
  commits: CommitLine[];
  files: ChangedFile[];
  stashes: string[];
  todos: TodoLine[];
  env: EnvDrift;
}

export const hasDrift = (d: EnvDrift) => !!d.exampleFile && (!d.hasEnv || d.missing.length > 0 || d.empty.length > 0);

export const context = {
  repo: (path: string) => invoke<RepoContext>("repo_context", { path }),
  envDriftAll: (paths: string[]) => invoke<EnvDrift[]>("env_drift_all", { paths }),
};

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

export interface LogSource { path: string; kind: "laravel" | "django" | "pinned"; exists: boolean; size: number; modified: number }
export interface RepoLogs { repo: string; sources: LogSource[] }
export interface LogChunk { text: string; offset: number; size: number; rotated: boolean; truncated: boolean }
/** Stored at <data-dir>/logs/pinned.json. */
export interface PinnedLogs { pinned: Record<string, string[]> }

export const logs = {
  sources: (repos: string[]) => invoke<RepoLogs[]>("log_sources", { repos }),
  read: (path: string, offset: number | null) => invoke<LogChunk>("read_log", { path, offset }),
  clear: (path: string) => invoke<void>("clear_log", { path }),
};

// ---------------------------------------------------------------------------
// Database snapshots
// ---------------------------------------------------------------------------

export type DbDriver = "mysql" | "pgsql" | "sqlite";
export interface DbInfo {
  driver: DbDriver; host: string; port: number | null; database: string; user: string;
  hasPassword: boolean; source: string; projectDir: string; local: boolean;
}
export interface DbSnapshot {
  file: string; label: string; created: number; size: number; driver: DbDriver; database: string;
  branch: string | null; migration: string | null;
}
export interface RepoDb { repo: string; slug: string; db: DbInfo | null; error: string | null; snapshots: DbSnapshot[]; totalSize: number }
export interface DbTools { mysqldump: boolean; mysql: boolean; pgDump: boolean; pgRestore: boolean; gzip: boolean; snapshotsDir: string }
/** Manual connection, stored at <data-dir>/db-connections/<slug>.json. Never holds a password. */
export interface DbConnection { driver: DbDriver; host: string; port: number | null; database: string; user: string; socket?: string | null }

export const db = {
  tools: () => invoke<DbTools>("db_tools"),
  list: (repos: { path: string; slug: string }[]) => invoke<RepoDb[]>("db_list", { repos }),
  snapshot: (repo: string, slug: string, label: string, password: string | null, commit: boolean) =>
    invoke<DbSnapshot>("db_snapshot", { repo, slug, label, password, commit }),
  /** Returns the automatic "pre-restore" snapshot taken first. */
  restore: (repo: string, slug: string, file: string, password: string | null, commit: boolean) =>
    invoke<DbSnapshot>("db_restore", { repo, slug, file, password, commit }),
  remove: (slug: string, file: string) => invoke<void>("db_delete", { slug, file }),
  prune: (slug: string, keep: number) => invoke<number>("db_prune", { slug, keep }),
  clear: (slug: string) => invoke<number>("db_clear", { slug }),
};

// ---------------------------------------------------------------------------
// Machine bootstrap
// ---------------------------------------------------------------------------

export interface BootstrapItem { name: string; selected: boolean; extra: string | null }
export interface BootstrapSection { id: string; items: BootstrapItem[]; note: string | null }
export interface BootstrapScan { hostname: string; scannedAt: number; nodeVersion: string | null; sections: BootstrapSection[] }
export interface BootstrapPreview { script: string; previous: string | null; secrets: SecretHit[]; outDir: string }

export const bootstrap = {
  scan: () => invoke<BootstrapScan>("bootstrap_scan"),
  preview: (scan: BootstrapScan) => invoke<BootstrapPreview>("bootstrap_preview", { scan }),
  /** Returns the path of the written bootstrap.sh. */
  export: (scan: BootstrapScan) => invoke<string>("bootstrap_export", { scan }),
};
