import { useSyncExternalStore } from "react";
import { migrations, type MigrationStatus } from "./system";

// Last migration check per repo path, shared by the Repos page, repo panel and Databases page.
let state: Record<string, MigrationStatus> = {};
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export async function checkMigrations(paths: string[]): Promise<void> {
  const results = await migrations.status(paths);
  const next = { ...state };
  for (const p of paths) delete next[p];
  for (const r of results) next[r.path] = r;
  state = next;
  emit();
}

export function useMigrations(): Record<string, MigrationStatus> {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => state);
}
