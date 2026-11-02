import { useEffect, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Archive, Check, FolderOpen, Monitor, Moon, Power, RefreshCw, Sun } from "lucide-react";
import { Button, Card, Field, Input, PageHeader, cx } from "../../components/ui";
import { ACCENTS, useSettings, type Settings, type ThemePref, type UiScale } from "../../lib/settings";
import { errorMessage, formatBytes, storage, type DataUsage } from "../../lib/storage";
import { app, launch, type AutostartStatus } from "../../lib/system";

const THEMES: { value: ThemePref; label: string; icon: typeof Sun }[] = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

/** Text area editing a string[] as one entry per line. */
function ListField({ label, hint, value, onSave }: {
  label: string;
  hint?: string;
  value: string[];
  onSave: (v: string[]) => void;
}) {
  const [text, setText] = useState(value.join("\n"));
  return (
    <Field label={label} hint={hint}>
      <textarea
        value={text}
        rows={Math.max(3, value.length + 1)}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => onSave(text.split("\n").map((l) => l.trim()).filter(Boolean))}
        className="w-full rounded-md border border-line bg-surface px-3 py-2 font-mono text-xs focus:border-accent focus:outline-none"
      />
    </Field>
  );
}

const SCALES: { value: UiScale; label: string }[] = [
  { value: "small", label: "Small" },
  { value: "default", label: "Default" },
  { value: "large", label: "Large" },
];

function Segmented<T extends string>({ value, options, onChange }: {
  value: T; options: { value: T; label: string; icon?: typeof Sun }[]; onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex rounded-md border border-line bg-surface-2 p-0.5">
      {options.map(({ value: v, label, icon: Icon }) => (
        <button key={v} onClick={() => onChange(v)}
          className={cx("flex items-center gap-1.5 rounded px-3 py-1 text-xs transition",
            value === v ? "bg-surface text-text shadow-sm" : "text-muted hover:text-text")}>
          {Icon && <Icon size={13} />} {label}
        </button>
      ))}
    </div>
  );
}

/** What's using space in the data folder, largest first. */
function DataUsageView({ dataDir }: { dataDir: string }) {
  const [usage, setUsage] = useState<DataUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => storage.usage().then(setUsage).catch((e) => setError(errorMessage(e)));
  useEffect(() => { load(); }, [dataDir]);

  if (error) return <p className="mt-3 text-xs text-danger">{error}</p>;
  if (!usage) return <p className="mt-3 text-xs text-muted">Measuring…</p>;
  const max = Math.max(1, ...usage.entries.map((e) => e.bytes));
  return (
    <div className="mt-4">
      <div className="mb-2 flex items-center justify-between text-xs">
        <span className="text-muted">
          Using <span className="font-medium text-text">{formatBytes(usage.totalBytes)}</span> in {usage.totalFiles} files
        </span>
        <button onClick={load} className="flex items-center gap-1 text-muted hover:text-text"><RefreshCw size={11} /> refresh</button>
      </div>
      <div className="space-y-1">
        {usage.entries.map((e) => (
          <div key={e.name} className="flex items-center gap-3 text-xs">
            <span className="w-28 shrink-0 truncate font-mono">{e.name}{e.isDir && "/"}</span>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
              <div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(2, (e.bytes / max) * 100)}%` }} />
            </div>
            <span className="w-16 shrink-0 text-right text-muted">{formatBytes(e.bytes)}</span>
            <span className="w-16 shrink-0 text-right text-muted">{e.isDir ? `${e.files} file${e.files === 1 ? "" : "s"}` : ""}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Start-at-login toggle and one-click archive of the data folder. */
function AppCard({ dataDir }: { dataDir: string }) {
  const [auto, setAuto] = useState<AutostartStatus | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [archiving, setArchiving] = useState(false);
  useEffect(() => { app.autostartStatus().then(setAuto).catch(() => setAuto(null)); }, []);

  async function toggle(enabled: boolean) {
    try { setAuto(await app.setAutostart(enabled)); } catch (e) { setMsg({ kind: "error", text: errorMessage(e) }); }
  }

  async function archive() {
    const date = new Date().toISOString().slice(0, 10);
    const dest = await save({ defaultPath: `zero-data-${date}.tar.gz`, filters: [{ name: "Archive", extensions: ["gz"] }] });
    if (!dest) return;
    setArchiving(true);
    setMsg(null);
    try {
      const size = await app.archiveData(dataDir, dest);
      setMsg({ kind: "ok", text: `Saved ${formatBytes(size)} to ${dest}` });
    } catch (e) {
      setMsg({ kind: "error", text: errorMessage(e) });
    } finally {
      setArchiving(false);
    }
  }

  return (
    <Card>
      <h2 className="mb-4 text-sm font-semibold">App</h2>
      <div className="space-y-4">
        <div className="flex items-start gap-4">
          <Power size={16} className="mt-0.5 text-muted" />
          <div className="flex-1">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={!!auto?.enabled} disabled={!auto} onChange={(e) => toggle(e.target.checked)}
                className="accent-[var(--c-accent)]" />
              Start Zero when I log in
            </label>
            <p className="mt-1 text-xs text-muted">
              Adds <code className="font-mono">~/.config/autostart/zero.desktop</code>.
              {auto && !auto.installed && <span className="text-warn"> You're running a development build. Enable this from the installed app so it launches the right binary.</span>}
            </p>
          </div>
        </div>
        <div className="flex items-start gap-4">
          <Archive size={16} className="mt-0.5 text-muted" />
          <div className="flex-1">
            <Button onClick={archive} disabled={archiving}>{archiving ? "Archiving…" : "Save backup archive (.tar.gz)"}</Button>
            <p className="mt-1 text-xs text-muted">A snapshot of the whole data folder (without <code className="font-mono">.git</code>). Restore by extracting it and pointing the data folder at it.</p>
          </div>
        </div>
        {msg && <p className={cx("text-xs", msg.kind === "ok" ? "text-accent" : "text-danger")}>{msg.text}</p>}
      </div>
    </Card>
  );
}

function TextField({ label, hint, field }: { label: string; hint?: string; field: keyof Settings }) {
  const { settings, update } = useSettings();
  const [value, setValue] = useState(String(settings[field]));
  return (
    <Field label={label} hint={hint}>
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => update({ [field]: value.trim() } as Partial<Settings>)}
        className="font-mono text-xs"
      />
    </Field>
  );
}

export default function SettingsPage({ dataDir, onDataDirChange }: {
  dataDir: string;
  onDataDirChange: (dir: string) => void;
}) {
  const { settings, update } = useSettings();
  const [message, setMessage] = useState<string | null>(null);

  async function changeDataDir() {
    const picked = await open({ directory: true, multiple: false, defaultPath: dataDir });
    if (typeof picked !== "string" || picked === dataDir) return;
    try {
      const res = await storage.setDataDir(picked, true);
      onDataDirChange(res.config.dataDir!);
    } catch (e) {
      setMessage(errorMessage(e));
    }
  }

  return (
    <>
      <PageHeader title="Settings" description={"Saved to settings.json in your data folder."} />

      <div className="space-y-4">
        <Card>
          <h2 className="mb-4 text-sm font-semibold">Data folder</h2>
          <div className="flex items-center gap-2">
            <code className="selectable flex-1 truncate rounded-md bg-surface-2 px-3 py-1.5 font-mono text-xs">
              {dataDir}
            </code>
            <Button onClick={changeDataDir}>
              <FolderOpen size={15} /> Change
            </Button>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => launch.folder(dataDir)}>
              <FolderOpen size={13} /> Open folder
            </Button>
          </div>
          <DataUsageView dataDir={dataDir} />
          <p className="mt-3 text-xs text-muted">
            Changing it does not move existing files. Copy them over, or point it at a cloned data repo.
          </p>
          {message && <p className="mt-2 text-xs text-danger">{message}</p>}
        </Card>

        <Card>
          <h2 className="mb-4 text-sm font-semibold">Appearance</h2>
          <div className="space-y-4">
            <div className="flex items-center gap-4">
              <span className="w-24 text-xs text-muted">Mode</span>
              <Segmented value={settings.theme} onChange={(v) => update({ theme: v })} options={THEMES} />
            </div>
            <div className="flex items-center gap-4">
              <span className="w-24 text-xs text-muted">Accent</span>
              <div className="flex flex-wrap gap-2">
                {ACCENTS.map((a) => (
                  <button key={a.id} onClick={() => update({ accent: a.id })} title={a.label}
                    className={cx("flex items-center gap-2 rounded-md border px-2.5 py-1 text-xs transition",
                      settings.accent === a.id ? "border-text/40 bg-surface-2 text-text" : "border-line text-muted hover:text-text")}>
                    <span className="grid h-4 w-4 place-items-center rounded-full" style={{ background: a.swatch }}>
                      {settings.accent === a.id && <Check size={10} className="text-white" strokeWidth={3} />}
                    </span>
                    {a.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-4">
              <span className="w-24 text-xs text-muted">Text size</span>
              <Segmented value={settings.uiScale} onChange={(v) => update({ uiScale: v })} options={SCALES} />
            </div>
          </div>
        </Card>

        <AppCard dataDir={dataDir} />

        <Card>
          <h2 className="mb-4 text-sm font-semibold">Editor & terminal</h2>
          <div className="grid grid-cols-2 gap-4">
            <TextField label="Editor command" field="editorCommand" hint="Path is appended, e.g. vim <path>" />
            <TextField label="Terminal" field="terminalCommand" hint="Hosts the editor: gnome-terminal -- vim <path>" />
          </div>
        </Card>

        <Card>
          <h2 className="mb-4 text-sm font-semibold">Workspace</h2>
          <div className="grid grid-cols-2 gap-4">
            <ListField label="Scan roots" hint="One folder per line. Scanned for git repos."
              value={settings.scanRoots} onSave={(v) => update({ scanRoots: v })} />
            <ListField label="Excluded paths" hint="Folder names or paths to skip."
              value={settings.excludedPaths} onSave={(v) => update({ excludedPaths: v })} />
          </div>
        </Card>

        <Card>
          <h2 className="mb-4 text-sm font-semibold">Tracked dotfiles</h2>
          <ListField label="Files & folders" hint="Exported to the backup folder chosen on the Config Backup page."
            value={settings.dotfiles} onSave={(v) => update({ dotfiles: v })} />
        </Card>
      </div>
    </>
  );
}
