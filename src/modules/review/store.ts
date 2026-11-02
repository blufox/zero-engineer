/** Loading cards and saving review progress. */
import { storage } from "../../lib/storage";
import type { Settings } from "../../lib/settings";
import { loadSheets } from "../cheatsheets/data";
import { loadEntries } from "../glossary/data";
import { cheatCards, decksOf, glossaryCards, slug, type Card, type Deck } from "./cards";
import { buildQueue, emptyState, type ReviewState } from "./queue";

const STATE_FILE = "review/state.json";

export async function loadCards(): Promise<{ cards: Card[]; decks: Deck[] }> {
  const [sheets, entries] = await Promise.all([loadSheets(), loadEntries()]);
  const cards = [...cheatCards(sheets), ...glossaryCards(entries)];
  const titles = new Map<string, string>([
    ...sheets.map(({ sheet }) => [`cs:${sheet.id}`, sheet.title] as [string, string]),
    ...entries.map(({ entry }) => [`gl:${slug(entry.category)}`, entry.category] as [string, string]),
  ]);
  return { cards, decks: decksOf(cards, titles) };
}

export async function loadState(): Promise<ReviewState> {
  const s = await storage.read<ReviewState>(STATE_FILE).catch(() => null);
  return s?.version === 1 ? { ...emptyState(), ...s } : emptyState();
}

export const saveState = (s: ReviewState) => storage.write(STATE_FILE, s);

/** Cards to review today (due + new allowance), for the Home card. */
export async function countToday(review: Settings["review"]): Promise<number> {
  if (!review.decks.length) return 0;
  const [{ cards }, state] = await Promise.all([loadCards(), loadState()]);
  const q = buildQueue(cards, new Set(review.decks), state, review.newPerDay, new Date());
  return q.due.length + q.fresh.length;
}
