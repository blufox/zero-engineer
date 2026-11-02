import { type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, ExternalLink, Pencil, Quote as QuoteIcon, RotateCcw, Trash2, X } from "lucide-react";
import { Button, cx } from "../../components/ui";
import CodeEditor from "../../components/CodeEditor";
import Markdown from "../../components/Markdown";
import { useSettings } from "../../lib/settings";
import { CopyButton } from "../tools/shared";
import type { EntryRecord, GlossaryEntry } from "./data";

const LANG_LABEL: Record<string, string> = { php: "PHP", python: "Python", dart: "Dart" };

/** Renders `code` spans and *emphasis* in short prose fields. */
export function Inline({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`|\*[^*]+\*)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("`") && p.endsWith("`") ? (
          <code key={i} className="rounded bg-surface-2 px-1 py-px font-mono text-[0.88em]">{p.slice(1, -1)}</code>
        ) : p.startsWith("*") && p.endsWith("*") && p.length > 2 ? <em key={i}>{p.slice(1, -1)}</em> : p,
      )}
    </>
  );
}

function Section({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={cx("mt-7", className)}>
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{title}</h2>
      {children}
    </section>
  );
}

function Bullets({ items, icon }: { items: string[]; icon?: ReactNode }) {
  return (
    <ul className="space-y-1.5">
      {items.map((t, i) => (
        <li key={i} className="flex gap-2 text-[13.5px] leading-relaxed">
          <span className="mt-0.5 shrink-0 text-muted">{icon ?? "•"}</span>
          <span><Inline text={t} /></span>
        </li>
      ))}
    </ul>
  );
}

export default function EntryView({ record, titles, onOpen, onEdit, onDelete }: {
  record: EntryRecord;
  /** id → title for resolving related links. */
  titles: Map<string, string>;
  onOpen: (id: string) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { settings, update } = useSettings();
  const e: GlossaryEntry = record.entry;
  const examples = e.examples ?? [];
  const lang = examples.find((x) => x.language === settings.glossaryLanguage)?.language ?? examples[0]?.language;
  const example = examples.find((x) => x.language === lang);

  return (
    <article className="mx-auto max-w-3xl px-8 py-7">
      <div className="mb-1 flex items-center gap-2 text-xs text-muted">
        <span>{e.category}</span>
        {e.group && <><span>›</span><span>{e.group}</span></>}
        {record.origin === "modified" && <span className="rounded bg-warn/15 px-1.5 text-[10px] text-warn">edited</span>}
        {record.origin === "custom" && <span className="rounded bg-accent-soft px-1.5 text-[10px] text-accent">custom</span>}
        <div className="flex-1" />
        <Button variant="ghost" className="px-2 py-1" onClick={onEdit} title="Edit / add your notes (e)"><Pencil size={13} /> Edit</Button>
        {record.origin === "modified" && (
          <Button variant="ghost" className="px-2 py-1" onClick={onDelete} title="Discard your edits and restore the built-in entry"><RotateCcw size={13} /></Button>
        )}
        {record.origin === "custom" && (
          <Button variant="ghost" className="px-2 py-1" onClick={onDelete} title="Delete entry"><Trash2 size={13} /></Button>
        )}
      </div>

      <h1 className="selectable text-2xl font-semibold tracking-tight">{e.title}</h1>
      <p className="selectable mt-2 text-[15px] leading-relaxed text-text/90"><Inline text={e.summary} /></p>

      {e.quote && (
        <figure className="mt-5 rounded-lg border-l-2 border-accent bg-surface px-4 py-3">
          <blockquote className="selectable flex gap-2 text-[13.5px] italic leading-relaxed">
            <QuoteIcon size={14} className="mt-0.5 shrink-0 text-accent" />
            <span>{e.quote.text}</span>
          </blockquote>
          <figcaption className="mt-1.5 text-xs text-muted">
            {e.quote.source}{" "}
            <button onClick={() => openUrl(e.quote!.url)} className="inline-flex items-center gap-0.5 hover:text-accent">
              <ExternalLink size={10} /> source
            </button>
          </figcaption>
        </figure>
      )}

      {e.notes && (
        <Section title="My notes">
          <div className="rounded-lg border border-accent/30 bg-accent-soft/40 px-4 py-3">
            <Markdown source={e.notes} />
          </div>
        </Section>
      )}

      {e.problem && <Section title="Problem"><p className="selectable text-[13.5px] leading-relaxed"><Inline text={e.problem} /></p></Section>}
      {e.solution && <Section title={e.problem ? "Solution" : "Details"}><p className="selectable text-[13.5px] leading-relaxed"><Inline text={e.solution} /></p></Section>}
      {e.signs?.length ? <Section title="Signs"><Bullets items={e.signs} /></Section> : null}
      {e.whenToUse?.length ? <Section title="When to use"><Bullets items={e.whenToUse} /></Section> : null}

      {(e.pros?.length || e.cons?.length) ? (
        <div className="mt-7 grid grid-cols-2 gap-6">
          {e.pros?.length ? <div><h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Pros</h2>
            <Bullets items={e.pros} icon={<Check size={13} className="text-accent" />} /></div> : <div />}
          {e.cons?.length ? <div><h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Cons</h2>
            <Bullets items={e.cons} icon={<X size={13} className="text-danger" />} /></div> : null}
        </div>
      ) : null}

      {example && (
        <Section title="Example">
          <div className="overflow-hidden rounded-lg border border-line">
            <div className="flex items-center border-b border-line bg-surface px-2">
              {examples.map((x) => (
                <button key={x.language} onClick={() => update({ glossaryLanguage: x.language })}
                  className={cx("border-b-2 px-3 py-1.5 text-xs transition",
                    x.language === lang ? "border-accent text-text" : "border-transparent text-muted hover:text-text")}>
                  {LANG_LABEL[x.language] ?? x.language}
                </button>
              ))}
              <div className="flex-1" />
              <CopyButton value={example.code} />
            </div>
            <CodeEditor key={`${e.id}-${lang}`} value={example.code} language={example.language} readOnly />
          </div>
        </Section>
      )}

      {e.inTheWild?.length ? (
        <Section title="In your frameworks">
          <div className="space-y-2">
            {e.inTheWild.map((w, i) => (
              <div key={i} className="rounded-lg border border-line bg-surface px-4 py-3">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-sm font-medium">{w.framework}</span>
                  <button onClick={() => openUrl(w.url)} className="flex items-center gap-1 text-xs text-muted hover:text-accent">
                    <ExternalLink size={11} /> official docs
                  </button>
                </div>
                <p className="selectable text-[13px] leading-relaxed text-text/90"><Inline text={w.note} /></p>
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      {e.related?.length ? (
        <Section title="Related">
          <div className="flex flex-wrap gap-1.5">
            {e.related.map((id) => (
              <button key={id} onClick={() => onOpen(id)} disabled={!titles.has(id)}
                className="rounded-md border border-line bg-surface px-2 py-1 text-xs transition hover:border-accent hover:text-accent disabled:opacity-40">
                {titles.get(id) ?? id}
              </button>
            ))}
          </div>
        </Section>
      ) : null}

      {e.links?.length ? (
        <Section title="Read more">
          <div className="space-y-1">
            {e.links.map((l) => (
              <button key={l.url} onClick={() => openUrl(l.url)} className="flex items-center gap-1.5 text-sm text-accent hover:underline">
                <ExternalLink size={12} /> {l.label}
              </button>
            ))}
          </div>
        </Section>
      ) : null}
    </article>
  );
}
