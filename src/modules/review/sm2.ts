/**
 * SM-2 scheduling (the algorithm behind classic Anki), with four grades.
 * Intervals are whole days; `due` is a local calendar date (YYYY-MM-DD).
 */

export type Grade = 1 | 2 | 3 | 4; // Again, Hard, Good, Easy

export const GRADE_LABEL: Record<Grade, string> = { 1: "Again", 2: "Hard", 3: "Good", 4: "Easy" };

export interface CardState {
  ease: number;
  /** Days until the next review; 0 = again today. */
  interval: number;
  due: string;
  /** Successful reviews in a row. */
  reps: number;
  lapses: number;
}

const START_EASE = 2.5;
const MIN_EASE = 1.3;

/** Local date as YYYY-MM-DD. */
export function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function addDays(d: Date, days: number): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() + days);
  return x;
}

export function schedule(prev: CardState | undefined, grade: Grade, today: Date): CardState {
  const ease = prev?.ease ?? START_EASE;
  const reps = prev?.reps ?? 0;
  const lapses = prev?.lapses ?? 0;
  const last = prev?.interval ?? 0;
  let next: Omit<CardState, "due">;

  if (grade === 1) {
    // Forgot: start over, show again in this session.
    next = { ease: prev ? Math.max(MIN_EASE, ease - 0.2) : ease, interval: 0, reps: 0, lapses: prev && reps > 0 ? lapses + 1 : lapses };
  } else if (grade === 2) {
    next = { ease: Math.max(MIN_EASE, ease - 0.15), interval: Math.max(1, Math.round(last * 1.2)), reps: reps + 1, lapses };
  } else {
    const good = reps === 0 ? 1 : reps === 1 ? 3 : Math.max(last + 1, Math.round(last * ease));
    next = grade === 3
      ? { ease, interval: good, reps: reps + 1, lapses }
      : { ease: ease + 0.15, interval: reps === 0 ? 4 : Math.max(good + 1, Math.round(good * 1.3)), reps: reps + 1, lapses };
  }
  return { ...next, due: dayKey(addDays(today, next.interval)) };
}

/** "now", "1d", "3w", "2mo" for the grade buttons. */
export function formatInterval(days: number): string {
  if (days <= 0) return "now";
  if (days < 14) return `${days}d`;
  if (days < 60) return `${Math.round(days / 7)}w`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${(days / 365).toFixed(1)}y`;
}
