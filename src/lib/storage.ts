/**
 * Typed wrappers around the Rust storage commands (src-tauri/src/storage.rs).
 * Every path is relative to the user's data folder, e.g. "snippets/snippets.json".
 */
import { invoke } from "@tauri-apps/api/core";

export interface AppConfig {
  dataDir: string | null;
  /** Machine-local backup folder; null = <dataDir>/configs. */
  backupDir?: string | null;
}

export interface DataDirResult {
  config: AppConfig;
  gitInitialized: boolean;
  alreadyGitRepo: boolean;
}

export interface DataUsage {
  path: string;
  totalBytes: number;
  totalFiles: number;
  entries: { name: string; bytes: number; files: number; isDir: boolean }[];
}

/** 1536 → "1.5 KB" */
export function formatBytes(b: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (b >= 1024 && i < units.length - 1) { b /= 1024; i++; }
  return `${i === 0 ? b : b.toFixed(b < 10 ? 1 : 0)} ${units[i]}`;
}

export const storage = {
  getAppConfig: () => invoke<AppConfig>("get_app_config"),
  defaultDataDir: () => invoke<string>("default_data_dir"),
  setDataDir: (path: string, gitInit: boolean) =>
    invoke<DataDirResult>("set_data_dir", { path, gitInit }),
  /** null resets to the default (<dataDir>/configs). */
  setBackupDir: (path: string | null) => invoke<AppConfig>("set_backup_dir", { path }),

  read: <T>(path: string) => invoke<T | null>("read_json", { path }),
  write: <T>(path: string, value: T) => invoke<void>("write_json", { path, value }),
  remove: (path: string) => invoke<void>("delete_json", { path }),
  list: (dir: string) => invoke<string[]>("list_json", { dir }),

  usage: () => invoke<DataUsage>("data_usage"),

  /** Absolute paths only, and only ones the user picked in a file dialog. */
  importFile: (path: string) => invoke<string>("import_text_file", { path }),
  exportFile: (path: string, contents: string) => invoke<void>("export_text_file", { path, contents }),
};

/** Read a JSON file, falling back to (and filling in missing keys from) a default. */
export async function readWithDefaults<T extends object>(path: string, defaults: T): Promise<T> {
  const stored = await storage.read<Partial<T>>(path);
  return { ...defaults, ...(stored ?? {}) };
}

/** Normalise unknown thrown values (Tauri rejects with plain strings). */
export function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return JSON.stringify(e);
}
