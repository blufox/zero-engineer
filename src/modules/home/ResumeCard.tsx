import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { GitBranch, GraduationCap, History } from "lucide-react";
import { useSettings } from "../../lib/settings";
import { isDirty, type RepoInfo } from "../../lib/system";
import { loadRepos } from "../repos/ReposPage";
import { readAllNotes, type RepoNote } from "../repos/notes";
import { relative } from "../tools/time";
import { countToday } from "../review/store";

interface Item { repo: RepoInfo; note?: RepoNote; at: number }

const DAY = 86_400_000;

/** Rank repos by your latest activity: last commit or note edit, with uncommitted work boosted a day. */
export function rankRecent(list: RepoInfo[], notes: RepoNote[], limit = 3): Item[] {
  const byPath = new Map(notes.map((n) => [n.path, n]));
  return list
    .map((repo) => {
      const note = byPath.get(repo.path);
      const commit = repo.lastCommit ? Date.parse(repo.lastCommit.date) : 0;
      const noted = note ? Date.parse(note.updatedAt) : 0;
      const at = Math.max(commit, noted);
      return { repo, note, at, score: at + (isDirty(repo) ? DAY : 0) };
    })
    .filter((i) => i.at > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** "12 flashcards to review today" link; hidden when nothing is due or no decks are on. */
export function DueCard() {
  const { settings } = useSettings();
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    countToday(settings.review).then((c) => live && setN(c)).catch(() => {});
    return () => { live = false; };
  }, [settings.review]);
  if (!n) return null;
  return (
    <Link to="/review" className="mb-3 flex items-center gap-2 rounded-lg border border-line bg-surface px-4 py-3 text-sm transition hover:border-accent">
      <GraduationCap size={16} className="text-accent" />
      <span><b>{n}</b> flashcard{n > 1 && "s"} to review today</span>
      <span className="ml-auto text-xs text-muted">Review →</span>
    </Link>
  );
}

export default function ResumeCard() {
  const { settings } = useSettings();
  const [items, setItems] = useState<Item[] | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([loadRepos(settings), readAllNotes()])
      .then(([list, notes]) => live && setItems(rankRecent(list, notes)))
      .catch(() => live && setItems([]));
    return () => { live = false; };
  }, [settings]);

  if (items && items.length === 0) return null;

  return (
    <section className="mb-6 rounded-lg border border-line bg-surface p-4">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-medium">
        <History size={16} className="text-accent" /> Pick up where you left off
      </h2>
      {!items ? <p className="text-xs text-muted">Reading repos…</p> : (
        <ul className="divide-y divide-line">
          {items.map(({ repo, note, at }) => (
            <li key={repo.path}>
              <Link to={`/repos?repo=${encodeURIComponent(repo.path)}`}
                className="-mx-2 block rounded-md px-2 py-2 transition hover:bg-surface-2">
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-medium">{repo.name}</span>
                  <span className="flex items-center gap-1 font-mono text-xs text-muted"><GitBranch size={11} />{repo.branch ?? "detached"}</span>
                  {isDirty(repo) && <span className="text-xs text-warn">uncommitted changes</span>}
                  <span className="ml-auto text-xs text-muted">{relative(new Date(at))}</span>
                </div>
                <p className="mt-0.5 truncate text-xs text-muted">
                  {note ? <>Next: <span className="text-text">{note.note.split("\n")[0]}</span></> : repo.lastCommit?.subject}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
