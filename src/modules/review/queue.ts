/** Review state (<data-dir>/review/state.json) and today's queue. */
import type { Card } from "./cards";
import { dayKey, type CardState } from "./sm2";

export interface ReviewState {
  version: 1;
  cards: Record<string, CardState>;
  /** New cards introduced on `date`, for the daily limit. */
  newToday: { date: string; count: number };
}

export const emptyState = (): ReviewState => ({ version: 1, cards: {}, newToday: { date: "", count: 0 } });

export interface Queue { due: Card[]; fresh: Card[] }

/** Due cards (oldest due first), then up to the remaining daily allowance of new cards. */
export function buildQueue(cards: Card[], decks: Set<string>, state: ReviewState, newPerDay: number, today: Date): Queue {
  const key = dayKey(today);
  const usedToday = state.newToday.date === key ? state.newToday.count : 0;
  const active = cards.filter((c) => decks.has(c.deck));
  const due = active
    .filter((c) => state.cards[c.id] && state.cards[c.id].due <= key)
    .sort((a, b) => state.cards[a.id].due.localeCompare(state.cards[b.id].due));
  // New cards: deck order as written (cheat sheets are ordered from basic to advanced).
  const fresh = active.filter((c) => !state.cards[c.id]).slice(0, Math.max(0, newPerDay - usedToday));
  return { due, fresh };
}

/** Record that a never-seen card was introduced today. */
export function countNew(state: ReviewState, today: Date): ReviewState["newToday"] {
  const key = dayKey(today);
  return { date: key, count: (state.newToday.date === key ? state.newToday.count : 0) + 1 };
}
