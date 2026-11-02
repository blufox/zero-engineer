import { useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2, X } from "lucide-react";
import { Button, Field, Input } from "../../components/ui";
import type { CheatItem, CheatSheet } from "./data";

/** Alternatives are edited as one text field, separated by "||". */
const KEY_SEP = " || ";

function move<T>(arr: T[], from: number, to: number): T[] {
  if (to < 0 || to >= arr.length) return arr;
  const next = [...arr];
  const [x] = next.splice(from, 1);
  next.splice(to, 0, x);
  return next;
}

function IconBtn({ title, onClick, children, danger }: {
  title: string; onClick: () => void; children: React.ReactNode; danger?: boolean;
}) {
  return (
    <button type="button" title={title} onClick={onClick}
      className={`rounded p-1 text-muted transition hover:bg-surface-2 ${danger ? "hover:text-danger" : "hover:text-text"}`}>
      {children}
    </button>
  );
}

export default function SheetEditor({ initial, isNew, onSave, onCancel }: {
  initial: CheatSheet;
  isNew: boolean;
  onSave: (sheet: CheatSheet) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<CheatSheet>(() => structuredClone(initial));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setSection = (si: number, patch: Partial<CheatSheet["sections"][number]>) =>
    setDraft((d) => ({ ...d, sections: d.sections.map((s, i) => (i === si ? { ...s, ...patch } : s)) }));

  const setItem = (si: number, ii: number, patch: Partial<CheatItem>) =>
    setSection(si, { items: draft.sections[si].items.map((it, i) => (i === ii ? { ...it, ...patch } : it)) });

  async function save() {
    setSaving(true);
    setError(null);
    try {
      // Drop empty rows and tidy whitespace before saving.
      const cleaned: CheatSheet = {
        ...draft,
        title: draft.title.trim() || "Untitled",
        sections: draft.sections.map((s) => ({
          title: s.title.trim() || "Untitled section",
          items: s.items
            .map((i) => ({ keys: i.keys.map((k) => k.trim()).filter(Boolean), description: i.description.trim() }))
            .filter((i) => i.keys.length || i.description),
        })),
      };
      await onSave(cleaned);
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center justify-between border-b border-line px-8 py-4">
        <h1 className="text-lg font-semibold">{isNew ? "New cheat sheet" : `Editing ${initial.title}`}</h1>
        <div className="flex items-center gap-2">
          {error && <span className="text-xs text-danger">{error}</span>}
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
        <div className="mb-6 grid grid-cols-2 gap-4">
          <Field label="Title">
            <Input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} autoFocus={isNew} />
          </Field>
          <Field label="Tags" hint="Comma separated">
            <Input value={draft.tags.join(", ")}
              onChange={(e) => setDraft({ ...draft, tags: e.target.value.split(",").map((t) => t.trim()).filter(Boolean) })} />
          </Field>
          <div className="col-span-2">
            <Field label="Description">
              <Input value={draft.description ?? ""} onChange={(e) => setDraft({ ...draft, description: e.target.value || undefined })} />
            </Field>
          </div>
        </div>

        <p className="mb-3 text-xs text-muted">
          Put alternative keys for the same action in one field, separated by <code className="font-mono">||</code>,
          e.g. <code className="font-mono">gt || :tabnext</code>.
        </p>

        <div className="space-y-4">
          {draft.sections.map((s, si) => (
            <section key={si} className="rounded-lg border border-line bg-surface">
              <div className="flex items-center gap-2 border-b border-line px-3 py-2">
                <Input value={s.title} onChange={(e) => setSection(si, { title: e.target.value })}
                  className="border-transparent bg-transparent font-semibold" placeholder="Section title" />
                <IconBtn title="Move section up" onClick={() => setDraft({ ...draft, sections: move(draft.sections, si, si - 1) })}><ArrowUp size={14} /></IconBtn>
                <IconBtn title="Move section down" onClick={() => setDraft({ ...draft, sections: move(draft.sections, si, si + 1) })}><ArrowDown size={14} /></IconBtn>
                <IconBtn danger title="Delete section" onClick={() => setDraft({ ...draft, sections: draft.sections.filter((_, i) => i !== si) })}><Trash2 size={14} /></IconBtn>
              </div>
              <div className="space-y-1 p-3">
                {s.items.map((item, ii) => (
                  <div key={ii} className="group flex items-center gap-2">
                    <div className="w-64 shrink-0">
                      <Input value={item.keys.join(KEY_SEP)} placeholder="keys"
                        onChange={(e) => setItem(si, ii, { keys: e.target.value.split("||").map((k) => k.trimStart()) })}
                        className="font-mono text-xs" />
                    </div>
                    <Input value={item.description} placeholder="what it does"
                      onChange={(e) => setItem(si, ii, { description: e.target.value })} />
                    <div className="flex opacity-0 transition group-focus-within:opacity-100 group-hover:opacity-100">
                      <IconBtn title="Move up" onClick={() => setSection(si, { items: move(s.items, ii, ii - 1) })}><ArrowUp size={13} /></IconBtn>
                      <IconBtn title="Move down" onClick={() => setSection(si, { items: move(s.items, ii, ii + 1) })}><ArrowDown size={13} /></IconBtn>
                      <IconBtn danger title="Remove" onClick={() => setSection(si, { items: s.items.filter((_, i) => i !== ii) })}><X size={13} /></IconBtn>
                    </div>
                  </div>
                ))}
                <Button variant="ghost" className="mt-1"
                  onClick={() => setSection(si, { items: [...s.items, { keys: [""], description: "" }] })}>
                  <Plus size={14} /> Add entry
                </Button>
              </div>
            </section>
          ))}
        </div>

        <Button className="mt-4"
          onClick={() => setDraft({ ...draft, sections: [...draft.sections, { title: "", items: [{ keys: [""], description: "" }] }] })}>
          <Plus size={14} /> Add section
        </Button>
      </div>
    </div>
  );
}
