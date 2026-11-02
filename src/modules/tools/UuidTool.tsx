import { useMemo } from "react";
import { RefreshCw } from "lucide-react";
import { v4, v7, validate, version } from "uuid";
import { Button, Input } from "../../components/ui";
import { CodeArea, CopyButton, Message, Pane, Segmented, Toggle, useToolState } from "./shared";

type Version = "v4" | "v7";

function generate(ver: Version, count: number, upper: boolean, hyphens: boolean) {
  return Array.from({ length: count }, () => {
    let id = ver === "v4" ? v4() : v7();
    if (!hyphens) id = id.replace(/-/g, "");
    return upper ? id.toUpperCase() : id;
  }).join("\n");
}

/** Extract the embedded unix-ms timestamp from a v7 UUID. */
function v7Time(id: string): Date {
  return new Date(parseInt(id.replace(/-/g, "").slice(0, 12), 16));
}

export default function UuidTool() {
  const [ver, setVer] = useToolState<Version>("uuid.ver", "v4");
  const [count, setCount] = useToolState("uuid.count", 5);
  const [upper, setUpper] = useToolState("uuid.upper", false);
  const [hyphens, setHyphens] = useToolState("uuid.hyphens", true);
  const [output, setOutput] = useToolState("uuid.output", () => generate("v4", 5, false, true));
  const [check, setCheck] = useToolState("uuid.check", "");

  const regenerate = (patch: Partial<{ ver: Version; count: number; upper: boolean; hyphens: boolean }> = {}) => {
    const o = { ver, count, upper, hyphens, ...patch };
    setOutput(generate(o.ver, Math.min(Math.max(o.count, 1), 1000), o.upper, o.hyphens));
  };

  const checked = useMemo(() => {
    const id = check.trim().toLowerCase();
    if (!id) return null;
    if (!validate(id)) return { ok: false as const };
    const ver = version(id);
    return { ok: true as const, ver, time: ver === 7 ? v7Time(id) : null };
  }, [check]);

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented value={ver} onChange={(v) => { setVer(v); regenerate({ ver: v }); }}
          options={[{ value: "v4", label: "v4 · random" }, { value: "v7", label: "v7 · time-ordered" }]} />
        <label className="flex items-center gap-2 text-xs text-muted">
          Count
          <Input type="number" min={1} max={1000} value={count} className="w-20"
            onChange={(e) => { const n = Number(e.target.value); setCount(n); if (n > 0) regenerate({ count: n }); }} />
        </label>
        <Toggle label="Uppercase" checked={upper} onChange={(v) => { setUpper(v); regenerate({ upper: v }); }} />
        <Toggle label="Hyphens" checked={hyphens} onChange={(v) => { setHyphens(v); regenerate({ hyphens: v }); }} />
        <div className="flex-1" />
        <Button variant="primary" onClick={() => regenerate()}><RefreshCw size={14} /> Generate</Button>
      </div>

      <Pane label={`Generated (${output.split("\n").length})`} className="min-h-0 flex-1" actions={<CopyButton value={output} />}>
        <CodeArea readOnly value={output} />
      </Pane>

      <Pane label="Validate / inspect" className="shrink-0">
        <div className="flex items-center gap-3">
          <Input value={check} onChange={(e) => setCheck(e.target.value)} placeholder="Paste a UUID" className="font-mono text-xs" />
          {checked && (checked.ok
            ? <Message kind="ok">
                Valid UUID v{checked.ver}
                {checked.time && <> · created {checked.time.toLocaleString()}</>}
              </Message>
            : <Message kind="error">Not a valid UUID</Message>)}
        </div>
      </Pane>
    </div>
  );
}
