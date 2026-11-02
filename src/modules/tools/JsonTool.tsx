import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { Button } from "../../components/ui";
import { CodeArea, CopyButton, Message, Pane, Segmented, useToolState } from "./shared";

type View = "text" | "tree";

interface Result {
  value?: unknown;
  error?: { message: string; line: number; col: number; offset: number };
}

/** Strict JSON validation with line/column errors (JSON.parse in WebKit gives no position). */
function validate(text: string): Result {
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: false, disallowComments: true });
  if (errors.length === 0) return { value };
  const e = errors[0];
  const before = text.slice(0, e.offset).split("\n");
  return {
    error: {
      // "PropertyNameExpected" -> "Property name expected"
      message: printParseErrorCode(e.error).replace(/(?<=[a-z])(?=[A-Z])/g, " ").replace(/ \w/g, (m) => m.toLowerCase()),
      line: before.length,
      col: before[before.length - 1].length + 1,
      offset: e.offset,
    },
  };
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

export default function JsonTool() {
  const [input, setInput] = useToolState("json.input", "");
  const [output, setOutput] = useToolState("json.output", "");
  const [indent, setIndent] = useToolState<"2" | "4" | "tab">("json.indent", "2");
  const [view, setView] = useToolState<View>("json.view", "text");

  const result = useMemo(() => (input.trim() ? validate(input) : null), [input]);

  function format(minify = false, sorted = false) {
    if (!result || result.error) return;
    const v = sorted ? sortKeys(result.value) : result.value;
    const space = minify ? undefined : indent === "tab" ? "\t" : Number(indent);
    setOutput(JSON.stringify(v, null, space));
  }

  function jumpToError(textarea: HTMLTextAreaElement | null) {
    if (!textarea || !result?.error) return;
    textarea.focus();
    textarea.setSelectionRange(result.error.offset, result.error.offset + 1);
  }

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={() => format()} disabled={!result || !!result.error}>
          Format
        </Button>
        <Button onClick={() => format(true)} disabled={!result || !!result.error}>Minify</Button>
        <Button onClick={() => format(false, true)} disabled={!result || !!result.error}>Sort keys</Button>
        <Segmented value={indent} onChange={setIndent}
          options={[{ value: "2", label: "2 spaces" }, { value: "4", label: "4 spaces" }, { value: "tab", label: "Tab" }]} />
        <div className="flex-1" />
        {result && (result.error
          ? <button className="text-left" onClick={() => jumpToError(document.getElementById("json-in") as HTMLTextAreaElement)}>
              <Message kind="error">
                {result.error.message} at line {result.error.line}, column {result.error.col}. Click to jump
              </Message>
            </button>
          : <Message kind="ok">Valid JSON</Message>)}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-2 gap-4">
        <Pane label="Input" actions={<Button variant="ghost" onClick={() => { setInput(""); setOutput(""); }}>Clear</Button>}>
          <CodeArea id="json-in" value={input} onChange={(e) => setInput(e.target.value)}
            placeholder='Paste JSON here, e.g. {"hello": "world"}' />
        </Pane>
        <Pane label="Output" actions={<>
          <Segmented value={view} onChange={setView}
            options={[{ value: "text", label: "Text" }, { value: "tree", label: "Tree" }]} />
          <CopyButton value={output} />
        </>}>
          {view === "text" ? (
            <CodeArea readOnly value={output} placeholder="Formatted output appears here" />
          ) : (
            <div className="selectable flex-1 overflow-auto rounded-md border border-line bg-surface p-3 font-mono text-xs">
              {result && !result.error ? <TreeNode value={result.value} name={null} depth={0} /> : (
                <span className="text-muted">Enter valid JSON to see the tree</span>
              )}
            </div>
          )}
        </Pane>
      </div>
    </div>
  );
}

function TreeNode({ name, value, depth }: { name: string | null; value: unknown; depth: number }) {
  const [open, setOpen] = useState(depth < 2);
  const isObj = value !== null && typeof value === "object";
  const label = name !== null && <span className="text-accent">{JSON.stringify(name)}: </span>;

  if (!isObj) {
    const color = typeof value === "string" ? "text-warn" : value === null ? "text-muted" : "text-text";
    return <div className="py-px pl-4">{label}<span className={color}>{JSON.stringify(value)}</span></div>;
  }

  const entries = Array.isArray(value)
    ? value.map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, unknown>);
  const [l, r] = Array.isArray(value) ? ["[", "]"] : ["{", "}"];

  return (
    <div>
      <button onClick={() => setOpen(!open)} className="flex items-center py-px text-left hover:bg-surface-2">
        {open ? <ChevronDown size={12} className="mr-1 text-muted" /> : <ChevronRight size={12} className="mr-1 text-muted" />}
        {label}{l}
        {!open && <span className="text-muted">&nbsp;{entries.length} {Array.isArray(value) ? "items" : "keys"}&nbsp;</span>}
        {!open && r}
      </button>
      {open && (
        <div className="ml-1.5 border-l border-line pl-2">
          {entries.map(([k, v]) => (
            <TreeNode key={k} name={Array.isArray(value) ? null : k} value={v} depth={depth + 1} />
          ))}
          <div className="pl-2">{r}</div>
        </div>
      )}
    </div>
  );
}
