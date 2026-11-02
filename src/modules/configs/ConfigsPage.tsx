import { useCallback, useEffect, useState } from "react";
import DiffLines from "../../components/DiffLines";
import BootstrapCard from "./BootstrapCard";
import { ask, open } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle, Check, ChevronDown, ChevronRight, Copy, Download, FileText, Folder, FolderGit2, FolderOpen, HardDrive,
  Plus, RefreshCw, Save, ShieldAlert, Upload, X,
} from "lucide-react";
import { Button, Card, Input, PageHeader, cx } from "../../components/ui";
import { useSettings, DEFAULT_SETTINGS } from "../../lib/settings";
import { errorMessage, storage } from "../../lib/storage";
import {
  appData, configs, launch, type AppDataStatus, type ExportSummary, type SyncSummary, type FileStatus, type SecretHit, type StatusReport, type TrackedItem,
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
        {texts?.old != null && <DiffLines oldText={texts.old} newText={texts.cur ?? ""} />}
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

/** Survives the reload that follows an import, so the result can still be shown. */
const IMPORT_RESULT_KEY = "zero.importResult";

function summaryText(s: SyncSummary, verb: string) {
  const parts = [`${s.added.length} added`, `${s.updated.length} updated`];
  if (s.removed.length) parts.push(`${s.removed.length} removed`);
  parts.push(`${s.unchanged} unchanged`);
  return `${verb}: ${parts.join(" · ")}`;
}

/** Where dotfiles and app data are backed up. Stored per machine, not in settings.json. */
function BackupFolderCard({ backupDir, dataDir, onChange }: {
  backupDir: string | null;
  dataDir: string | null;
  onChange: (dir: string | null) => void;
}) {
  const [error, setError] = useState<string | null>(null);

  async function choose(path: string | null) {
    setError(null);
    try {
      const cfg = await storage.setBackupDir(path);
      onChange(cfg.backupDir ?? null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function browse() {
    const picked = await open({ directory: true, multiple: false, defaultPath: backupDir ?? undefined });
    if (typeof picked === "string") choose(picked);
  }

  return (
    <Card className="mb-4">
      <div className="flex items-center gap-3">
        <HardDrive size={16} className="text-muted" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">Backup folder</h2>
          <p className="truncate font-mono text-xs text-muted" title={backupDir ?? undefined}>
            {backupDir ?? <>{dataDir}/configs <span className="font-sans">(default, dotfiles only)</span></>}
          </p>
        </div>
        {backupDir && <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => launch.folder(backupDir)}><FolderOpen size={13} /> Open</Button>}
        {backupDir && <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => choose(null)}>Use default</Button>}
        <Button onClick={browse}><FolderOpen size={14} /> {backupDir ? "Change" : "Choose folder"}</Button>
      </div>
      <p className="mt-2 text-xs text-muted">
        Point this at a git repo you push (e.g. <code className="font-mono">~/dotfiles</code>). Dotfiles go to
        <code className="font-mono"> dotfiles/</code> and snippets, cheat sheets, glossary edits and settings go to
        <code className="font-mono"> zero/</code>. On a new PC: clone the repo, choose it here, then press Import.
        This setting is saved on this machine only.
      </p>
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
    </Card>
  );
}

const CATEGORY_LABEL: Record<string, string> = {
  settings: "Settings", snippets: "Snippets & notes", cheatsheets: "Cheat sheets", glossary: "Glossary edits",
  "repo-notes": "Repo notes", review: "Flashcard progress", logs: "Pinned logs", "db-connections": "DB connections",
};

/** Export/import Zero's own data to/from <backupDir>/zero. */
function AppDataCard({ backupDir, refreshKey }: { backupDir: string | null; refreshKey: number }) {
  const [status, setStatus] = useState<AppDataStatus | null>(null);
  const [busy, setBusy] = useState<"export" | "import" | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(() => {
    try {
      const saved = sessionStorage.getItem(IMPORT_RESULT_KEY);
      sessionStorage.removeItem(IMPORT_RESULT_KEY);
      return saved ? { kind: "ok", text: saved } : null;
    } catch { return null; }
  });
  const [acknowledged, setAcknowledged] = useState(false);

  const load = useCallback(() => {
    appData.status().then(setStatus).catch((e) => setMessage({ kind: "error", text: errorMessage(e) }));
  }, []);
  useEffect(load, [load, backupDir, refreshKey]);

  const toExport = status?.categories.reduce((n, c) => n + c.toExport + c.toRemove, 0) ?? 0;
  const toImport = status?.categories.reduce((n, c) => n + c.toImport, 0) ?? 0;
  const inBackup = status?.categories.reduce((n, c) => n + c.backup, 0) ?? 0;
  const secretFiles = [...new Set(status?.secrets.map((s) => s.file) ?? [])];

  async function doExport() {
    setBusy("export");
    setMessage(null);
    try {
      setMessage({ kind: "ok", text: summaryText(await appData.export(), "Exported") });
      load();
    } catch (e) {
      setMessage({ kind: "error", text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  }

  async function doImport() {
    const ok = await ask(
      `Import ${toImport} file${toImport === 1 ? "" : "s"} from ${status?.backupDir}?\n\n` +
      "Files with the same name in your data folder are overwritten. Nothing is deleted. The app reloads afterwards.",
      { title: "Import from backup", kind: "warning", okLabel: "Import" },
    );
    if (!ok) return;
    setBusy("import");
    setMessage(null);
    try {
      const text = summaryText(await appData.import(), "Imported");
      try { sessionStorage.setItem(IMPORT_RESULT_KEY, text); } catch { /* message is optional */ }
      // Reload so settings and every page re-read the imported files.
      window.location.reload();
    } catch (e) {
      setMessage({ kind: "error", text: errorMessage(e) });
      setBusy(null);
    }
  }

  return (
    <Card className="mb-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Snippets & app data</h2>
          <p className="text-xs text-muted">
            {backupDir ? <>Synced with <code className="font-mono">{status?.backupDir ?? `${backupDir}/zero`}</code></> : "Choose a backup folder above to export or import."}
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={doImport} disabled={!backupDir || !!busy || inBackup === 0 || toImport === 0}
            title={inBackup === 0 ? "Nothing in the backup folder yet" : undefined}>
            <Download size={14} /> {busy === "import" ? "Importing…" : toImport ? `Import ${toImport}` : "Import"}
          </Button>
          <Button variant="primary" onClick={doExport}
            disabled={!backupDir || !!busy || (toExport === 0 && inBackup > 0) || (secretFiles.length > 0 && !acknowledged)}>
            <Upload size={14} /> {busy === "export" ? "Exporting…" : toExport ? `Export ${toExport}` : "Export"}
          </Button>
        </div>
      </div>

      {status && (
        <div className="grid grid-cols-4 gap-2">
          {status.categories.map((c) => (
            <div key={c.name} className="rounded-md border border-line bg-surface-2 px-3 py-2 text-xs">
              <div className="font-medium">{CATEGORY_LABEL[c.name] ?? c.name}</div>
              <div className="mt-0.5 text-muted">
                {c.local} here{backupDir && <> · {c.backup} in backup</>}
              </div>
              {backupDir && (c.toExport > 0 || c.toImport > 0 || c.toRemove > 0) && (
                <div className="mt-0.5 text-warn">
                  {[c.toExport && `${c.toExport} to export`, c.toRemove && `${c.toRemove} deleted here`, c.toImport && `${c.toImport} to import`]
                    .filter(Boolean).join(" · ")}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {backupDir && secretFiles.length > 0 && (
        <div className="mt-3 rounded-md border border-warn/50 p-2">
          <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-warn"><AlertTriangle size={13} /> Possible secrets in your data</p>
          {status!.secrets.map((s) => (
            <div key={`${s.file}:${s.line}`} className="font-mono text-[11px] text-muted">
              <span className="text-text/80">{s.file}</span> <span className="text-warn">L{s.line}</span> {s.kind}: {s.preview}
            </div>
          ))}
          <label className="mt-2 flex items-center gap-2 text-xs">
            <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} className="accent-[var(--c-accent)]" />
            I understand these values will be copied to the backup folder.
          </label>
        </div>
      )}

      {message && <p className={cx("mt-3 text-xs", message.kind === "ok" ? "text-accent" : "text-danger")}>{message.text}</p>}
    </Card>
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
  const [folders, setFolders] = useState<{ backupDir: string | null; dataDir: string | null } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    storage.getAppConfig()
      .then((c) => setFolders({ backupDir: c.backupDir ?? null, dataDir: c.dataDir }))
      .catch((e) => setError(errorMessage(e)));
  }, []);

  const refresh = useCallback(async () => {
    setError(null);
    setRefreshKey((k) => k + 1);
    try {
      const [r, s] = await Promise.all([configs.status(settings.dotfiles), configs.scanSecrets(settings.dotfiles)]);
      setReport(r ? { ...r, items: r.items ?? [] } : null);
      setSecrets(s ?? []);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [settings.dotfiles]);

  useEffect(() => { refresh(); }, [refresh, folders?.backupDir]);

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
        description="Copies your dotfiles, snippets and other Zero data into a backup folder. Commit and push that folder yourself."
        actions={<>
          <Button onClick={refresh}><RefreshCw size={14} /> Refresh</Button>
          <Button variant="primary" onClick={doExport} disabled={busy || !report || (unresolved.length > 0 && !acknowledged)}>
            <Save size={14} /> {busy ? "Exporting…" : pendingCount ? `Export ${pendingCount} dotfile change${pendingCount > 1 ? "s" : ""}` : "Export dotfiles"}
          </Button>
        </>}
      />

      {error && <p className="mb-4 rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}

      {folders && (
        <>
          <BackupFolderCard backupDir={folders.backupDir} dataDir={folders.dataDir}
            onChange={(backupDir) => { setResult(null); setFolders({ ...folders, backupDir }); }} />
          <AppDataCard backupDir={folders.backupDir} refreshKey={refreshKey} />
        </>
      )}

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
            <Button onClick={() => launch.folder(result.configsDir)}><FolderOpen size={14} /> Open folder</Button>
          </div>
        </Card>
      )}

      <div className="rounded-lg border border-line bg-surface">
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5 text-xs text-muted">
          <span>Tracked dotfiles ({settings.dotfiles.length})</span>
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
        Dotfiles are mirrored by their path under your home folder (e.g. <code className="font-mono">dotfiles/.zshrc</code>) with a
        <code className="font-mono"> manifest.json</code> of checksums. Plugin and theme folders that are git clones are saved as
        URL + commit. SSH private keys, known_hosts, GnuPG and *.pem/*.key files are never exported. Restoring is manual: use
        <em> diff → copy backup</em>, or the restore commands for clones.
        {report && <> Dotfiles folder: <button onClick={() => launch.folder(report.configsDir)} className="font-mono text-accent hover:underline">{report.configsDir}</button></>}
      </p>

      <BootstrapCard />
    </>
  );
}
