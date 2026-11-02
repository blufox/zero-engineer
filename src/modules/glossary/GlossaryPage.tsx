import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ask } from "@tauri-apps/plugin-dialog";
import Fuse from "fuse.js";
import { ExternalLink, Plus, Search } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Kbd, cx } from "../../components/ui";
import {
  categoriesOf, CUSTOM_CATEGORY, deleteEntry, loadEntries, saveEntry, slugify, uniqueId,
  type EntryRecord, type GlossaryEntry,
} from "./data";
import EntryEditor from "./EntryEditor";
import EntryView, { Inline } from "./EntryView";

type EditState = null | { entry: GlossaryEntry; isNew: boolean };

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || (t instanceof HTMLElement && t.isContentEditable);

export default function GlossaryPage() {
  const { entryId } = useParams();
  const navigate = useNavigate();
  const [records, setRecords] = useState<EntryRecord[] | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<EditState>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const reload = useCallback(() => loadEntries().then(setRecords), []);
  useEffect(() => { reload(); }, [reload]);

  const byId = useMemo(() => new Map((records ?? []).map((r) => [r.entry.id, r])), [records]);
  const titles = useMemo(() => new Map((records ?? []).map((r) => [r.entry.id, r.entry.title])), [records]);
  const categories = useMemo(() => categoriesOf(records ?? []), [records]);
  const current = entryId ? byId.get(entryId) : undefined;

  // Follow the open entry's category so the list shows its neighbours.
  useEffect(() => {
    if (current && !query) setCategory(current.entry.category);
  }, [current, query]);
  useEffect(() => {
    if (!category && categories[0]) setCategory(categories[0].title);
  }, [categories, category]);
  useEffect(() => setEditing(null), [entryId]);

  const fuse = useMemo(() => new Fuse(records ?? [], {
    keys: [{ name: "entry.title", weight: 4 }, { name: "entry.summary", weight: 1.5 }, { name: "entry.group", weight: 1 },
      { name: "entry.notes", weight: 1 }, { name: "entry.signs", weight: 0.5 }],
    threshold: 0.35, ignoreLocation: true,
  }), [records]);

  const list = useMemo(() => {
    if (!records) return [];
    if (query.trim()) return fuse.search(query.trim()).slice(0, 60).map((r) => r.item);
    return records.filter((r) => r.entry.category === category);
  }, [records, fuse, query, category]);

  // Group headings for the browse list, following the collection's group order.
  const grouped = useMemo(() => {
    if (query.trim()) return [{ group: "", items: list }];
    const order = categories.find((c) => c.title === category)?.collection?.groups ?? [];
    const map = new Map<string, EntryRecord[]>();
    for (const r of list) {
      const g = r.entry.group ?? "";
      map.set(g, [...(map.get(g) ?? []), r]);
    }
    return [...map.entries()]
      .sort(([a], [b]) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99) || a.localeCompare(b))
      .map(([group, items]) => ({ group, items }));
  }, [list, query, categories, category]);
  const flat = grouped.flatMap((g) => g.items);

  const open = useCallback((id: string) => navigate(`/glossary/${id}`), [navigate]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editing || isTyping(e.target) || e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key === "/") { e.preventDefault(); searchRef.current?.focus(); }
      else if ((e.key === "j" || e.key === "k") && flat.length) {
        e.preventDefault();
        const i = flat.findIndex((r) => r.entry.id === entryId);
        const next = e.key === "j" ? Math.min(i + 1, flat.length - 1) : Math.max(i - 1, 0);
        navigate(`/glossary/${flat[next].entry.id}`, { replace: true });
      } else if (e.key === "e" && current) {
        e.preventDefault();
        setEditing({ entry: current.entry, isNew: false });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, flat, entryId, current, navigate]);

  // Keep the selected list item in view when moving with j/k.
  useEffect(() => {
    listRef.current?.querySelector(`[data-id="${entryId}"]`)?.scrollIntoView({ block: "nearest" });
  }, [entryId]);

  if (!records) return null;
  const activeCollection = categories.find((c) => c.title === category)?.collection;

  async function handleSave(e: GlossaryEntry) {
    const final = editing?.isNew ? { ...e, id: uniqueId(e.title, new Set(byId.keys())) } : e;
    await saveEntry(final);
    await reload();
    setEditing(null);
    navigate(`/glossary/${final.id}`);
  }

  async function handleDelete(r: EntryRecord) {
    const restoring = r.origin === "modified";
    const ok = await ask(
      restoring ? `Discard your edits and notes on “${r.entry.title}” and restore the built-in entry?` : `Delete “${r.entry.title}”?`,
      { title: restoring ? "Restore built-in" : "Delete entry", kind: "warning" },
    );
    if (!ok) return;
    await deleteEntry(r.entry.id);
    await reload();
    if (!restoring) navigate("/glossary");
  }

  function startNew() {
    const cat = category && !categories.find((c) => c.title === category)?.collection ? category : CUSTOM_CATEGORY;
    setEditing({ isNew: true, entry: { id: slugify("new"), title: "", category: cat, summary: "" } });
  }

  return (
    <div className="flex h-full">
      {/* Categories */}
      <nav className="flex w-52 shrink-0 flex-col border-r border-line">
        <div className="flex items-center justify-between px-4 pt-4 pb-3">
          <span className="text-xs font-medium uppercase tracking-wide text-muted">Glossary</span>
          <button title="New entry" onClick={startNew} className="rounded p-1 text-muted hover:bg-surface-2 hover:text-text"><Plus size={15} /></button>
        </div>
        <div className="flex-1 space-y-0.5 overflow-y-auto px-2">
          {categories.map((c) => (
            <button key={c.title} onClick={() => { setQuery(""); setCategory(c.title); }}
              className={cx("flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-[13px] transition",
                category === c.title && !query ? "bg-surface-2 font-medium text-text" : "text-muted hover:bg-surface-2 hover:text-text")}>
              <span className="truncate">{c.title}</span>
              <span className="font-mono text-[10px]">{c.count}</span>
            </button>
          ))}
        </div>
        <p className="border-t border-line px-4 py-3 text-[11px] leading-relaxed text-muted">
          Built-in content is summarised from refactoring.guru, 12factor.net and original sources. Framework notes link to official docs.
        </p>
      </nav>

      {/* Entry list */}
      <div className="flex w-72 shrink-0 flex-col border-r border-line">
        <div className="space-y-2 px-3 pt-3 pb-2">
          <div className="flex items-center gap-2 rounded-md border border-line bg-surface px-2.5 focus-within:border-accent">
            <Search size={14} className="shrink-0 text-muted" />
            <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") { setQuery(""); e.currentTarget.blur(); }
                if (e.key === "Enter" && flat[0]) { open(flat[0].entry.id); e.currentTarget.blur(); }
              }}
              placeholder="Search all entries" className="min-w-0 flex-1 bg-transparent py-1.5 text-sm focus:outline-none focus-visible:outline-none" />
            {!query && <Kbd>/</Kbd>}
          </div>
          {!query && activeCollection && (
            <p className="px-1 text-[11px] leading-relaxed text-muted">
              {activeCollection.description}{" "}
              {activeCollection.source && (
                <button onClick={() => openUrl(activeCollection.source!.url)} className="inline-flex items-center gap-0.5 hover:text-accent">
                  <ExternalLink size={10} />{activeCollection.source.name}
                </button>
              )}
            </p>
          )}
        </div>
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto border-t border-line pb-4">
          {grouped.map(({ group, items }) => (
            <div key={group || "_"}>
              {group && <div className="sticky top-0 bg-bg/95 px-4 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-accent backdrop-blur">{group}</div>}
              {items.map((r) => (
                <button key={r.entry.id} data-id={r.entry.id} onClick={() => open(r.entry.id)}
                  className={cx("block w-full px-4 py-2 text-left transition",
                    r.entry.id === entryId && !editing?.isNew ? "bg-surface-2" : "hover:bg-surface-2/60")}>
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-[13px] font-medium">{r.entry.title}</span>
                    {r.entry.notes && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" title="Has your notes" />}
                  </div>
                  <div className="line-clamp-2 text-[11.5px] leading-snug text-muted">
                    {query && <span className="text-accent">{r.entry.category} · </span>}
                    <Inline text={r.entry.summary} />
                  </div>
                </button>
              ))}
            </div>
          ))}
          {list.length === 0 && <p className="px-4 py-6 text-center text-xs text-muted">{query ? "No matches" : "No entries yet"}</p>}
        </div>
      </div>

      {/* Detail */}
      <div className="min-w-0 flex-1 overflow-y-auto">
        {editing ? (
          <EntryEditor key={editing.isNew ? "new" : editing.entry.id} initial={editing.entry} isNew={editing.isNew}
            categories={categories.map((c) => c.title)} onSave={handleSave} onCancel={() => setEditing(null)} />
        ) : current ? (
          <EntryView record={current} titles={titles} onOpen={open}
            onEdit={() => setEditing({ entry: current.entry, isNew: false })}
            onDelete={() => handleDelete(current)} />
        ) : (
          <div className="grid h-full place-items-center px-8 text-center">
            <div>
              <p className="mb-1 font-medium">{records.length} entries</p>
              <p className="text-sm text-muted">Pick one from the list, or press <Kbd>/</Kbd> to search everything.</p>
              <p className="mt-3 text-xs text-muted"><Kbd>j</Kbd>/<Kbd>k</Kbd> move · <Kbd>e</Kbd> edit or add notes</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
