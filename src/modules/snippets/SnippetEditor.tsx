import { useState } from "react";
import { Button, Field, Input } from "../../components/ui";
import CodeEditor from "../../components/CodeEditor";
import { LANGUAGES } from "../../lib/languages";
import { useSettings } from "../../lib/settings";
import { Segmented, Toggle } from "../tools/shared";
import { TYPE_LABELS, type Snippet, type SnippetType } from "./data";

export default function SnippetEditor({ initial, isNew, onSave, onCancel }: {
  initial: Snippet;
  isNew: boolean;
  onSave: (s: Snippet) => Promise<void>;
  onCancel: () => void;
}) {
  const { settings, update } = useSettings();
  const [draft, setDraft] = useState(initial);
  const [tagsText, setTagsText] = useState(initial.tags.join(", "));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (patch: Partial<Snippet>) => setDraft((d) => ({ ...d, ...patch }));

  async function save() {
    if (saving) return;
    const firstLine = draft.content.trim().split("\n")[0]?.replace(/^#+\s*/, "").slice(0, 80);
    const title = draft.title.trim() || firstLine || "Untitled";
    setSaving(true);
    setError(null);
    try {
      await onSave({
        ...draft,
        title,
        source: draft.source?.trim() || undefined,
        tags: [...new Set(tagsText.split(",").map((t) => t.trim().toLowerCase().replace(/^#/, "")).filter(Boolean))],
        updatedAt: new Date().toISOString(),
      });
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  }

  function setType(type: SnippetType) {
    // Notes and TILs default to Markdown; snippets to the last-used code language.
    set({ type, language: type === "snippet" ? (draft.language === "markdown" ? "plaintext" : draft.language) : "markdown" });
  }

  return (
    <div className="flex h-full flex-col"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !settings.editorVimMode) onCancel();
        if (e.key === "s" && e.ctrlKey) { e.preventDefault(); save(); }
      }}>
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-line px-8 py-4">
        <h1 className="text-lg font-semibold">{isNew ? `New ${TYPE_LABELS[draft.type].toLowerCase()}` : "Edit"}</h1>
        <div className="flex items-center gap-3">
          {error && <span className="text-xs text-danger">{error}</span>}
          <Toggle label="Vim mode" checked={settings.editorVimMode} onChange={(v) => update({ editorVimMode: v })} />
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-8 py-5">
        <Input value={draft.title} onChange={(e) => set({ title: e.target.value })} autoFocus={isNew}
          placeholder="Title (defaults to the first line)" className="py-2 text-base font-medium" />

        <div className="flex flex-wrap items-end gap-4">
          <Field label="Type">
            <Segmented value={draft.type} onChange={setType}
              options={(Object.keys(TYPE_LABELS) as SnippetType[]).map((t) => ({ value: t, label: TYPE_LABELS[t] }))} />
          </Field>
          <Field label="Language">
            <select value={draft.language} onChange={(e) => set({ language: e.target.value })}
              className="rounded-md border border-line bg-surface px-2 py-1.5 text-sm focus:border-accent focus:outline-none">
              {LANGUAGES.map((l) => <option key={l.id} value={l.id}>{l.label}{l.id === "markdown" ? " (rendered)" : ""}</option>)}
            </select>
          </Field>
          <div className="min-w-48 flex-1">
            <Field label="Tags">
              <Input value={tagsText} onChange={(e) => setTagsText(e.target.value)} placeholder="laravel, eloquent" />
            </Field>
          </div>
          <div className="min-w-48 flex-1">
            <Field label="Source (optional)">
              <Input value={draft.source ?? ""} onChange={(e) => set({ source: e.target.value })} placeholder="https://…" />
            </Field>
          </div>
        </div>

        <div className="min-h-64 flex-1 overflow-hidden rounded-lg border border-line focus-within:border-accent">
          <CodeEditor
            value={draft.content}
            onChange={(content) => set({ content })}
            language={draft.language}
            vimMode={settings.editorVimMode}
            autoFocus={!isNew}
            onSave={save}
            onQuit={onCancel}
            placeholder={draft.language === "markdown" ? "Write in Markdown…" : "Paste or write code…"}
            className="h-full"
          />
        </div>
        <p className="shrink-0 text-xs text-muted">
          <kbd className="font-mono">Ctrl+S</kbd> saves.
          {settings.editorVimMode ? <> In Vim mode <code className="font-mono">:w</code> saves and <code className="font-mono">:q</code> cancels.</> : <> <kbd className="font-mono">Esc</kbd> cancels.</>}
        </p>
      </div>
    </div>
  );
}
