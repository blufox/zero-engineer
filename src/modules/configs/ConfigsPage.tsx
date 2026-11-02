import { useCallback, useEffect, useMemo, useState } from "react";
import { diffLines } from "diff";
import {
  AlertTriangle, Check, ChevronDown, ChevronRight, Copy, FileText, Folder, FolderGit2, FolderOpen, Plus, RefreshCw,
  Save, ShieldAlert, X,
} from "lucide-react";
import { Button, Card, Input, PageHeader, cx } from "../../components/ui";
import { useSettings, DEFAULT_SETTINGS } from "../../lib/settings";
import { errorMessage } from "../../lib/storage";
import {
  configs, launch, type ExportSummary, type FileStatus, type SecretHit, type StatusReport, type TrackedItem,
} from "../../lib/system";
import { copyText } from "../tools/shared";
import { relative } from "../tools/time";

const STATE_STYLE: Record<TrackedItem["state"], [string, string]> = {
  "in-sync": ["backed up", "bg-accent-soft text-accent"],
  changed: ["changed since export", "bg-warn/15 text-warn"],
  never: ["not exported yet", "bg-surface-2 text-muted"],
  missing: ["missing", "bg-danger/10 text-danger"],
  blocked: ["not allowed", "bg-danger/10 text-danger"],
};

const kb = (b: number) => (b < 1024 ? `${b} B` : `${(b / 1024).toFixed(b < 10240 ? 1 : 0)} KB`);
const SENSITIVE_HINTS: Record<string, string> = {
  "~/.ssh/config": "Reveals host names, users and key file names (keys themselves are never exported). Keep the data repo private.",
};

function Diff({ source, onClose }: { source: string; onClose: () => void }) {
  const [texts, setTexts] = useState<{ old: string | null; cur: string | null } | null>(null);
  useEffect(() => {
    Promise.all([configs.backupText(source), configs.currentText(source)]).then(([old, cur]) => setTexts({ old, cur }));
  }, [source]);
  const parts = useMemo(() => (texts ? diffLines(texts.old ?? "", texts.cur ?? "") : []), [texts]);
  const changed = parts.some((p) => p.added || p.removed);

  return (
    <div className="mt-2 overflow-hidden rounded-md border border-line">
      <div className="flex items-center justify-between border-b border-line bg-surface-2 px-3 py-1.5 text-xs">
        <span className="font-mono">{source}</span>
        <div className="flex items-center gap-3 text-muted">
          <span><span className="text-danger">−</span> backup  <span className="text-accent">+</span> current</span>
          {texts?.old != null && (
            <button onClick={() => copyText(texts.old!)} className="flex items-center gap-1 hover:text-text" title="Copy the backed-up version (manual restore)">
              <Copy size={11} /> copy backup
            </button>
          )}
          <button onClick={onClose} className="hover:text-text"><X size={13} /></button>
        </div>
      </div>
      <pre className="selectable max-h-96 overflow-auto bg-surface p-0 font-mono text-[11.5px] leading-relaxed">
        {!texts && <div className="p-3 text-muted">Loading…</div>}
        {texts && texts.old == null && <div className="p-3 text-muted">Not exported yet. Nothing to compare with.</div>}
        {texts && texts.old != null && !changed && <div className="p-3 text-muted">No differences.</div>}
        {texts?.old != null && changed && parts.map((p, i) => {
          const lines = p.value.replace(/\n$/, "").split("\n");
          // Collapse long unchanged stretches to 3 lines of context each side.
          const shown = !p.added && !p.removed && lines.length > 8
            ? [...lines.slice(0, 3), `… ${lines.length - 6} unchanged lines …`, ...lines.slice(-3)]
            : lines;
          return shown.map((l, j) => (
            <div key={`${i}-${j}`} className={cx("px-3",
              p.added && "bg-accent-soft text-accent", p.removed && "bg-danger/10 text-danger",
              l.startsWith("… ") && !p.added && !p.removed && "text-center italic text-muted")}>
              {p.added ? "+ " : p.removed ? "− " : "  "}{l}
            </div>
          ));
        })}
      </pre>
    </div>
  );
}

function ItemRow({ item, onRemove, diffFor, setDiffFor }: {
  item: TrackedItem;
  onRemove: () => void;
  diffFor: string | null;
  setDiffFor: (s: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [label, style] = STATE_STYLE[item.state];
  const Icon = item.kind === "dir" ? Folder : FileText;
  const pending = item.files.filter((f) => f.state !== "same");

  function fileChip(f: FileStatus) {
    const s = { new: "text-accent", changed: "text-warn", same: "text-muted" }[f.state];
    return <span className={cx("font-mono text-[10px]", s)}>{f.state === "same" ? "" : f.state}</span>;
  }

  return (
    <div className="border-b border-line px-4 py-3 last:border-b-0">
      <div className="flex items-center gap-3">
        <button onClick={() => setOpen(!open)} className="text-muted hover:text-text" disabled={item.kind !== "dir" && item.kind !== "file"}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <Icon size={15} className="text-muted" />
        <span className="font-mono text-sm">{item.input}</span>
        <span className={cx("rounded px-1.5 py-0.5 text-[10px]", style)}>{label}</span>
        <div className="flex-1" />
        <span className="text-xs text-muted">
          {item.files.length > 0 && <>{item.files.length} file{item.files.length > 1 && "s"} · {kb(item.totalSize)}</>}
          {item.repos.length > 0 && <> · {item.repos.length} git clone{item.repos.length > 1 && "s"}</>}
        </span>
        {item.kind === "file" && item.files[0] && item.state !== "never" && (
          <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => setDiffFor(diffFor === item.files[0].source ? null : item.files[0].source)}>diff</Button>
        )}
        <button onClick={onRemove} title="Stop tracking" className="rounded p-1 text-muted hover:text-danger"><X size={14} /></button>
      </div>

      {SENSITIVE_HINTS[item.input] && (
        <p className="mt-1.5 ml-11 flex items-center gap-1.5 text-xs text-warn"><ShieldAlert size={12} /> {SENSITIVE_HINTS[item.input]}</p>
      )}
      {item.kind === "outside-home" && <p className="mt-1.5 ml-11 text-xs text-danger">Only files inside your home folder can be tracked.</p>}
      {item.kind === "blocked" && <p className="mt-1.5 ml-11 text-xs text-danger">{item.skipped[0]?.reason}: never exported.</p>}
      {item.removed.length > 0 && <p className="mt-1.5 ml-11 text-xs text-warn">{item.removed.length} previously exported file(s) no longer exist. Export will remove the copies.</p>}

      {item.kind === "file" && item.files[0] && diffFor === item.files[0].source && (
        <div className="ml-11"><Diff source={item.files[0].source} onClose={() => setDiffFor(null)} /></div>
      )}

      {open && item.kind === "dir" && (
        <div className="mt-2 ml-11 space-y-1 text-xs">
          {(pending.length ? pending : item.files).slice(0, 50).map((f) => (
            <div key={f.source}>
              <div className="flex items-center gap-2">
                <span className="font-mono text-text/80">{f.rel}</span> {fileChip(f)}
                <span className="text-muted">{kb(f.size)}</span>
                {f.state === "changed" && (
                  <button onClick={() => setDiffFor(diffFor === f.source ? null : f.source)} className="text-muted hover:text-accent">diff</button>
                )}
              </div>
              {diffFor === f.source && <Diff source={f.source} onClose={() => setDiffFor(null)} />}
            </div>
          ))}
          {pending.length === 0 && item.files.length > 50 && <div className="text-muted">… {item.files.length - 50} more</div>}
          {item.repos.map((r) => {
            const cmd = r.remote
              ? `git clone ${r.remote} ~/${r.rel}${r.commit ? ` && git -C ~/${r.rel} checkout ${r.commit.slice(0, 12)}` : ""}`
              : "";
            return (
              <div key={r.path} className="flex items-center gap-2">
                <FolderGit2 size={12} className="text-muted" />
                <span className="font-mono text-text/80">{r.rel}</span>
                <span className="truncate text-muted">{r.remote ?? "no remote"}{r.commit && ` @ ${r.commit.slice(0, 7)}`}</span>
                {cmd && <button onClick={() => copyText(cmd)} title={cmd} className="flex shrink-0 items-center gap-1 text-muted hover:text-accent"><Copy size={11} /> restore cmd</button>}
              </div>
            );
          })}
          {item.skipped.map((s) => (
            <div key={s.path} className="text-muted"><span className="font-mono">{s.path.replace(/^.*\/\.oh-my-zsh\//, ".oh-my-zsh/")}</span>: skipped ({s.reason})</div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ConfigsPage() {
  const { settings, update } = useSettings();
  const [report, setReport] = useState<StatusReport | null>(null);
  const [secrets, setSecrets] = useState<SecretHit[]>([]);
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExportSummary | null>(null);
  const [newPath, setNewPath] = useState("");
  const [diffFor, setDiffFor] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [r, s] = await Promise.all([configs.status(settings.dotfiles), configs.scanSecrets(settings.dotfiles)]);
      setReport(r ? { ...r, items: r.items ?? [] } : null);
      setSecrets(s ?? []);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [settings.dotfiles]);

  useEffect(() => { refresh(); }, [refresh]);

  const suggested = DEFAULT_SETTINGS.dotfiles.filter((d) => !settings.dotfiles.includes(d));
  const secretFiles = [...new Set(secrets.map((s) => s.file))];
  const unresolved = secretFiles.filter((f) => !skip.has(f));
  const [acknowledged, setAcknowledged] = useState(false);
  const pendingCount = report?.items.reduce((n, i) => n + i.files.filter((f) => f.state !== "same").length + i.removed.length, 0) ?? 0;

  async function doExport() {
    setBusy(true);
    setError(null);
    try {
      setResult(await configs.export(settings.dotfiles, [...skip]));
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function addPath(p: string) {
    const v = p.trim();
    if (!v || settings.dotfiles.includes(v)) return;
    update({ dotfiles: [...settings.dotfiles, v] });
    setNewPath("");
  }

  return (
    <>
      <PageHeader
        title="Config Backup"
        description="Copies your dotfiles into configs/ in your data folder. Commit and push that folder yourself."
        actions={<>
          <Button onClick={refresh}><RefreshCw size={14} /> Refresh</Button>
          <Button variant="primary" onClick={doExport} disabled={busy || !report || (unresolved.length > 0 && !acknowledged)}>
            <Save size={14} /> {busy ? "Exporting…" : pendingCount ? `Export ${pendingCount} change${pendingCount > 1 ? "s" : ""}` : "Export"}
          </Button>
        </>}
      />

      {error && <p className="mb-4 rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}

      {secrets.length > 0 && (
        <Card className="mb-4 border-warn/50">
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-warn"><AlertTriangle size={15} /> Possible secrets found</h2>
          <p className="mb-3 text-xs text-muted">These files look like they contain credentials. Skip them, or move the secrets somewhere untracked (e.g. a <code className="font-mono">~/.secrets</code> file sourced from .zshrc).</p>
          <div className="space-y-2">
            {secretFiles.map((f) => (
              <div key={f} className="rounded-md border border-line bg-surface-2 p-2">
                <div className="mb-1 flex items-center justify-between">
                  <span className="font-mono text-xs">{f}</span>
                  <label className="flex items-center gap-1.5 text-xs">
                    <input type="checkbox" checked={skip.has(f)} className="accent-[var(--c-accent)]"
                      onChange={(e) => setSkip((s) => { const n = new Set(s); e.target.checked ? n.add(f) : n.delete(f); return n; })} />
                    skip this file
                  </label>
                </div>
                {secrets.filter((s) => s.file === f).map((s) => (
                  <div key={s.line} className="font-mono text-[11px] text-muted">
                    <span className="text-warn">L{s.line}</span> {s.kind}: <span className="text-text/80">{s.preview}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
          {unresolved.length > 0 && (
            <label className="mt-3 flex items-center gap-2 text-xs">
              <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} className="accent-[var(--c-accent)]" />
              I understand these files will be copied with the values above.
            </label>
          )}
        </Card>
      )}

      {result && (
        <Card className="mb-4 border-accent/40">
          <div className="flex items-start justify-between gap-4">
            <div className="text-sm">
              <p className="mb-1 flex items-center gap-2 font-medium text-accent"><Check size={15} /> Exported</p>
              <p className="text-xs text-muted">
                {result.added.length} added · {result.updated.length} updated · {result.removed.length} removed · {result.unchanged} unchanged · {result.repos} git clones recorded
                {result.skipped.length > 0 && <> · {result.skipped.length} skipped</>}
              </p>
              {[...result.added, ...result.updated].length > 0 && (
                <p className="mt-1 font-mono text-[11px] text-muted">{[...result.added, ...result.updated].slice(0, 8).join("  ")}</p>
              )}
            </div>
            <Button onClick={() => launch.folder(result.configsDir)}><FolderOpen size={14} /> Open configs/</Button>
          </div>
        </Card>
      )}

      <div className="rounded-lg border border-line bg-surface">
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5 text-xs text-muted">
          <span>Tracked ({settings.dotfiles.length})</span>
          <span>{report?.lastExport ? <>last export {relative(new Date(report.lastExport * 1000))}</> : "never exported"}</span>
        </div>
        {report?.items.map((item) => (
          <ItemRow key={item.input} item={item} diffFor={diffFor} setDiffFor={setDiffFor}
            onRemove={() => update({ dotfiles: settings.dotfiles.filter((d) => d !== item.input) })} />
        ))}
        <div className="flex items-center gap-2 border-t border-line px-4 py-3">
          <Input value={newPath} onChange={(e) => setNewPath(e.target.value)} placeholder="~/.vimrc"
            onKeyDown={(e) => e.key === "Enter" && addPath(newPath)} className="max-w-xs font-mono text-xs" />
          <Button onClick={() => addPath(newPath)} disabled={!newPath.trim()}><Plus size={14} /> Track</Button>
          {suggested.map((s) => (
            <button key={s} onClick={() => addPath(s)} className="rounded-md border border-dashed border-line px-2 py-1 font-mono text-xs text-muted hover:border-accent hover:text-accent">
              + {s}
            </button>
          ))}
        </div>
      </div>

      <p className="mt-4 text-xs leading-relaxed text-muted">
        Files are mirrored by their path under your home folder (e.g. <code className="font-mono">configs/.zshrc</code>) with a
        <code className="font-mono"> manifest.json</code> of checksums. Plugin and theme folders that are git clones are saved as
        URL + commit. SSH private keys, known_hosts, GnuPG and *.pem/*.key files are never exported. Restoring is manual: use
        <em> diff → copy backup</em>, or the restore commands for clones.
        {report && <> Backup folder: <button onClick={() => launch.folder(report.configsDir)} className="font-mono text-accent hover:underline">{report.configsDir}</button></>}
      </p>
    </>
  );
}
