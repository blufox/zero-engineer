import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { BookOpen, CheckCircle2, ExternalLink, Layers, Library } from "lucide-react";
import { Button, Kbd, PageHeader, cx } from "../../components/ui";
import { useSettings } from "../../lib/settings";
import { errorMessage } from "../../lib/storage";
import type { Card, Deck } from "./cards";
import { buildQueue, countNew, type ReviewState } from "./queue";
import { GRADE_LABEL, dayKey, formatInterval, schedule, type Grade } from "./sm2";
import { loadCards, loadState, saveState } from "./store";

const GRADE_STYLE: Record<Grade, string> = {
  1: "border-danger/40 text-danger hover:bg-danger/10",
  2: "border-warn/40 text-warn hover:bg-warn/10",
  3: "border-accent/40 text-accent hover:bg-accent-soft",
  4: "border-accent/40 text-accent hover:bg-accent-soft",
};

function DeckPicker({ decks, enabled, onToggle }: { decks: Deck[]; enabled: Set<string>; onToggle: (id: string) => void }) {
  const groups: [string, Deck["kind"], typeof Layers][] = [["Cheat sheets", "cheatsheet", Layers], ["Glossary", "glossary", Library]];
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {groups.map(([title, kind, Icon]) => (
        <div key={kind}>
          <h3 className="mb-1.5 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted"><Icon size={13} />{title}</h3>
          <div className="flex flex-wrap gap-1.5">
            {decks.filter((d) => d.kind === kind).map((d) => (
              <button key={d.id} onClick={() => onToggle(d.id)}
                className={cx("rounded-md border px-2 py-1 text-xs transition",
                  enabled.has(d.id) ? "border-accent bg-accent-soft text-accent" : "border-line text-muted hover:text-text")}>
                {d.title} <span className="font-mono text-[10px] opacity-70">{d.count}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function ReviewPage() {
  const { settings, update } = useSettings();
  const navigate = useNavigate();
  const [cards, setCards] = useState<Card[] | null>(null);
  const [decks, setDecks] = useState<Deck[]>([]);
  const [state, setState] = useState<ReviewState | null>(null);
  const [session, setSession] = useState<Card[]>([]);
  const [revealed, setRevealed] = useState(false);
  const [stats, setStats] = useState({ reviewed: 0, again: 0 });
  const [showDecks, setShowDecks] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enabled = useMemo(() => new Set(settings.review.decks), [settings.review.decks]);

  useEffect(() => {
    Promise.all([loadCards(), loadState()])
      .then(([{ cards, decks }, s]) => { setCards(cards); setDecks(decks); setState(s); })
      .catch((e) => setError(errorMessage(e)));
  }, []);

  // (Re)build today's queue when cards load or decks/limits change; not after every grade.
  const stateRef = useRef(state);
  stateRef.current = state;
  const loaded = state !== null;
  useEffect(() => {
    if (!cards || !stateRef.current) return;
    const q = buildQueue(cards, enabled, stateRef.current, settings.review.newPerDay, new Date());
    setSession([...q.due, ...q.fresh]);
    setRevealed(false);
  }, [cards, enabled, settings.review.newPerDay, loaded]);

  const card = session[0];
  const prev = card && state ? state.cards[card.id] : undefined;

  const grade = useCallback(async (g: Grade) => {
    if (!card || !state || !revealed) return;
    const today = new Date();
    const nextState: ReviewState = {
      ...state,
      cards: { ...state.cards, [card.id]: schedule(prev, g, today) },
      newToday: prev ? state.newToday : countNew(state, today),
    };
    setState(nextState);
    // "Again" comes back at the end of this session.
    setSession((s) => (g === 1 ? [...s.slice(1), s[0]] : s.slice(1)));
    setRevealed(false);
    setStats((x) => ({ reviewed: x.reviewed + (g === 1 ? 0 : 1), again: x.again + (g === 1 ? 1 : 0) }));
    try { await saveState(nextState); } catch (e) { setError(errorMessage(e)); }
  }, [card, state, prev, revealed]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.ctrlKey || e.metaKey) return;
      if (!card) return;
      if (!revealed && (e.key === " " || e.key === "Enter")) { e.preventDefault(); setRevealed(true); }
      else if (revealed && ["1", "2", "3", "4"].includes(e.key)) { e.preventDefault(); grade(Number(e.key) as Grade); }
      else if (e.key === "e") navigate(card.href);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [card, revealed, grade, navigate]);

  const toggleDeck = (id: string) => {
    const next = enabled.has(id) ? settings.review.decks.filter((d) => d !== id) : [...settings.review.decks, id];
    update({ review: { ...settings.review, decks: next } });
  };

  const nextDue = useMemo(() => {
    if (!cards || !state) return null;
    const today = dayKey(new Date());
    const dates = cards.filter((c) => enabled.has(c.deck) && state.cards[c.id]).map((c) => state.cards[c.id].due).filter((d) => d > today).sort();
    return dates[0] ?? null;
  }, [cards, state, enabled]);

  const newLeft = session.filter((c) => !state?.cards[c.id]).length;

  return (
    <>
      <PageHeader title="Review"
        description="Spaced repetition over your cheat sheets and glossary. A few minutes a day keeps them in your head."
        actions={<Button onClick={() => setShowDecks(!showDecks)}><BookOpen size={14} /> Decks ({enabled.size})</Button>} />

      {error && <p className="mb-3 rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
      {!cards && !error && <p className="text-sm text-muted">Loading cards…</p>}

      {cards && (showDecks || enabled.size === 0) && (
        <div className="mb-6 rounded-lg border border-line bg-surface p-4">
          {enabled.size === 0 && <p className="mb-3 text-sm">Pick the decks you want to learn. Each one is opt-in.</p>}
          <DeckPicker decks={decks} enabled={enabled} onToggle={toggleDeck} />
          <label className="mt-4 flex items-center gap-2 text-xs text-muted">
            New cards per day
            <select value={settings.review.newPerDay} onChange={(e) => update({ review: { ...settings.review, newPerDay: Number(e.target.value) } })}
              className="rounded border border-line bg-surface px-1.5 py-0.5">
              {[0, 5, 10, 15, 20, 30, 50].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
        </div>
      )}

      {cards && enabled.size > 0 && (
        card ? (
          <div className="mx-auto max-w-2xl">
            <div className="mb-2 flex justify-between text-xs text-muted">
              <span>{session.length} left{newLeft > 0 && ` · ${newLeft} new`}</span>
              <span>{prev ? `seen ${prev.reps}× · ${prev.lapses} lapses` : "new card"}</span>
            </div>
            <div className="rounded-xl border border-line bg-surface p-8 text-center">
              <p className="text-xs text-muted">{card.context}</p>
              <h2 className="selectable mt-3 text-xl font-medium">{card.front}</h2>
              {revealed ? (
                <div className="mt-6 border-t border-line pt-6">
                  {card.keys && (
                    <div className="flex flex-wrap justify-center gap-2">
                      {card.keys.map((k) => <code key={k} className="selectable rounded-md border border-line bg-surface-2 px-2.5 py-1 font-mono text-base">{k}</code>)}
                    </div>
                  )}
                  {card.answer && <p className="selectable text-sm leading-relaxed">{card.answer}</p>}
                  {card.extra && card.extra.length > 0 && (
                    <ul className="mx-auto mt-3 max-w-md list-disc space-y-1 text-left text-xs text-muted">
                      {card.extra.map((x) => <li key={x}>{x}</li>)}
                    </ul>
                  )}
                </div>
              ) : (
                <Button variant="primary" className="mt-8" onClick={() => setRevealed(true)}>Show answer <Kbd>Space</Kbd></Button>
              )}
            </div>
            {revealed && (
              <div className="mt-4 grid grid-cols-4 gap-2">
                {([1, 2, 3, 4] as Grade[]).map((g) => (
                  <button key={g} onClick={() => grade(g)}
                    className={cx("rounded-lg border bg-surface py-2 text-sm font-medium transition", GRADE_STYLE[g])}>
                    {GRADE_LABEL[g]}
                    <span className="block font-mono text-[11px] font-normal opacity-70">{g} · {formatInterval(schedule(prev, g, new Date()).interval)}</span>
                  </button>
                ))}
              </div>
            )}
            <p className="mt-4 text-center text-xs text-muted">
              <Kbd>Space</Kbd> show · <Kbd>1</Kbd>–<Kbd>4</Kbd> grade ·{" "}
              <button onClick={() => navigate(card.href)} className="inline-flex items-center gap-1 hover:text-text"><Kbd>e</Kbd> open source <ExternalLink size={11} /></button>
            </p>
          </div>
        ) : (
          <div className="mx-auto max-w-md rounded-xl border border-line bg-surface p-8 text-center">
            <CheckCircle2 size={28} className="mx-auto text-accent" />
            <h2 className="mt-3 font-medium">All caught up</h2>
            <p className="mt-1 text-sm text-muted">
              {stats.reviewed + stats.again > 0 ? `${stats.reviewed} reviewed, ${stats.again} to relearn. ` : ""}
              {nextDue ? `Next cards are due ${nextDue}.` : "Come back tomorrow for new cards."}
            </p>
          </div>
        )
      )}
    </>
  );
}
