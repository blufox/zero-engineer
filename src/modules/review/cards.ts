/**
 * Flashcards built from cheat sheet items and glossary entries.
 * Card ids are stable across edits to the answer, so progress survives small changes.
 */
import type { SheetEntry } from "../cheatsheets/data";
import type { EntryRecord } from "../glossary/data";

export interface Card {
  id: string;
  deck: string;
  /** Prompt, e.g. "Split pane vertically". */
  front: string;
  /** Where it's from, e.g. "tmux · Panes". */
  context: string;
  /** Cheat sheet answer: key sequences. */
  keys?: string[];
  /** Glossary answer. */
  answer?: string;
  extra?: string[];
  /** In-app link to the source. */
  href: string;
}

export interface Deck { id: string; title: string; kind: "cheatsheet" | "glossary"; count: number }

/** FNV-1a 32-bit, hex. Short and stable. */
export function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function cheatCards(sheets: SheetEntry[]): Card[] {
  const out: Card[] = [];
  for (const { sheet } of sheets) {
    const seen = new Set<string>();
    for (const sec of sheet.sections) {
      for (const item of sec.items) {
        if (!item.description.trim() || !item.keys.length) continue;
        const id = `cs:${sheet.id}:${hash(`${sec.title}|${item.description}`)}`;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({
          id, deck: `cs:${sheet.id}`, front: item.description, context: `${sheet.title} · ${sec.title}`,
          keys: item.keys, href: `/cheatsheets/${sheet.id}`,
        });
      }
    }
  }
  return out;
}

export function glossaryCards(records: EntryRecord[]): Card[] {
  return records
    .filter(({ entry }) => entry.title && entry.summary)
    .map(({ entry }) => ({
      id: `gl:${entry.id}`,
      deck: `gl:${slug(entry.category)}`,
      front: entry.title,
      context: [entry.category, entry.group].filter(Boolean).join(" · "),
      answer: entry.summary,
      extra: (entry.whenToUse ?? entry.signs ?? []).slice(0, 3),
      href: `/glossary/${entry.id}`,
    }));
}

export function decksOf(cards: Card[], titles: Map<string, string>): Deck[] {
  const counts = new Map<string, number>();
  for (const c of cards) counts.set(c.deck, (counts.get(c.deck) ?? 0) + 1);
  return [...counts].map(([id, count]) => ({
    id, count, kind: id.startsWith("cs:") ? "cheatsheet" as const : "glossary" as const, title: titles.get(id) ?? id,
  })).sort((a, b) => a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title));
}
