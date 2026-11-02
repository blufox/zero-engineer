import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, Pencil, Pin, PinOff, Trash2 } from "lucide-react";
import { Button, Kbd } from "../../components/ui";
import CodeEditor from "../../components/CodeEditor";
import Markdown from "../../components/Markdown";
import { languageLabel } from "../../lib/languages";
import { CopyButton } from "../tools/shared";
import { relative } from "../tools/time";
import { TYPE_LABELS, type Snippet } from "./data";

export default function SnippetDetail({ snippet, onEdit, onTogglePin, onDelete }: {
  snippet: Snippet;
  onEdit: () => void;
  onTogglePin: () => void;
  onDelete: () => void;
}) {
  const asMarkdown = snippet.language === "markdown";
  return (
    <div className="flex h-full flex-col">
      <header className="shrink-0 border-b border-line px-8 pt-6 pb-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="selectable text-xl font-semibold tracking-tight">{snippet.title}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
              <span className="rounded bg-accent-soft px-1.5 py-0.5 text-accent">{TYPE_LABELS[snippet.type]}</span>
              {!asMarkdown && <span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono">{languageLabel(snippet.language)}</span>}
              {snippet.tags.map((t) => <span key={t} className="rounded bg-surface-2 px-1.5 py-0.5">#{t}</span>)}
              <span title={new Date(snippet.updatedAt).toLocaleString()}>updated {relative(new Date(snippet.updatedAt))}</span>
              {snippet.source && (
                <button onClick={() => openUrl(snippet.source!)} className="inline-flex max-w-xs items-center gap-1 truncate hover:text-accent">
                  <ExternalLink size={11} /> {snippet.source.replace(/^https?:\/\//, "")}
                </button>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <CopyButton value={snippet.content} className="p-2" />
            <Button variant="ghost" onClick={onTogglePin} title={snippet.pinned ? "Unpin" : "Pin to top"}>
              {snippet.pinned ? <PinOff size={14} /> : <Pin size={14} />}
            </Button>
            <Button variant="ghost" onClick={onEdit} title="Edit (e)"><Pencil size={14} /> Edit</Button>
            <Button variant="ghost" onClick={onDelete} title="Delete"><Trash2 size={14} /></Button>
          </div>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
        {snippet.content.trim() === "" ? (
          <p className="text-sm text-muted">Empty. Press <Kbd>e</Kbd> to edit.</p>
        ) : asMarkdown ? (
          <Markdown source={snippet.content} className="max-w-3xl" />
        ) : (
          <div className="overflow-hidden rounded-lg border border-line">
            <CodeEditor key={snippet.id} value={snippet.content} language={snippet.language} readOnly />
          </div>
        )}
      </div>
    </div>
  );
}
