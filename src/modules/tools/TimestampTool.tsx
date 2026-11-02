import { useEffect, useMemo, useState } from "react";
import { Clock } from "lucide-react";
import { Button, Card, Input } from "../../components/ui";
import { CopyButton, Message, OutputList, OutputRow, Pane, Segmented, useToolState } from "./shared";
import { formatLocal, formatUtc, relative, toDatetimeLocal } from "./time";

type Unit = "auto" | "s" | "ms";

/** Parse the timestamp input; "auto" treats 13+ digit values as milliseconds. */
function parseTimestamp(raw: string, unit: Unit): { date: Date; unit: "s" | "ms" } | null {
  const s = raw.trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  const resolved = unit === "auto" ? (Math.abs(n) >= 1e11 ? "ms" : "s") : unit;
  const date = new Date(resolved === "ms" ? n : n * 1000);
  return isNaN(date.getTime()) ? null : { date, unit: resolved };
}

function dayOfYear(d: Date): number {
  const start = Date.UTC(d.getFullYear(), 0, 1);
  const today = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return (today - start) / 86400000 + 1;
}

function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export default function TimestampTool() {
  const now = useNow();
  const [input, setInput] = useToolState("ts.input", () => String(Math.floor(Date.now() / 1000)));
  const [unit, setUnit] = useToolState<Unit>("ts.unit", "auto");
  const [dateInput, setDateInput] = useToolState("ts.date", () => toDatetimeLocal(new Date()));

  const parsed = useMemo(() => parseTimestamp(input, unit), [input, unit]);
  const fromDate = useMemo(() => {
    const d = new Date(dateInput);
    return isNaN(d.getTime()) ? null : d;
  }, [dateInput]);

  return (
    <div className="flex flex-col gap-5">
      <Card className="flex items-center gap-6 py-4">
        <Clock size={18} className="text-accent" />
        <div>
          <div className="text-xs text-muted">Now (seconds)</div>
          <div className="flex items-center gap-1 font-mono text-lg">
            {Math.floor(now / 1000)} <CopyButton value={String(Math.floor(now / 1000))} />
          </div>
        </div>
        <div>
          <div className="text-xs text-muted">Now (milliseconds)</div>
          <div className="flex items-center gap-1 font-mono text-lg">
            {now} <CopyButton value={String(now)} />
          </div>
        </div>
        <div className="flex-1" />
        <Button onClick={() => setInput(String(Math.floor(Date.now() / 1000)))}>Use now</Button>
      </Card>

      <Pane label="Timestamp → date">
        <div className="mb-3 flex items-center gap-3">
          <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder="1730000000" className="max-w-xs font-mono" />
          <Segmented value={unit} onChange={setUnit}
            options={[{ value: "auto", label: "Auto" }, { value: "s", label: "Seconds" }, { value: "ms", label: "Milliseconds" }]} />
          {parsed && unit === "auto" && <span className="text-xs text-muted">Detected: {parsed.unit === "s" ? "seconds" : "milliseconds"}</span>}
        </div>
        {input.trim() && !parsed ? <Message kind="error">Enter a whole number of seconds or milliseconds</Message> : parsed && (
          <OutputList>
            <OutputRow label="Local" value={formatLocal(parsed.date)} mono={false} />
            <OutputRow label="UTC" value={formatUtc(parsed.date)} mono={false} />
            <OutputRow label="ISO 8601" value={parsed.date.toISOString()} />
            <OutputRow label="Relative" value={relative(parsed.date, now)} mono={false} />
            <OutputRow label="Day of year" value={String(dayOfYear(parsed.date))} />
          </OutputList>
        )}
      </Pane>

      <Pane label="Date → timestamp">
        <div className="mb-3 flex items-center gap-3">
          <Input type="datetime-local" step={1} value={dateInput} onChange={(e) => setDateInput(e.target.value)} className="max-w-xs" />
          <span className="text-xs text-muted">Local time ({Intl.DateTimeFormat().resolvedOptions().timeZone})</span>
        </div>
        {fromDate && (
          <OutputList>
            <OutputRow label="Seconds" value={String(Math.floor(fromDate.getTime() / 1000))} />
            <OutputRow label="Milliseconds" value={String(fromDate.getTime())} />
            <OutputRow label="ISO 8601 (UTC)" value={fromDate.toISOString()} />
          </OutputList>
        )}
      </Pane>
    </div>
  );
}
