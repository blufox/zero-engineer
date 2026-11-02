/**
 * Cheat sheet storage.
 *
 * - Built-in sheets live in src/seed/cheatsheets/*.json and ship with the app (read-only).
 * - User sheets live in <data-dir>/cheatsheets/<id>.json.
 * - A user file with the same id as a built-in overrides it ("modified");
 *   deleting that file restores the built-in.
 */
import { storage } from "../../lib/storage";

export interface CheatItem {
  /** Alternative key sequences for the same action, e.g. ["gt", ":tabn[ext]"]. */
  keys: string[];
  description: string;
}

export interface CheatSection {
  title: string;
  items: CheatItem[];
}

export interface CheatSheet {
  id: string;
  title: string;
  description?: string;
  tags: string[];
  source?: { name: string; url: string; license?: string };
  sections: CheatSection[];
}

export type Origin = "builtin" | "modified" | "custom";

export interface SheetEntry {
  sheet: CheatSheet;
  origin: Origin;
}

const DIR = "cheatsheets";

const builtinModules = import.meta.glob<CheatSheet>("../../seed/cheatsheets/*.json", {
  eager: true,
  import: "default",
});

export const BUILTINS: CheatSheet[] = Object.values(builtinModules).map(normalize);

const isBuiltin = (id: string) => BUILTINS.some((b) => b.id === id);

/** Coerce loosely-shaped JSON (e.g. hand-written or imported) into a valid sheet. */
export function normalize(raw: unknown): CheatSheet {
  if (!raw || typeof raw !== "object") throw new Error("A cheat sheet must be a JSON object");
  const r = raw as Record<string, unknown>;
  const title = typeof r.title === "string" && r.title.trim() ? r.title.trim() : "Untitled";
  const sections = Array.isArray(r.sections) ? r.sections : [];
  return {
    id: typeof r.id === "string" && r.id ? slugify(r.id) : slugify(title),
    title,
    description: typeof r.description === "string" ? r.description : undefined,
    tags: Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === "string") : [],
    source: r.source && typeof r.source === "object" ? (r.source as CheatSheet["source"]) : undefined,
    sections: sections.map((s: Record<string, unknown>) => ({
      title: String(s?.title ?? "Untitled section"),
      items: (Array.isArray(s?.items) ? s.items : []).map((i: Record<string, unknown>) => ({
        keys: Array.isArray(i?.keys) ? i.keys.map(String) : [String(i?.keys ?? "")],
        description: String(i?.description ?? ""),
      })),
    })),
  };
}

export function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "sheet";
}

export async function loadSheets(): Promise<SheetEntry[]> {
  const files = await storage.list(DIR);
  const user = new Map<string, CheatSheet>();
  for (const f of files) {
    try {
      const sheet = normalize(await storage.read(`${DIR}/${f}`));
      user.set(sheet.id, sheet);
    } catch (e) {
      console.warn(`Skipping invalid cheat sheet ${f}`, e);
    }
  }
  const entries: SheetEntry[] = BUILTINS.map((b) =>
    user.has(b.id) ? { sheet: user.get(b.id)!, origin: "modified" } : { sheet: b, origin: "builtin" },
  );
  for (const [id, sheet] of user) {
    if (!isBuiltin(id)) entries.push({ sheet, origin: "custom" });
  }
  return entries.sort((a, b) => a.sheet.title.localeCompare(b.sheet.title));
}

export const saveSheet = (sheet: CheatSheet) => storage.write(`${DIR}/${sheet.id}.json`, sheet);

/** Deletes a custom sheet, or resets a modified built-in to its shipped version. */
export const deleteSheet = (id: string) => storage.remove(`${DIR}/${id}.json`);

/** Pick an id that doesn't collide with any existing sheet. */
export function uniqueId(base: string, taken: string[]): string {
  let id = slugify(base);
  for (let n = 2; taken.includes(id); n++) id = `${slugify(base)}-${n}`;
  return id;
}

export const countItems = (s: CheatSheet) => s.sections.reduce((n, sec) => n + sec.items.length, 0);
