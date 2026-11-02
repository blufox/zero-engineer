/**
 * "Next step" notes per repo: <data-dir>/repo-notes/<group>-<name>.json.
 * Keyed by group + name rather than the absolute path, so notes survive a move to a new machine.
 */
import { storage } from "../../lib/storage";
import type { RepoInfo } from "../../lib/system";

export interface RepoNote {
  path: string;
  name: string;
  note: string;
  /** ISO timestamp. */
  updatedAt: string;
}

const DIR = "repo-notes";

export const noteSlug = (r: Pick<RepoInfo, "group" | "name">) =>
  [r.group, r.name].filter(Boolean).join("-").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "repo";

export const readNote = (r: RepoInfo) => storage.read<RepoNote>(`${DIR}/${noteSlug(r)}.json`);

export async function writeNote(r: RepoInfo, note: string): Promise<RepoNote | null> {
  const file = `${DIR}/${noteSlug(r)}.json`;
  if (!note.trim()) {
    await storage.remove(file).catch(() => {});
    return null;
  }
  const value: RepoNote = { path: r.path, name: r.name, note, updatedAt: new Date().toISOString() };
  await storage.write(file, value);
  return value;
}

export async function readAllNotes(): Promise<RepoNote[]> {
  const files = await storage.list(DIR).catch(() => [] as string[]);
  const notes = await Promise.all(files.map((f) => storage.read<RepoNote>(`${DIR}/${f}`).catch(() => null)));
  return notes.filter((n): n is RepoNote => !!n);
}
