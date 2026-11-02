import { describe, expect, it } from "vitest";
import { cheatCards, glossaryCards, hash } from "./cards";
import { buildQueue, countNew, emptyState } from "./queue";
import { dayKey, formatInterval, schedule } from "./sm2";
import type { SheetEntry } from "../cheatsheets/data";
import type { EntryRecord } from "../glossary/data";

const today = new Date(2026, 10, 3); // 3 Nov 2026, local

describe("schedule", () => {
  it("grows intervals on Good: 1d, 3d, then × ease", () => {
    const a = schedule(undefined, 3, today);
    expect([a.interval, a.due]).toEqual([1, "2026-11-04"]);
    const b = schedule(a, 3, today);
    expect(b.interval).toBe(3);
    const c = schedule(b, 3, today);
    expect(c.interval).toBe(8); // round(3 * 2.5)
    expect(c.reps).toBe(3);
  });

  it("Again resets and lowers ease, counting a lapse", () => {
    const learned = schedule(schedule(undefined, 3, today), 3, today);
    const f = schedule(learned, 1, today);
    expect(f).toMatchObject({ interval: 0, reps: 0, lapses: 1, due: "2026-11-03" });
    expect(f.ease).toBeCloseTo(2.3);
    // Again on a brand-new card isn't a lapse.
    expect(schedule(undefined, 1, today).lapses).toBe(0);
  });

  it("Easy beats Good, Hard is shorter, ease never drops below 1.3", () => {
    const base = schedule(schedule(undefined, 3, today), 3, today);
    expect(schedule(base, 4, today).interval).toBeGreaterThan(schedule(base, 3, today).interval);
    expect(schedule(base, 2, today).interval).toBeLessThan(schedule(base, 3, today).interval);
    let s = base;
    for (let i = 0; i < 20; i++) s = schedule(s, 2, today);
    expect(s.ease).toBe(1.3);
  });

  it("formats intervals", () => {
    expect([0, 1, 13, 21, 90, 400].map(formatInterval)).toEqual(["now", "1d", "13d", "3w", "3mo", "1.1y"]);
    expect(dayKey(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});

const sheets = [{
  origin: "builtin",
  sheet: {
    id: "tmux", title: "tmux", tags: [],
    sections: [{ title: "Panes", items: [
      { keys: ["Ctrl+b %"], description: "Split vertically" },
      { keys: ["Ctrl+b \""], description: "Split horizontally" },
      { keys: ["x"], description: "Split vertically" }, // duplicate prompt in the same section
      { keys: [], description: "No keys" },
    ] }],
  },
}] as SheetEntry[];

const glossary = [
  { origin: "builtin", entry: { id: "strategy", title: "Strategy", category: "Design Patterns", group: "Behavioral", summary: "Swap algorithms.", whenToUse: ["a", "b", "c", "d"] } },
  { origin: "builtin", entry: { id: "empty", title: "Empty", category: "Design Patterns", summary: "" } },
] as EntryRecord[];

describe("cards", () => {
  it("builds stable, de-duplicated cheat sheet cards", () => {
    const c = cheatCards(sheets);
    expect(c).toHaveLength(2);
    expect(c[0]).toMatchObject({ deck: "cs:tmux", front: "Split vertically", context: "tmux · Panes", keys: ["Ctrl+b %"] });
    expect(c[0].id).toBe(`cs:tmux:${hash("Panes|Split vertically")}`);
    // Editing the answer keeps the id (and so the progress).
    const edited = structuredClone(sheets);
    edited[0].sheet.sections[0].items[0].keys = ["Prefix %"];
    expect(cheatCards(edited)[0].id).toBe(c[0].id);
  });

  it("builds glossary cards per category", () => {
    const g = glossaryCards(glossary);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ id: "gl:strategy", deck: "gl:design-patterns", context: "Design Patterns · Behavioral", answer: "Swap algorithms." });
    expect(g[0].extra).toHaveLength(3);
  });
});

describe("queue", () => {
  const cards = [...cheatCards(sheets), ...glossaryCards(glossary)];
  const decks = new Set(["cs:tmux", "gl:design-patterns"]);

  it("limits new cards per day and puts due cards first", () => {
    const state = emptyState();
    state.cards[cards[2].id] = { ease: 2.5, interval: 3, due: "2026-11-01", reps: 2, lapses: 0 };
    state.cards[cards[1].id] = { ease: 2.5, interval: 3, due: "2026-11-09", reps: 2, lapses: 0 };
    const q = buildQueue(cards, decks, state, 10, today);
    expect(q.due.map((c) => c.id)).toEqual([cards[2].id]);
    expect(q.fresh.map((c) => c.id)).toEqual([cards[0].id]);
    state.newToday = { date: "2026-11-03", count: 10 };
    expect(buildQueue(cards, decks, state, 10, today).fresh).toHaveLength(0);
  });

  it("ignores disabled decks and resets the daily count on a new day", () => {
    expect(buildQueue(cards, new Set(["gl:design-patterns"]), emptyState(), 10, today).fresh).toHaveLength(1);
    const s = emptyState();
    s.newToday = { date: "2026-11-02", count: 10 };
    expect(countNew(s, today)).toEqual({ date: "2026-11-03", count: 1 });
  });
});
