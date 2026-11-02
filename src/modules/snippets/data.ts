/**
 * Snippets & notes: one JSON file per entry at <data-dir>/snippets/<id>.json,
 * so git diffs stay small and two machines rarely conflict.
 */
import { v7 } from "uuid";
import { storage } from "../../lib/storage";

export type SnippetType = "snippet" | "note" | "til";

export interface Snippet {
  id: string;
  title: string;
  type: SnippetType;
  /** Language id from lib/languages.ts; "markdown" renders as formatted text. */
  language: string;
  content: string;
  tags: string[];
  pinned: boolean;
  /** Optional link to where you learnt it. */
  source?: string;
  createdAt: string;
  updatedAt: string;
}

export const TYPE_LABELS: Record<SnippetType, string> = {
  snippet: "Snippet",
  note: "Note",
  til: "TIL",
};

const DIR = "snippets";

export function newSnippet(type: SnippetType, language = "plaintext"): Snippet {
  const now = new Date().toISOString();
  return {
    id: v7(),
    title: "",
    type,
    language: type === "snippet" ? language : "markdown",
    content: "",
    tags: [],
    pinned: false,
    createdAt: now,
    updatedAt: now,
  };
}

function normalize(raw: Partial<Snippet>, fallbackId: string): Snippet {
  const now = new Date().toISOString();
  return {
    id: raw.id || fallbackId,
    title: raw.title ?? "Untitled",
    type: raw.type === "note" || raw.type === "til" ? raw.type : "snippet",
    language: raw.language ?? "plaintext",
    content: raw.content ?? "",
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    pinned: !!raw.pinned,
    source: raw.source || undefined,
    createdAt: raw.createdAt ?? now,
    updatedAt: raw.updatedAt ?? raw.createdAt ?? now,
  };
}

export async function loadSnippets(): Promise<Snippet[]> {
  const files = await storage.list(DIR);
  const all = await Promise.all(
    files.map(async (f) => {
      try {
        const raw = await storage.read<Partial<Snippet>>(`${DIR}/${f}`);
        return raw ? normalize(raw, f.replace(/\.json$/, "")) : null;
      } catch (e) {
        console.warn(`Skipping invalid snippet ${f}`, e);
        return null;
      }
    }),
  );
  return all.filter((s): s is Snippet => s !== null);
}

export const saveSnippet = (s: Snippet) => storage.write(`${DIR}/${s.id}.json`, s);
export const deleteSnippet = (id: string) => storage.remove(`${DIR}/${id}.json`);

/** Pinned first, then most recently updated. */
export function sortSnippets(list: Snippet[]): Snippet[] {
  return [...list].sort((a, b) =>
    a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : b.updatedAt.localeCompare(a.updatedAt));
}

/** Tags with usage counts, most used first. */
export function tagCounts(list: Snippet[]): [string, number][] {
  const m = new Map<string, number>();
  for (const s of list) for (const t of s.tags) m.set(t, (m.get(t) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
