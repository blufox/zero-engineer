/**
 * Ctrl+K palette: one search across navigation, tools, actions, cheat-sheet shortcuts,
 * snippets, glossary entries and repositories. Sources load lazily when it opens.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import Fuse from "fuse.js";
import {
  BookOpen, CornerDownLeft, FolderGit2, Keyboard, Library, NotebookPen, Search, Zap, type LucideIcon,
} from "lucide-react";
import { cx } from "../components/ui";
import { MODULES } from "./modules";
import { TOOLS } from "../modules/tools/registry";
import { loadSheets } from "../modules/cheatsheets/data";
import { loadSnippets, TYPE_LABELS } from "../modules/snippets/data";
import { loadEntries } from "../modules/glossary/data";
import { getCachedRepos } from "../modules/repos/ReposPage";
import { useSettings } from "../lib/settings";
import { launch, repos as reposApi } from "../lib/system";
import { storage } from "../lib/storage";

interface Item {
  id: string;
  group: string;
  title: string;
  subtitle?: string;
  icon: LucideIcon;
  run: () => void;
}

/** Display order of groups; earlier groups win ties. */
const GROUPS = ["Go to", "Tools", "Actions", "Repositories", "Snippets", "Glossary", "Cheat sheets"];

export default function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const { settings, update } = useSettings();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [dynamic, setDynamic] = useState<Item[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const go = (path: string) => () => navigate(path);

  const staticItems = useMemo<Item[]>(() => [
    ...MODULES.map((m) => ({ id: `nav:${m.id}`, group: "Go to", title: m.label, subtitle: m.description, icon: m.icon, run: go(m.path) })),
    ...TOOLS.map((t) => ({ id: `tool:${t.id}`, group: "Tools", title: t.label, subtitle: t.description, icon: t.icon, run: go(`/tools/${t.id}`) })),
    { id: "act:new-snippet", group: "Actions", title: "New snippet", subtitle: "Snippets & Notes", icon: Zap, run: go("/snippets?new=snippet") },
    { id: "act:new-note", group: "Actions", title: "New note", subtitle: "Snippets & Notes", icon: Zap, run: go("/snippets?new=note") },
    { id: "act:new-til", group: "Actions", title: "New TIL", subtitle: "Today I learned", icon: Zap, run: go("/snippets?new=til") },
    { id: "act:theme", group: "Actions", title: "Toggle dark / light theme", icon: Zap,
      run: () => update({ theme: document.documentElement.classList.contains("dark") ? "light" : "dark" }) },
    { id: "act:export-configs", group: "Actions", title: "Back up dotfiles", subtitle: "Config Backup", icon: Zap, run: go("/configs") },
    { id: "act:data-folder", group: "Actions", title: "Open data folder", icon: Zap,
      run: () => { storage.getAppConfig().then((c) => { if (c.dataDir) launch.folder(c.dataDir); }); } },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [settings]);

  // Load searchable content each time the palette opens (cheap: local JSON).
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    setTimeout(() => inputRef.current?.focus(), 0);
    let cancelled = false;
    (async () => {
      // Each source fails independently, so one problem never empties the whole palette.
      const safe = <T,>(p: Promise<T[] | null | undefined>) => p.then((v) => v ?? []).catch((e) => { console.warn(e); return [] as T[]; });
      const [sheets, snippets, glossary, repoList] = await Promise.all([
        safe(loadSheets()), safe(loadSnippets()), safe(loadEntries()),
        getCachedRepos() ? Promise.resolve(getCachedRepos()!) : safe(reposApi.scan(settings)),
      ]);
      if (cancelled) return;
      const items: Item[] = [];
      for (const r of repoList) {
        items.push({ id: `repo:${r.path}`, group: "Repositories", title: r.name, icon: FolderGit2,
          subtitle: `${r.group ? r.group + " · " : ""}${r.branch ?? ""} · open in ${settings.editorCommand}`,
          run: () => { launch.editor(r.path, settings); } });
      }
      for (const s of snippets) {
        items.push({ id: `snip:${s.id}`, group: "Snippets", title: s.title, icon: NotebookPen,
          subtitle: [TYPE_LABELS[s.type], ...s.tags.map((t) => `#${t}`)].join(" "), run: go(`/snippets/${s.id}`) });
      }
      for (const { entry } of glossary) {
        items.push({ id: `gl:${entry.id}`, group: "Glossary", title: entry.title, icon: Library,
          subtitle: `${entry.category} · ${entry.summary}`, run: go(`/glossary/${entry.id}`) });
      }
      for (const { sheet } of sheets) {
        items.push({ id: `sheet:${sheet.id}`, group: "Cheat sheets", title: sheet.title, subtitle: "Cheat sheet", icon: BookOpen, run: go(`/cheatsheets/${sheet.id}`) });
        for (const sec of sheet.sections) {
          for (const it of sec.items) {
            const keys = it.keys.join("  /  ");
            items.push({ id: `cs:${sheet.id}:${sec.title}:${keys}`, group: "Cheat sheets", title: keys, icon: Keyboard,
              subtitle: `${it.description} · ${sheet.title}`,
              run: go(`/cheatsheets/${sheet.id}?q=${encodeURIComponent(it.keys[0])}`) });
          }
        }
      }
      setDynamic(items);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const all = useMemo(() => [...staticItems, ...dynamic], [staticItems, dynamic]);
  const fuse = useMemo(() => new Fuse(all, {
    keys: [{ name: "title", weight: 3 }, { name: "subtitle", weight: 1 }],
    threshold: 0.35, ignoreLocation: true,
  }), [all]);

  const results = useMemo(() => {
    const q = query.trim();
    const list = q ? fuse.search(q, { limit: 60 }).map((r) => r.item) : staticItems.filter((i) => i.group !== "Tools");
    // Stable grouping by GROUPS order, keeping relevance order within a group.
    return [...list].sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group));
  }, [query, fuse, staticItems]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  function choose(i: Item | undefined) {
    if (!i) return;
    onClose();
    i.run();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-[12vh] backdrop-blur-[1px]" onMouseDown={onClose}>
      <div className="w-full max-w-xl overflow-hidden rounded-xl border border-line bg-surface shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 border-b border-line px-4">
          <Search size={16} className="shrink-0 text-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") { e.preventDefault(); onClose(); }
              else if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "j")) { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
              else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "k")) { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
              else if (e.key === "Enter") { e.preventDefault(); choose(results[active]); }
            }}
            placeholder="Search everything: shortcuts, snippets, patterns, repos, tools…"
            className="min-w-0 flex-1 bg-transparent py-3.5 text-sm focus:outline-none focus-visible:outline-none"
          />
          <kbd className="rounded border border-line px-1.5 font-mono text-[10px] text-muted">esc</kbd>
        </div>
        <div ref={listRef} className="max-h-[55vh] overflow-y-auto py-1">
          {results.length === 0 && <p className="px-4 py-6 text-center text-sm text-muted">Nothing found</p>}
          {results.map((item, i) => {
            const Icon = item.icon;
            const header = i === 0 || results[i - 1].group !== item.group;
            return (
              <div key={item.id}>
                {header && <div className="px-4 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted">{item.group}</div>}
                <button data-index={i} onMouseMove={() => setActive(i)} onClick={() => choose(item)}
                  className={cx("flex w-full items-center gap-3 px-4 py-2 text-left", i === active ? "bg-accent-soft" : "")}>
                  <Icon size={15} className={cx("shrink-0", i === active ? "text-accent" : "text-muted")} />
                  <span className="min-w-0 flex-1">
                    <span className={cx("block truncate text-[13px]", item.group === "Cheat sheets" && item.icon === Keyboard && "font-mono")}>{item.title}</span>
                    {item.subtitle && <span className="block truncate text-[11px] text-muted">{item.subtitle}</span>}
                  </span>
                  {i === active && <CornerDownLeft size={13} className="shrink-0 text-accent" />}
                </button>
              </div>
            );
          })}
        </div>
        <div className="flex gap-4 border-t border-line px-4 py-1.5 text-[10px] text-muted">
          <span>↑↓ / Ctrl+J Ctrl+K move</span><span>↵ open</span><span>esc close</span>
        </div>
      </div>
    </div>
  );
}
