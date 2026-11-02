import { useState, type ReactNode } from "react";
import { Plus, X } from "lucide-react";
import { Button, Field, Input } from "../../components/ui";
import CodeEditor from "../../components/CodeEditor";
import { useSettings } from "../../lib/settings";
import type { GlossaryEntry } from "./data";

const lines = (v?: string[]) => (v ?? []).join("\n");
const toLines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);

function Area({ label, hint, value, onChange, rows = 3, mono }: {
  label: string; hint?: string; value: string; onChange: (v: string) => void; rows?: number; mono?: boolean;
}) {
  return (
    <Field label={label} hint={hint}>
      <textarea value={value} rows={rows} onChange={(e) => onChange(e.target.value)}
        className={`w-full rounded-md border border-line bg-surface px-3 py-2 text-sm focus:border-accent focus:outline-none ${mono ? "font-mono text-xs" : ""}`} />
    </Field>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="space-y-4 rounded-lg border border-line bg-surface p-4">
      <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-muted">{title}</legend>
      {children}
    </fieldset>
  );
}

export default function EntryEditor({ initial, isNew, categories, onSave, onCancel }: {
  initial: GlossaryEntry;
  isNew: boolean;
  categories: string[];
  onSave: (e: GlossaryEntry) => Promise<void>;
  onCancel: () => void;
}) {
  const { settings } = useSettings();
  const [d, setD] = useState<GlossaryEntry>(() => structuredClone(initial));
  const [text, setText] = useState({
    whenToUse: lines(initial.whenToUse), pros: lines(initial.pros), cons: lines(initial.cons), signs: lines(initial.signs),
    related: (initial.related ?? []).join(", "),
    links: (initial.links ?? []).map((l) => `${l.label} | ${l.url}`).join("\n"),
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<GlossaryEntry>) => setD((x) => ({ ...x, ...patch }));
  const setT = (patch: Partial<typeof text>) => setText((x) => ({ ...x, ...patch }));

  async function save() {
    if (!d.title.trim()) return setError("Title is required");
    setSaving(true);
    setError(null);
    const opt = (v?: string) => v?.trim() || undefined;
    const optList = (v: string) => (toLines(v).length ? toLines(v) : undefined);
    try {
      await onSave({
        ...d,
        title: d.title.trim(),
        category: d.category.trim() || "My Entries",
        group: opt(d.group),
        summary: d.summary.trim(),
        problem: opt(d.problem), solution: opt(d.solution), notes: opt(d.notes),
        whenToUse: optList(text.whenToUse), pros: optList(text.pros), cons: optList(text.cons), signs: optList(text.signs),
        related: text.related.split(",").map((s) => s.trim()).filter(Boolean),
        links: toLines(text.links).map((l) => {
          const [label, url] = l.includes("|") ? l.split("|").map((s) => s.trim()) : [l, l];
          return { label: label || url, url };
        }),
        examples: (d.examples ?? []).filter((x) => x.code.trim()),
      });
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  }

  return (
    <div className="flex h-full flex-col" onKeyDown={(e) => { if (e.key === "s" && e.ctrlKey) { e.preventDefault(); save(); } }}>
      <header className="flex shrink-0 items-center justify-between border-b border-line px-8 py-4">
        <h1 className="text-lg font-semibold">{isNew ? "New glossary entry" : `Editing ${initial.title}`}</h1>
        <div className="flex items-center gap-2">
          {error && <span className="text-xs text-danger">{error}</span>}
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-5 px-8 py-6">
          <Group title="My notes">
            <Area label="Notes (Markdown)" hint="Your own takeaways, gotchas, links to your code. Shown at the top of the entry."
              value={d.notes ?? ""} onChange={(v) => set({ notes: v })} rows={5} />
          </Group>

          <Group title="Basics">
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-3"><Field label="Title"><Input value={d.title} onChange={(e) => set({ title: e.target.value })} autoFocus={isNew} /></Field></div>
              <Field label="Category">
                <Input value={d.category} list="glossary-categories" onChange={(e) => set({ category: e.target.value })} />
                <datalist id="glossary-categories">{categories.map((c) => <option key={c} value={c} />)}</datalist>
              </Field>
              <Field label="Group (optional)"><Input value={d.group ?? ""} onChange={(e) => set({ group: e.target.value })} /></Field>
            </div>
            <Area label="Summary" value={d.summary} onChange={(v) => set({ summary: v })} rows={2} />
            <Area label="Problem" value={d.problem ?? ""} onChange={(v) => set({ problem: v })} />
            <Area label="Solution / details" value={d.solution ?? ""} onChange={(v) => set({ solution: v })} />
          </Group>

          <Group title="Lists (one item per line)">
            <div className="grid grid-cols-2 gap-3">
              <Area label="When to use" value={text.whenToUse} onChange={(v) => setT({ whenToUse: v })} />
              <Area label="Signs" value={text.signs} onChange={(v) => setT({ signs: v })} />
              <Area label="Pros" value={text.pros} onChange={(v) => setT({ pros: v })} />
              <Area label="Cons" value={text.cons} onChange={(v) => setT({ cons: v })} />
            </div>
          </Group>

          <Group title="Code examples">
            {(d.examples ?? []).map((x, i) => (
              <div key={i} className="overflow-hidden rounded-md border border-line">
                <div className="flex items-center gap-2 border-b border-line bg-surface-2 px-2 py-1">
                  <select value={x.language} onChange={(e) => set({ examples: d.examples!.map((y, j) => (j === i ? { ...y, language: e.target.value } : y)) })}
                    className="rounded bg-surface px-1.5 py-0.5 text-xs">
                    {["php", "python", "dart", "typescript", "javascript", "sql", "bash"].map((l) => <option key={l}>{l}</option>)}
                  </select>
                  <div className="flex-1" />
                  <button title="Remove example" onClick={() => set({ examples: d.examples!.filter((_, j) => j !== i) })}
                    className="rounded p-1 text-muted hover:text-danger"><X size={13} /></button>
                </div>
                <CodeEditor value={x.code} language={x.language} vimMode={settings.editorVimMode}
                  onChange={(code) => setD((cur) => ({ ...cur, examples: cur.examples!.map((y, j) => (j === i ? { ...y, code } : y)) }))}
                  onSave={save} className="max-h-80 overflow-auto" />
              </div>
            ))}
            <Button variant="ghost" onClick={() => set({ examples: [...(d.examples ?? []), { language: settings.glossaryLanguage, code: "" }] })}>
              <Plus size={14} /> Add example
            </Button>
          </Group>

          <Group title="Links">
            <Field label="Related entry ids" hint="Comma separated, e.g. strategy, state">
              <Input value={text.related} onChange={(e) => setT({ related: e.target.value })} className="font-mono text-xs" />
            </Field>
            <Area label="Read more" hint="One per line: Label | https://…" value={text.links} onChange={(v) => setT({ links: v })} mono />
          </Group>
        </div>
      </div>
    </div>
  );
}
