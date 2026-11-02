import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ask } from "@tauri-apps/plugin-dialog";
import Fuse from "fuse.js";
import { NotebookPen, Pin, Plus, Search } from "lucide-react";
import { Button, Kbd, cx } from "../../components/ui";
import { languageLabel } from "../../lib/languages";
import { relative } from "../tools/time";
import {
  deleteSnippet, loadSnippets, newSnippet, saveSnippet, sortSnippets, tagCounts, TYPE_LABELS,
  type Snippet, type SnippetType,
} from "./data";
import SnippetDetail from "./SnippetDetail";
import SnippetEditor from "./SnippetEditor";

type TypeFilter = "all" | SnippetType;
type EditState = null | { snippet: Snippet; isNew: boolean };

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement ||
  (t instanceof HTMLElement && t.isContentEditable);

export default function SnippetsPage() {
  const { snippetId } = useParams();
  const navigate = useNavigate();
  const [snippets, setSnippets] = useState<Snippet[] | null>(null);
  const [editing, setEditing] = useState<EditState>(null);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(() => loadSnippets().then((l) => setSnippets(sortSnippets(l))), []);
  useEffect(() => { reload(); }, [reload]);

  const fuse = useMemo(() => new Fuse(snippets ?? [], {
    keys: [{ name: "title", weight: 3 }, { name: "tags", weight: 2 }, { name: "content", weight: 1 }],
    threshold: 0.35,
    ignoreLocation: true,
  }), [snippets]);

  const visible = useMemo(() => {
    if (!snippets) return [];
    const base = query.trim() ? fuse.search(query.trim()).map((r) => r.item) : snippets;
    return base.filter((s) =>
      (typeFilter === "all" || s.type === typeFilter) && (!tagFilter || s.tags.includes(tagFilter)));
  }, [snippets, fuse, query, typeFilter, tagFilter]);

  const tags = useMemo(() => tagCounts(snippets ?? []).slice(0, 20), [snippets]);
  const current = snippets?.find((s) => s.id === snippetId) ?? null;

  const startNew = useCallback((type: SnippetType = typeFilter === "all" ? "snippet" : typeFilter) => {
    const lastLang = snippets?.find((s) => s.type === "snippet")?.language;
    const s = newSnippet(type, lastLang);
    if (tagFilter) s.tags = [tagFilter];
    setEditing({ snippet: s, isNew: true });
  }, [snippets, typeFilter, tagFilter]);

  // `?new=note` etc. (from the command palette) opens the editor straight away.
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    const type = params.get("new");
    if (snippets && (type === "snippet" || type === "note" || type === "til")) {
      startNew(type);
      setParams({}, { replace: true });
    }
  }, [params, snippets, startNew, setParams]);

  // Keyboard: Ctrl+N new, "/" search, j/k move through the list, e edit.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "n") { e.preventDefault(); startNew(); return; }
      if (editing || isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "/") { e.preventDefault(); searchRef.current?.focus(); }
      else if ((e.key === "j" || e.key === "k" || e.key === "ArrowDown" || e.key === "ArrowUp") && visible.length) {
        e.preventDefault();
        const i = visible.findIndex((s) => s.id === snippetId);
        const next = e.key === "j" || e.key === "ArrowDown" ? Math.min(i + 1, visible.length - 1) : Math.max(i - 1, 0);
        navigate(`/snippets/${visible[next].id}`, { replace: true });
      } else if (e.key === "e" && current) {
        e.preventDefault();
        setEditing({ snippet: current, isNew: false });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, visible, snippetId, current, navigate, startNew]);

  // Select the first entry when nothing is selected.
  useEffect(() => {
    if (snippets && !snippetId && !editing && visible.length) navigate(`/snippets/${visible[0].id}`, { replace: true });
  }, [snippets, snippetId, editing, visible, navigate]);

  if (!snippets) return null;

  async function handleSave(s: Snippet) {
    await saveSnippet(s);
    await reload();
    setEditing(null);
    navigate(`/snippets/${s.id}`, { replace: true });
  }

  async function togglePin(s: Snippet) {
    await saveSnippet({ ...s, pinned: !s.pinned });
    await reload();
  }

  async function handleDelete(s: Snippet) {
    if (!(await ask(`Delete “${s.title}”?`, { title: "Delete", kind: "warning" }))) return;
    const i = visible.findIndex((x) => x.id === s.id);
    await deleteSnippet(s.id);
    await reload();
    const neighbour = visible[i + 1] ?? visible[i - 1];
    navigate(neighbour ? `/snippets/${neighbour.id}` : "/snippets", { replace: true });
  }

  return (
    <div className="flex h-full">
      <aside className="flex w-80 shrink-0 flex-col border-r border-line">
        <div className="space-y-3 px-4 pt-4 pb-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wide text-muted">Snippets & Notes</span>
            <Button variant="ghost" className="px-2 py-1" onClick={() => startNew()} title="New (Ctrl+N)">
              <Plus size={15} /> New
            </Button>
          </div>
          <div className="flex items-center gap-2 rounded-md border border-line bg-surface px-2.5 focus-within:border-accent">
            <Search size={14} className="shrink-0 text-muted" />
            <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") { setQuery(""); e.currentTarget.blur(); }
                if (e.key === "Enter" && visible[0]) { navigate(`/snippets/${visible[0].id}`); e.currentTarget.blur(); }
              }}
              placeholder="Search titles, tags, content" className="flex-1 bg-transparent py-1.5 text-sm focus:outline-none focus-visible:outline-none" />
            {!query && <Kbd>/</Kbd>}
          </div>
          <div className="flex gap-1">
            {(["all", "snippet", "note", "til"] as TypeFilter[]).map((t) => (
              <button key={t} onClick={() => setTypeFilter(t)}
                className={cx("rounded-md px-2 py-0.5 text-xs transition",
                  typeFilter === t ? "bg-accent-soft text-accent" : "text-muted hover:bg-surface-2 hover:text-text")}>
                {t === "all" ? "All" : TYPE_LABELS[t]}
              </button>
            ))}
          </div>
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {tags.map(([t, n]) => (
                <button key={t} onClick={() => setTagFilter(tagFilter === t ? null : t)}
                  className={cx("rounded px-1.5 py-0.5 text-[11px] transition",
                    tagFilter === t ? "bg-accent text-bg" : "bg-surface-2 text-muted hover:text-text")}>
                  #{t} <span className="opacity-60">{n}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto border-t border-line">
          {visible.map((s) => (
            <button key={s.id} onClick={() => { setEditing(null); navigate(`/snippets/${s.id}`); }}
              className={cx("block w-full border-b border-line/60 px-4 py-2.5 text-left transition",
                s.id === snippetId && !editing?.isNew ? "bg-surface-2" : "hover:bg-surface-2/60")}>
              <div className="flex items-center gap-1.5">
                {s.pinned && <Pin size={11} className="shrink-0 text-accent" />}
                <span className="truncate text-[13px] font-medium">{s.title}</span>
              </div>
              <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted">
                <span>{s.type === "snippet" ? languageLabel(s.language) : TYPE_LABELS[s.type]}</span>
                {s.tags.slice(0, 3).map((t) => <span key={t}>#{t}</span>)}
                <span className="ml-auto shrink-0">{relative(new Date(s.updatedAt))}</span>
              </div>
            </button>
          ))}
          {visible.length === 0 && snippets.length > 0 && (
            <p className="px-4 py-6 text-center text-xs text-muted">No matches</p>
          )}
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        {editing ? (
          <SnippetEditor key={editing.snippet.id} initial={editing.snippet} isNew={editing.isNew}
            onSave={handleSave} onCancel={() => setEditing(null)} />
        ) : current ? (
          <SnippetDetail snippet={current}
            onEdit={() => setEditing({ snippet: current, isNew: false })}
            onTogglePin={() => togglePin(current)}
            onDelete={() => handleDelete(current)} />
        ) : (
          <div className="grid h-full place-items-center">
            <div className="text-center">
              <NotebookPen size={32} strokeWidth={1.5} className="mx-auto mb-3 text-muted" />
              <p className="mb-1 font-medium">Capture what you learn</p>
              <p className="mb-5 text-sm text-muted">Code snippets, Markdown notes and quick TILs, saved as JSON in your data repo.</p>
              <div className="flex justify-center gap-2">
                <Button variant="primary" onClick={() => startNew("snippet")}>New snippet</Button>
                <Button onClick={() => startNew("note")}>New note</Button>
                <Button onClick={() => startNew("til")}>New TIL</Button>
              </div>
              <p className="mt-4 text-xs text-muted"><Kbd>Ctrl+N</Kbd> new · <Kbd>/</Kbd> search · <Kbd>j</Kbd>/<Kbd>k</Kbd> move · <Kbd>e</Kbd> edit</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
