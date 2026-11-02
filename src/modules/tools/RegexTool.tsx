import { useMemo, type ReactNode } from "react";
import { cx, Input } from "../../components/ui";
import { CopyButton, Message, Pane, useToolState } from "./shared";

const FLAGS = [
  { flag: "g", title: "global: find all matches" },
  { flag: "i", title: "ignore case" },
  { flag: "m", title: "multiline: ^ and $ match at line breaks" },
  { flag: "s", title: "dotAll: . matches newlines" },
  { flag: "u", title: "unicode" },
] as const;

const MAX_MATCHES = 1000;

interface Match {
  index: number;
  text: string;
  groups: (string | undefined)[];
  named: Record<string, string | undefined>;
}

const CHEATSHEET: [string, string][] = [
  [".", "any char"], ["\\d \\w \\s", "digit, word, space"], ["\\D \\W \\S", "negated"],
  ["[abc] [^abc]", "set, negated set"], ["a* a+ a?", "0+, 1+, 0 or 1"], ["a{2,5}", "2 to 5 times"],
  ["a*?", "lazy"], ["^ $", "start / end"], ["\\b", "word boundary"], ["(abc)", "capture group"],
  ["(?<name>…)", "named group"], ["(?:…)", "non-capturing"], ["a(?=b) a(?!b)", "lookahead"],
  ["(?<=b)a", "lookbehind"], ["$1 $<name>", "in replacement"],
];

export default function RegexTool() {
  const [pattern, setPattern] = useToolState("re.pattern", "(?<user>[\\w.]+)@(?<domain>[\\w.]+)");
  const [flags, setFlags] = useToolState("re.flags", "gm");
  const [text, setText] = useToolState("re.text", "Contact alice@example.com or bob.smith@mail.co.bw\nnot-an-email@");
  const [replacement, setReplacement] = useToolState("re.replace", "$<user> at $<domain>");

  const result = useMemo(() => {
    if (!pattern) return null;
    let re: RegExp;
    try {
      re = new RegExp(pattern, flags);
    } catch (e) {
      return { error: (e as Error).message };
    }
    const matches: Match[] = [];
    // Always iterate with "g" so we can list every match; the original flags drive replace.
    const iter = new RegExp(pattern, flags.includes("g") ? flags : flags + "g");
    for (const m of text.matchAll(iter)) {
      matches.push({ index: m.index ?? 0, text: m[0], groups: m.slice(1), named: { ...m.groups } });
      if (!flags.includes("g") || matches.length >= MAX_MATCHES) break;
    }
    let replaced = "";
    try {
      replaced = text.replace(re, replacement);
    } catch {
      /* ignore */
    }
    return { matches, replaced };
  }, [pattern, flags, text, replacement]);

  const toggleFlag = (f: string) => setFlags(flags.includes(f) ? flags.replace(f, "") : flags + f);

  return (
    <div className="grid h-full grid-cols-[1fr_220px] gap-5">
      <div className="flex min-h-0 flex-col gap-3">
        <div className="flex items-center gap-2">
          <div className="flex flex-1 items-center rounded-md border border-line bg-surface font-mono text-sm focus-within:border-accent">
            <span className="pl-3 text-muted">/</span>
            <input value={pattern} onChange={(e) => setPattern(e.target.value)} spellCheck={false}
              className="flex-1 bg-transparent px-1 py-1.5 focus:outline-none focus-visible:outline-none" placeholder="pattern" />
            <span className="pr-3 text-muted">/{flags}</span>
          </div>
          {FLAGS.map(({ flag, title }) => (
            <button key={flag} title={title} onClick={() => toggleFlag(flag)}
              className={cx("h-8 w-8 rounded-md border font-mono text-xs transition",
                flags.includes(flag) ? "border-accent bg-accent-soft text-accent" : "border-line text-muted hover:text-text")}>
              {flag}
            </button>
          ))}
        </div>

        {result?.error && <Message kind="error">{result.error}</Message>}
        {result && !result.error && (
          <Message kind={result.matches!.length ? "ok" : "info"}>
            {result.matches!.length === 0 ? "No matches" : `${result.matches!.length}${result.matches!.length >= MAX_MATCHES ? "+" : ""} match${result.matches!.length === 1 ? "" : "es"}`}
          </Message>
        )}

        <Pane label="Test string" className="min-h-0 flex-1">
          <HighlightedEditor value={text} onChange={setText} matches={result?.matches ?? []} />
        </Pane>

        <Pane label="Replace" actions={<CopyButton value={result?.replaced ?? ""} />} className="shrink-0">
          <Input value={replacement} onChange={(e) => setReplacement(e.target.value)} className="mb-2 font-mono text-xs"
            placeholder="Replacement, e.g. $1 or $<name>" />
          <pre className="selectable max-h-32 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-surface-2 p-3 font-mono text-xs">
            {result?.replaced || " "}
          </pre>
        </Pane>
      </div>

      <div className="flex min-h-0 flex-col gap-4 overflow-auto">
        <Pane label="Matches">
          <div className="space-y-1.5">
            {result?.matches?.slice(0, 100).map((m, i) => (
              <div key={i} className="rounded-md border border-line bg-surface p-2 font-mono text-[11px]">
                <div className="flex justify-between text-muted"><span>#{i + 1}</span><span>@{m.index}</span></div>
                <div className="selectable break-all text-accent">{m.text || <i className="text-muted">empty</i>}</div>
                {m.groups.map((g, gi) => {
                  const name = Object.entries(m.named).find(([, v]) => v === g)?.[0];
                  return (
                    <div key={gi} className="selectable break-all">
                      <span className="text-muted">{name ?? gi + 1}: </span>{g ?? <i className="text-muted">undefined</i>}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </Pane>
        <Pane label="Quick reference">
          <div className="space-y-1 text-[11px]">
            {CHEATSHEET.map(([k, v]) => (
              <div key={k} className="flex justify-between gap-2">
                <code className="font-mono text-accent">{k}</code><span className="text-right text-muted">{v}</span>
              </div>
            ))}
          </div>
        </Pane>
      </div>
    </div>
  );
}

/**
 * Textarea with match highlighting: a <pre> mirror sits behind a transparent
 * textarea using identical font metrics, so the marks line up with the text.
 */
function HighlightedEditor({ value, onChange, matches }: {
  value: string;
  onChange: (v: string) => void;
  matches: Match[];
}) {
  const parts: ReactNode[] = [];
  let last = 0;
  matches.forEach((m, i) => {
    if (m.text.length === 0 || m.index < last) return;
    parts.push(value.slice(last, m.index));
    parts.push(<mark key={i} className="rounded-sm bg-accent-soft text-transparent outline outline-1 outline-accent/50">{m.text}</mark>);
    last = m.index + m.text.length;
  });
  parts.push(value.slice(last) + "\n");

  const shared = "p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words";
  return (
    <div className="relative flex-1 overflow-hidden rounded-md border border-line bg-surface focus-within:border-accent">
      <pre aria-hidden className={cx(shared, "pointer-events-none absolute inset-0 m-0 overflow-hidden text-transparent")} id="re-mirror">
        {parts}
      </pre>
      <textarea
        value={value}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onScroll={(e) => {
          const mirror = document.getElementById("re-mirror");
          if (mirror) mirror.scrollTop = e.currentTarget.scrollTop;
        }}
        className={cx(shared, "relative h-full w-full resize-none bg-transparent text-text focus:outline-none")}
      />
    </div>
  );
}
