import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Archive, FileCode2, GitCommitHorizontal, KeyRound, ListTodo, RefreshCw, StickyNote, X } from "lucide-react";
import { Button, cx } from "../../components/ui";
import { useSettings } from "../../lib/settings";
import { errorMessage } from "../../lib/storage";
import { context, launch, type EnvDrift, type RepoContext, type RepoInfo } from "../../lib/system";
import { relative } from "../tools/time";
import { readNote, writeNote, type RepoNote } from "./notes";

function Section({ icon: Icon, title, count, children }: {
  icon: typeof StickyNote; title: string; count?: number; children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted">
        <Icon size={13} /> {title}
        {count !== undefined && <span className="font-mono normal-case text-muted/70">{count}</span>}
      </h3>
      {children}
    </section>
  );
}

const STATUS_COLOR: Record<string, string> = { M: "text-warn", A: "text-accent", D: "text-danger", "??": "text-muted", UU: "text-danger", R: "text-accent" };

export function EnvDriftView({ env }: { env: EnvDrift }) {
  if (!env.exampleFile) return <p className="text-xs text-muted">No .env.example to compare against.</p>;
  if (!env.hasEnv) return <p className="text-xs text-warn">No .env file. Copy {env.exampleFile} to get started.</p>;
  const rows: [string, string[], string][] = [
    ["Missing", env.missing, "text-danger"],
    ["Empty", env.empty, "text-warn"],
    ["Only in .env", env.extra, "text-muted"],
  ];
  if (rows.every(([, keys]) => keys.length === 0)) {
    return <p className="text-xs text-accent">.env has every key in {env.exampleFile}.</p>;
  }
  return (
    <div className="space-y-1.5 text-xs">
      {rows.filter(([, keys]) => keys.length > 0).map(([label, keys, color]) => (
        <div key={label}>
          <span className={cx("font-medium", color)}>{label}</span>
          <div className="mt-0.5 flex flex-wrap gap-1">
            {keys.map((k) => <code key={k} className="selectable rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px]">{k}</code>)}
          </div>
        </div>
      ))}
      <p className="text-muted/70">Compared with {env.exampleFile}. Values are never read into the app.</p>
    </div>
  );
}

export default function RepoPanel({ repo, onClose, onNoteChange }: {
  repo: RepoInfo;
  onClose: () => void;
  onNoteChange?: (note: RepoNote | null) => void;
}) {
  const { settings } = useSettings();
  const navigate = useNavigate();
  const [ctx, setCtx] = useState<RepoContext | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [savedNote, setSavedNote] = useState<RepoNote | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setCtx(await context.repo(repo.path));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setCtx(null);
    load();
    readNote(repo).then((n) => { setSavedNote(n); setNote(n?.note ?? ""); }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo.path]);

  async function saveNote() {
    if (note === (savedNote?.note ?? "")) return;
    const n = await writeNote(repo, note);
    setSavedNote(n);
    onNoteChange?.(n);
  }

  // Esc closes the panel, unless you're typing in the note.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !(e.target instanceof HTMLTextAreaElement)) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const open = (file: string, line?: number) =>
    launch.editor(`${repo.path}/${file}`, settings, line).catch((e) => setError(errorMessage(e)));

  return (
    <aside className="flex w-[26rem] shrink-0 flex-col border-l border-line bg-surface">
      <header className="flex items-start justify-between gap-2 border-b border-line px-5 py-4">
        <div className="min-w-0">
          <h2 className="truncate font-medium">{repo.name}</h2>
          <p className="truncate font-mono text-xs text-muted">{ctx?.branch ?? repo.branch ?? "…"}</p>
        </div>
        <div className="flex shrink-0 gap-1">
          <button title="Refresh" onClick={load} className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-text">
            <RefreshCw size={14} className={cx(loading && "animate-spin")} />
          </button>
          <button title="Close (Esc)" onClick={onClose} className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-text">
            <X size={14} />
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-4">
        {error && <p className="rounded-md bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>}

        <Section icon={StickyNote} title="Next step">
          <textarea value={note} onChange={(e) => setNote(e.target.value)} onBlur={saveNote}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); saveNote(); }
              if (e.key === "Escape") e.currentTarget.blur();
            }}
            rows={3} placeholder="What were you about to do? Saved when you click away."
            className="w-full resize-y rounded-md border border-line bg-bg px-3 py-2 text-sm placeholder:text-muted focus:border-accent focus:outline-none" />
          {savedNote && <p className="text-[11px] text-muted">Saved {relative(new Date(savedNote.updatedAt))}</p>}
        </Section>

        {!ctx && loading && <p className="text-xs text-muted">Reading repo…</p>}

        {ctx && (
          <>
            <Section icon={FileCode2} title="Uncommitted, most recent first" count={ctx.files.length}>
              {ctx.files.length === 0 ? <p className="text-xs text-muted">Working tree is clean.</p> : (
                <ul className="space-y-0.5">
                  {ctx.files.map((f) => (
                    <li key={f.path}>
                      <button onClick={() => open(f.path)} disabled={f.status === "D"}
                        className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-xs hover:bg-surface-2 disabled:pointer-events-none">
                        <span className={cx("w-5 shrink-0 font-mono", STATUS_COLOR[f.status] ?? "text-muted")}>{f.status}</span>
                        <span className="min-w-0 flex-1 truncate font-mono" title={f.path}>{f.path}</span>
                        {f.modified > 0 && <span className="shrink-0 text-muted">{relative(new Date(f.modified * 1000))}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section icon={ListTodo} title="TODOs you added" count={ctx.todos.length}>
              {ctx.todos.length === 0 ? <p className="text-xs text-muted">None in your changes or your commits from the last 14 days.</p> : (
                <ul className="space-y-0.5">
                  {ctx.todos.map((t) => (
                    <li key={`${t.file}:${t.line}:${t.text}`}>
                      <button onClick={() => open(t.file, t.line)} title={`${t.file}:${t.line} (${t.source})`}
                        className="w-full rounded px-1.5 py-1 text-left text-xs hover:bg-surface-2">
                        <span className="block truncate font-mono">{t.text}</span>
                        <span className="block truncate text-muted">{t.file}:{t.line}{t.source === "uncommitted" && " · uncommitted"}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section icon={GitCommitHorizontal} title="Recent commits">
              <ul className="space-y-1 text-xs">
                {ctx.commits.map((c) => (
                  <li key={c.hash} className="flex gap-2">
                    <span className="shrink-0 font-mono text-muted">{c.hash}</span>
                    <span className="selectable min-w-0 flex-1 truncate" title={c.subject}>{c.subject}</span>
                    <span className="shrink-0 text-muted">{relative(new Date(c.date))}</span>
                  </li>
                ))}
                {ctx.commits.length === 0 && <li className="text-muted">No commits yet.</li>}
              </ul>
            </Section>

            {ctx.stashes.length > 0 && (
              <Section icon={Archive} title="Stashes" count={ctx.stashes.length}>
                <ul className="space-y-0.5 font-mono text-xs">
                  {ctx.stashes.map((s) => <li key={s} className="selectable truncate" title={s}>{s}</li>)}
                </ul>
              </Section>
            )}

            <Section icon={KeyRound} title=".env">
              <EnvDriftView env={ctx.env} />
            </Section>
          </>
        )}
      </div>

      <footer className="flex gap-2 border-t border-line px-5 py-3">
        <Button onClick={() => navigate(`/logs?repo=${encodeURIComponent(repo.path)}`)}>Logs</Button>
        <Button onClick={() => launch.terminal(repo.path, settings)}>Terminal</Button>
        <Button onClick={() => launch.editor(repo.path, settings)}>Open in {settings.editorCommand.split(" ")[0]}</Button>
      </footer>
    </aside>
  );
}
