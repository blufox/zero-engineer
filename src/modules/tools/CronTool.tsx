import { useMemo } from "react";
import cronstrue from "cronstrue";
import { CronExpressionParser } from "cron-parser";
import { Input } from "../../components/ui";
import { Message, Pane, useToolState } from "./shared";
import { formatLocal, relative } from "./time";

const PRESETS: [string, string][] = [
  ["* * * * *", "Every minute"],
  ["*/5 * * * *", "Every 5 minutes"],
  ["0 * * * *", "Hourly"],
  ["0 0 * * *", "Daily at midnight"],
  ["0 9 * * 1-5", "Weekdays at 9am"],
  ["0 0 * * 0", "Weekly (Sunday)"],
  ["0 0 1 * *", "Monthly"],
  ["0 2 * * *", "Nightly backup (2am)"],
];

const FIELDS = [
  ["second", "0-59"],
  ["minute", "0-59"],
  ["hour", "0-23"],
  ["day (month)", "1-31"],
  ["month", "1-12 or JAN-DEC"],
  ["day (week)", "0-6 or SUN-SAT"],
];

export default function CronTool() {
  const [expr, setExpr] = useToolState("cron.expr", "*/15 9-17 * * 1-5");
  const [count, setCount] = useToolState("cron.count", 10);

  const result = useMemo(() => {
    const e = expr.trim();
    if (!e) return null;
    try {
      const description = cronstrue.toString(e, { use24HourTimeFormat: true, verbose: true });
      const next = CronExpressionParser.parse(e).take(count).map((d) => d.toDate());
      return { description, next };
    } catch (err) {
      return { error: String((err as Error).message ?? err) };
    }
  }, [expr, count]);

  const parts = expr.trim().split(/\s+/);
  // 6 fields = leading seconds field; otherwise skip the "second" label.
  const fields = parts.length === 6 ? FIELDS : FIELDS.slice(1);

  return (
    <div className="grid grid-cols-[1fr_260px] gap-6">
      <div className="space-y-5">
        <div>
          <Input value={expr} onChange={(e) => setExpr(e.target.value)} placeholder="*/5 * * * *"
            className="py-2.5 text-center font-mono text-lg tracking-widest" />
          <div className="mt-2 grid gap-1 text-center text-[11px] text-muted"
            style={{ gridTemplateColumns: `repeat(${fields.length}, 1fr)` }}>
            {fields.map(([name, range], i) => (
              <div key={name}>
                <div className="font-mono text-text">{parts[i] ?? "·"}</div>
                <div>{name}</div>
                <div className="text-muted/70">{range}</div>
              </div>
            ))}
          </div>
        </div>

        {result?.error && <Message kind="error">{result.error}</Message>}
        {result?.description && (
          <div className="rounded-lg border border-accent/40 bg-accent-soft px-4 py-3 text-base text-accent">
            “{result.description}”
          </div>
        )}

        {result?.next && (
          <Pane label="Next runs (local time)" actions={
            <select value={count} onChange={(e) => setCount(Number(e.target.value))}
              className="rounded border border-line bg-surface px-1 text-xs">
              {[5, 10, 25, 50].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          }>
            <div className="rounded-md border border-line bg-surface">
              {result.next.map((d, i) => (
                <div key={i} className="flex justify-between border-b border-line px-3 py-1.5 text-xs last:border-b-0">
                  <span className="selectable font-mono">{formatLocal(d)}</span>
                  <span className="text-muted">{relative(d)}</span>
                </div>
              ))}
            </div>
          </Pane>
        )}
      </div>

      <div className="space-y-5">
        <Pane label="Presets">
          <div className="space-y-1">
            {PRESETS.map(([e, label]) => (
              <button key={e} onClick={() => setExpr(e)}
                className="flex w-full justify-between rounded-md px-2 py-1 text-left text-xs hover:bg-surface-2">
                <span>{label}</span><code className="font-mono text-muted">{e}</code>
              </button>
            ))}
          </div>
        </Pane>
        <Pane label="Syntax">
          <div className="space-y-1 text-[11px] text-muted">
            <p><code className="font-mono text-accent">*</code> any value</p>
            <p><code className="font-mono text-accent">,</code> list: <code className="font-mono">1,15</code></p>
            <p><code className="font-mono text-accent">-</code> range: <code className="font-mono">1-5</code></p>
            <p><code className="font-mono text-accent">/</code> step: <code className="font-mono">*/10</code></p>
            <p>An optional 6th leading field sets seconds.</p>
            <p className="pt-2">Laravel: <code className="font-mono">-&gt;cron('…')</code>. Celery: <code className="font-mono">crontab(...)</code>.</p>
          </div>
        </Pane>
      </div>
    </div>
  );
}
