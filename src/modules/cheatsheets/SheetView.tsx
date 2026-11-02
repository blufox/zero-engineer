import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useSearchParams } from "react-router-dom";
import { Download, ExternalLink, Pencil, RotateCcw, Search, Trash2 } from "lucide-react";
import { Button, Kbd } from "../../components/ui";
import { countItems, type CheatSheet, type Origin } from "./data";

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/** Wrap occurrences of `q` in <mark>. */
function highlight(text: string, q: string): ReactNode {
  if (!q) return text;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark className="rounded-sm bg-warn/30 text-inherit">{text.slice(i, i + q.length)}</mark>
      {highlight(text.slice(i + q.length), q)}
    </>
  );
}

export default function SheetView({ sheet, origin, onEdit, onExport, onDelete }: {
  sheet: CheatSheet;
  origin: Origin;
  onEdit: () => void;
  onExport: () => void;
  onDelete: () => void;
}) {
  const [params] = useSearchParams();
  const [query, setQuery] = useState(params.get("q") ?? "");
  const searchRef = useRef<HTMLInputElement>(null);

  // "/" (Vim-style) or Ctrl+F focuses search; Esc clears it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if ((e.key === "/" && !typing) || (e.key === "f" && e.ctrlKey)) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Reset on sheet change; `?q=` (from the command palette) pre-fills the search.
  useEffect(() => setQuery(params.get("q") ?? ""), [sheet.id, params]);

  const q = query.trim().toLowerCase();
  const sections = useMemo(() => {
    if (!q) return sheet.sections;
    return sheet.sections
      .map((s) => {
        const sectionHit = s.title.toLowerCase().includes(q);
        const items = sectionHit ? s.items : s.items.filter((i) =>
          i.description.toLowerCase().includes(q) || i.keys.some((k) => k.toLowerCase().includes(q)));
        return { ...s, items };
      })
      .filter((s) => s.items.length > 0);
  }, [sheet, q]);

  const matchCount = sections.reduce((n, s) => n + s.items.length, 0);

  return (
    <div className="flex h-full flex-col">
      <header className="shrink-0 border-b border-line px-8 pt-6 pb-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight">{sheet.title}</h1>
              {origin === "modified" && <span className="rounded bg-warn/15 px-1.5 py-0.5 text-[10px] text-warn">edited</span>}
              {origin === "custom" && <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[10px] text-accent">custom</span>}
            </div>
            {sheet.description && <p className="mt-1 text-sm text-muted">{sheet.description}</p>}
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
              <span>{plural(countItems(sheet), "entry", "entries")} · {plural(sheet.sections.length, "section")}</span>
              {sheet.tags.map((t) => <span key={t} className="rounded bg-surface-2 px-1.5 py-0.5">#{t}</span>)}
              {sheet.source && (
                <button onClick={() => openUrl(sheet.source!.url)} className="inline-flex items-center gap-1 hover:text-accent">
                  <ExternalLink size={11} /> {sheet.source.name}{sheet.source.license && ` (${sheet.source.license})`}
                </button>
              )}
            </div>
          </div>
          <div className="flex shrink-0 gap-1">
            <Button variant="ghost" onClick={onEdit} title="Edit"><Pencil size={14} /> Edit</Button>
            <Button variant="ghost" onClick={onExport} title="Export as JSON"><Download size={14} /></Button>
            {origin === "modified" && (
              <Button variant="ghost" onClick={onDelete} title="Discard your edits and restore the built-in version">
                <RotateCcw size={14} />
              </Button>
            )}
            {origin === "custom" && (
              <Button variant="ghost" onClick={onDelete} title="Delete sheet"><Trash2 size={14} /></Button>
            )}
          </div>
        </div>

        <div className="mt-4 flex items-center gap-2 rounded-md border border-line bg-surface px-3 focus-within:border-accent">
          <Search size={14} className="shrink-0 text-muted" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && (setQuery(""), e.currentTarget.blur())}
            placeholder={`Search ${sheet.title}…`}
            className="flex-1 bg-transparent py-1.5 text-sm focus:outline-none focus-visible:outline-none"
          />
          {q ? <span className="text-xs text-muted">{matchCount} matches</span> : <Kbd>/</Kbd>}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
        {sections.length === 0 && (
          <p className="text-sm text-muted">
            {q ? `Nothing matches “${query}”.` : "This sheet is empty. Click Edit to add sections."}
          </p>
        )}
        <div className="columns-1 gap-4 lg:columns-2 2xl:columns-3">
          {sections.map((s) => (
            <section key={s.title} className="mb-4 break-inside-avoid rounded-lg border border-line bg-surface">
              <h2 className="border-b border-line px-4 py-2 text-xs font-semibold uppercase tracking-wide text-accent">
                {highlight(s.title, q)}
              </h2>
              <dl>
                {s.items.map((item, i) => (
                  <div key={i} className="flex gap-3 border-b border-line/60 px-4 py-1.5 last:border-b-0 hover:bg-surface-2">
                    <dt className="flex w-[42%] shrink-0 flex-wrap content-start gap-1">
                      {item.keys.map((k) => (
                        <code key={k} className="selectable rounded border border-line bg-surface-2 px-1.5 py-px font-mono text-[11.5px] text-text">
                          {highlight(k, q)}
                        </code>
                      ))}
                    </dt>
                    <dd className="selectable flex-1 text-[13px] leading-snug text-text/90">{highlight(item.description, q)}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
