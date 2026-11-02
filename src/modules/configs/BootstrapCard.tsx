import { useMemo, useState } from "react";
import { AlertTriangle, Check, ChevronRight, FileDiff, HardDriveDownload, ScanSearch } from "lucide-react";
import DiffLines from "../../components/DiffLines";
import { Button, Card, cx } from "../../components/ui";
import { useSettings } from "../../lib/settings";
import { errorMessage } from "../../lib/storage";
import { bootstrap, type BootstrapPreview, type BootstrapScan } from "../../lib/system";

const LABELS: Record<string, string> = {
  apt: "apt packages", aptSources: "Third-party apt sources", snap: "Snaps", flatpak: "Flatpaks", npm: "npm global",
  composer: "Composer global", cargo: "cargo install", uv: "uv tools", rustup: "Rust toolchains", clones: "Shell plugins & themes",
};

/** Scan installed tools and write <backup>/bootstrap/bootstrap.sh. Nothing runs until you press Scan. */
export default function BootstrapCard() {
  const { settings, update } = useSettings();
  const [scan, setScan] = useState<BootstrapScan | null>(null);
  const [busy, setBusy] = useState<"scan" | "preview" | "export" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [preview, setPreview] = useState<BootstrapPreview | null>(null);
  const [written, setWritten] = useState<string | null>(null);
  const overrides = settings.bootstrapOverrides;

  // Scan defaults with your saved ticks/unticks applied.
  const effective = useMemo<BootstrapScan | null>(() => scan && {
    ...scan,
    sections: scan.sections.map((s) => ({
      ...s,
      items: s.items.map((i) => ({ ...i, selected: overrides[`${s.id}:${i.name}`] ?? i.selected })),
    })),
  }, [scan, overrides]);

  async function act<T>(kind: "scan" | "preview" | "export", f: () => Promise<T>) {
    setBusy(kind);
    setError(null);
    try { return await f(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(null); }
  }

  const doScan = () => act("scan", async () => { setPreview(null); setWritten(null); setScan(await bootstrap.scan()); });
  const doPreview = () => effective && act("preview", async () => setPreview(await bootstrap.preview(effective)));
  const doExport = () => effective && act("export", async () => { setWritten(await bootstrap.export(effective)); setPreview(null); });

  function toggle(section: string, name: string, def: boolean, value: boolean) {
    const key = `${section}:${name}`;
    const next = { ...overrides };
    if (value === def) delete next[key]; else next[key] = value;
    update({ bootstrapOverrides: next });
    setPreview(null);
  }

  return (
    <Card className="mt-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold"><HardDriveDownload size={15} /> Machine bootstrap</h2>
          <p className="mt-1 text-xs text-muted">
            Records your apt packages, apt sources, flatpaks, snaps, global npm/composer/cargo tools and shell plugins, and writes a
            <code className="mx-1 font-mono">bootstrap.sh</code>to the backup folder to rebuild a new machine. Zero never runs it.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button onClick={doScan} disabled={!!busy}><ScanSearch size={14} className={cx(busy === "scan" && "animate-pulse")} /> {scan ? "Rescan" : "Scan this machine"}</Button>
          {effective && <Button onClick={doPreview} disabled={!!busy}><FileDiff size={14} /> Preview</Button>}
          {effective && <Button variant="primary" onClick={doExport} disabled={!!busy || (preview?.secrets.length ?? 0) > 0}>Write bootstrap.sh</Button>}
        </div>
      </div>

      {error && <p className="mt-3 rounded-md bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>}
      {written && <p className="mt-3 flex items-center gap-2 rounded-md bg-accent-soft px-3 py-2 text-xs text-accent"><Check size={13} /> Wrote <code className="selectable font-mono">{written}</code>. Commit the backup folder to keep it.</p>}

      {effective && (
        <div className="mt-4 divide-y divide-line rounded-md border border-line">
          {effective.sections.map((s) => {
            const picked = s.items.filter((i) => i.selected).length;
            const isOpen = open.has(s.id);
            const defaults = new Map(scan!.sections.find((x) => x.id === s.id)!.items.map((i) => [i.name, i.selected]));
            const shown = s.items.filter((i) => !filter || i.name.includes(filter));
            return (
              <div key={s.id}>
                <button disabled={!s.items.length}
                  onClick={() => setOpen((o) => { const n = new Set(o); if (n.has(s.id)) n.delete(s.id); else n.add(s.id); return n; })}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs disabled:cursor-default">
                  <ChevronRight size={13} className={cx("text-muted transition", isOpen && "rotate-90", !s.items.length && "invisible")} />
                  <span className="font-medium">{LABELS[s.id] ?? s.id}</span>
                  <span className="font-mono text-muted">{picked}/{s.items.length}</span>
                  {s.note && <span className="truncate text-muted">· {s.note}</span>}
                </button>
                {isOpen && (
                  <div className="px-3 pb-3">
                    {s.items.length > 30 && (
                      <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter…"
                        className="mb-2 w-48 rounded border border-line bg-bg px-2 py-1 text-xs focus:border-accent focus:outline-none" />
                    )}
                    <div className="grid max-h-72 grid-cols-2 gap-x-4 gap-y-0.5 overflow-y-auto lg:grid-cols-3">
                      {shown.map((i) => (
                        <label key={i.name} className="flex min-w-0 items-center gap-1.5 text-xs" title={i.extra ?? i.name}>
                          <input type="checkbox" checked={i.selected} className="accent-[var(--c-accent)]"
                            onChange={(e) => toggle(s.id, i.name, defaults.get(i.name) ?? false, e.target.checked)} />
                          <span className={cx("truncate font-mono", !i.selected && "text-muted")}>{i.name}</span>
                          {i.extra && s.id === "snap" && <span className="text-[10px] text-muted">{i.extra}</span>}
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {preview && (
        <div className="mt-4">
          {preview.secrets.length > 0 && (
            <p className="mb-2 flex items-center gap-2 rounded-md bg-warn/10 px-3 py-2 text-xs text-warn">
              <AlertTriangle size={13} /> The script contains values that look like secrets (line {preview.secrets.map((s) => s.line).join(", ")}). Untick those items before writing it.
            </p>
          )}
          <div className="overflow-hidden rounded-md border border-line">
            <div className="border-b border-line bg-surface-2 px-3 py-1.5 text-xs text-muted">
              {preview.previous ? <>Changes vs the current <code className="font-mono">bootstrap.sh</code></> : "New bootstrap.sh"} in <code className="font-mono">{preview.outDir}</code>
            </div>
            <pre className="selectable max-h-96 overflow-auto bg-surface font-mono text-[11.5px] leading-relaxed">
              {preview.previous
                ? <DiffLines oldText={preview.previous} newText={preview.script} empty="Same as the current bootstrap.sh." />
                : <div className="p-3">{preview.script}</div>}
            </pre>
          </div>
        </div>
      )}
    </Card>
  );
}
