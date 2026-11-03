import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ask } from "@tauri-apps/plugin-dialog";
import { Camera, Database, GitBranch, Pencil, RefreshCw, RotateCcw, Trash2, TriangleAlert } from "lucide-react";
import { Button, Input, PageHeader, cx } from "../../components/ui";
import { useSettings } from "../../lib/settings";
import { errorMessage, formatBytes, storage } from "../../lib/storage";
import { db, type DbConnection, type DbDriver, type DbTools, type RepoDb, type RepoInfo } from "../../lib/system";
import { loadRepos } from "../repos/ReposPage";
import { noteSlug } from "../repos/notes";
import { Toggle } from "../tools/shared";
import { useMigrations } from "../../lib/migrations";
import { relative } from "../tools/time";

const DRIVER_LABEL: Record<DbDriver, string> = { mysql: "MySQL", pgsql: "PostgreSQL", sqlite: "SQLite" };
const DEFAULT_PORT: Record<DbDriver, number | null> = { mysql: 3306, pgsql: 5432, sqlite: null };

function missingTools(t: DbTools, driver: DbDriver): string[] {
  if (driver === "mysql") return [!t.mysqldump && "mysqldump", !t.mysql && "mysql", !t.gzip && "gzip"].filter(Boolean) as string[];
  if (driver === "pgsql") return [!t.pgDump && "pg_dump", !t.pgRestore && "pg_restore"].filter(Boolean) as string[];
  return [];
}

function ConnectionForm({ initial, onSave, onCancel, onReset }: {
  initial: DbConnection; onSave: (c: DbConnection) => void; onCancel: () => void; onReset?: () => void;
}) {
  const [c, setC] = useState(initial);
  const set = (patch: Partial<DbConnection>) => setC((x) => ({ ...x, ...patch }));
  return (
    <div className="mt-3 space-y-2 rounded-md border border-line bg-bg p-3">
      <div className="grid grid-cols-6 gap-2">
        <select value={c.driver} onChange={(e) => set({ driver: e.target.value as DbDriver, port: DEFAULT_PORT[e.target.value as DbDriver] })}
          className="col-span-2 rounded-md border border-line bg-surface px-2 py-1.5 text-sm">
          {Object.entries(DRIVER_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        {c.driver === "sqlite" ? (
          <Input className="col-span-4" placeholder="/path/to/db.sqlite3" value={c.database} onChange={(e) => set({ database: e.target.value })} />
        ) : (
          <>
            <Input className="col-span-3" placeholder="Host (127.0.0.1)" value={c.host} onChange={(e) => set({ host: e.target.value })} />
            <Input className="col-span-1" placeholder="Port" value={c.port ?? ""} onChange={(e) => set({ port: e.target.value ? Number(e.target.value) || null : null })} />
            <Input className="col-span-3" placeholder="Database" value={c.database} onChange={(e) => set({ database: e.target.value })} />
            <Input className="col-span-3" placeholder="User" value={c.user} onChange={(e) => set({ user: e.target.value })} />
          </>
        )}
      </div>
      <p className="text-[11px] text-muted">Passwords aren't saved. Zero uses the one in the project's .env, or asks when you take a snapshot.</p>
      <div className="flex gap-2">
        <Button variant="primary" onClick={() => onSave(c)} disabled={!c.database.trim()}>Save connection</Button>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        {onReset && <Button variant="ghost" className="ml-auto" onClick={onReset}>Use detected settings</Button>}
      </div>
    </div>
  );
}

function RepoCard({ item, name, tools, highlight, onChanged }: {
  item: RepoDb; name: string; tools: DbTools | null; highlight: boolean; onChanged: () => Promise<void>;
}) {
  const { settings } = useSettings();
  const [label, setLabel] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ file: string; typed: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const [keep, setKeep] = useState(5);
  const ref = useRef<HTMLDivElement>(null);
  const d = item.db;
  const missing = d && tools ? missingTools(tools, d.driver) : [];
  const needsPassword = d && d.driver !== "sqlite" && !d.hasPassword;
  const pw = password || null;
  const commit = settings.dbSnapshotsInGit;
  const pending = useMigrations()[item.repo]?.pending ?? [];

  useEffect(() => { if (highlight) ref.current?.scrollIntoView({ block: "center" }); }, [highlight]);

  async function run(key: string, action: () => Promise<string | void>) {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const msg = await action();
      if (msg) setNotice(msg);
      await onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const snapshot = () => run("snapshot", async () => {
    const s = await db.snapshot(item.repo, item.slug, label, pw, commit);
    setLabel("");
    return `Saved ${s.file} (${formatBytes(s.size)})`;
  });

  const restore = (file: string) => run(`restore:${file}`, async () => {
    const pre = await db.restore(item.repo, item.slug, file, pw, commit);
    setConfirm(null);
    return `Restored. Your database from just before was saved as "${pre.label}".`;
  });

  const remove = async (file: string) => {
    if (!(await ask(`Delete snapshot ${file}?`, { title: "Delete snapshot", kind: "warning" }))) return;
    run(`delete:${file}`, () => db.remove(item.slug, file));
  };

  const prune = async () => {
    const n = item.snapshots.length - keep;
    if (n <= 0) return;
    if (!(await ask(`Delete the ${n} oldest snapshot${n > 1 ? "s" : ""} of ${name}, keeping the newest ${keep}?`, { title: "Prune snapshots", kind: "warning" }))) return;
    run("prune", async () => `Removed ${await db.prune(item.slug, keep)} snapshots.`);
  };

  const clear = async () => {
    if (!(await ask(`Delete all ${item.snapshots.length} snapshots of ${name}?`, { title: "Clear snapshots", kind: "warning" }))) return;
    run("clear", async () => `Removed ${await db.clear(item.slug)} snapshots.`);
  };

  const connFile = `db-connections/${item.slug}.json`;
  const saveConnection = (c: DbConnection) => run("conn", async () => {
    await storage.write(connFile, c);
    setEditing(false);
  });
  const resetConnection = () => run("conn", async () => {
    await storage.remove(connFile);
    setEditing(false);
  });

  return (
    <div ref={ref} className={cx("rounded-lg border bg-surface p-4", highlight ? "border-accent" : "border-line")}>
      <div className="flex items-start gap-3">
        <Database size={18} className="mt-0.5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="font-medium">{name}</h2>
            {d && <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-muted">{DRIVER_LABEL[d.driver]}</span>}
            {d && <span className="text-[11px] text-muted">from {d.source}</span>}
            <button title="Edit connection" onClick={() => setEditing(!editing)} className="rounded p-1 text-muted hover:bg-surface-2 hover:text-text">
              <Pencil size={12} />
            </button>
          </div>
          {d ? (
            <p className="selectable mt-0.5 truncate font-mono text-xs text-muted">
              {d.driver === "sqlite" ? d.database : `${d.user || "(no user)"}@${d.host || "socket"}${d.port ? `:${d.port}` : ""}/${d.database}`}
              {d.driver !== "sqlite" && <span className="ml-2 font-sans">{d.hasPassword ? "· password from config" : "· no password in config"}</span>}
            </p>
          ) : <p className="mt-0.5 text-xs text-muted">No database configured any more. Old snapshots are kept.</p>}
        </div>
        <span className="shrink-0 text-xs text-muted">{item.snapshots.length} snapshots · {formatBytes(item.totalSize)}</span>
      </div>

      {editing && (
        <ConnectionForm
          initial={{ driver: d?.driver ?? "mysql", host: d?.host ?? "127.0.0.1", port: d?.port ?? null, database: d?.database ?? "", user: d?.user ?? "" }}
          onSave={saveConnection} onCancel={() => setEditing(false)} onReset={d?.source === "manual" ? resetConnection : undefined} />
      )}

      {d && !d.local && (
        <p className="mt-3 flex items-center gap-2 rounded-md bg-warn/10 px-3 py-2 text-xs text-warn">
          <TriangleAlert size={13} /> Host "{d.host}" isn't local (maybe a Docker service). Zero only snapshots databases on localhost or a socket.
        </p>
      )}
      {missing.length > 0 && (
        <p className="mt-3 rounded-md bg-warn/10 px-3 py-2 text-xs text-warn">
          Missing {missing.join(", ")}. Install with <code className="font-mono">sudo apt install {d?.driver === "pgsql" ? "postgresql-client" : "mysql-client"}</code>.
        </p>
      )}

      {d?.local && missing.length === 0 && pending.length > 0 && (
        <p className="mt-3 flex items-center gap-2 rounded-md bg-warn/10 px-3 py-2 text-xs text-warn" title={pending.join("\n")}>
          <TriangleAlert size={13} /> {pending.length} pending migration{pending.length > 1 ? "s" : ""}. Take a snapshot before you migrate.
        </p>
      )}
      {d?.local && missing.length === 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Input className="w-64" placeholder="Label, e.g. before add_orders migration" value={label}
            onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.key === "Enter" && snapshot()} />
          {needsPassword && (
            <Input className="w-48" type="password" placeholder="Password (not saved)" value={password} onChange={(e) => setPassword(e.target.value)} />
          )}
          <Button variant="primary" onClick={snapshot} disabled={!!busy}>
            <Camera size={14} className={cx(busy === "snapshot" && "animate-pulse")} />
            {busy === "snapshot" ? "Dumping…" : "Snapshot now"}
          </Button>
        </div>
      )}

      {error && <pre className="selectable mt-3 whitespace-pre-wrap rounded-md bg-danger/10 px-3 py-2 text-xs text-danger">{error}</pre>}
      {notice && <p className="mt-3 rounded-md bg-accent-soft px-3 py-2 text-xs text-accent">{notice}</p>}

      {item.snapshots.length > 0 && (
        <>
          <ul className="mt-3 divide-y divide-line rounded-md border border-line">
            {item.snapshots.map((s) => (
              <li key={s.file} className="px-3 py-2">
                <div className="flex items-center gap-3 text-xs">
                  <span className={cx("font-medium", s.label === "pre-restore" && "text-warn")}>{s.label}</span>
                  <span className="text-muted" title={new Date(s.created * 1000).toLocaleString()}>{relative(new Date(s.created * 1000))}</span>
                  {s.branch && <span className="flex items-center gap-1 font-mono text-muted"><GitBranch size={11} />{s.branch}</span>}
                  {s.migration && <span className="truncate font-mono text-muted" title={`Newest migration: ${s.migration}`}>{s.migration}</span>}
                  <span className="ml-auto shrink-0 text-muted">{formatBytes(s.size)}</span>
                  <button title="Restore this snapshot" disabled={!d?.local || !!busy || missing.length > 0}
                    onClick={() => setConfirm({ file: s.file, typed: "" })}
                    className="rounded p-1 text-muted hover:bg-surface-2 hover:text-text disabled:opacity-30">
                    <RotateCcw size={13} />
                  </button>
                  <button title="Delete" disabled={!!busy} onClick={() => remove(s.file)}
                    className="rounded p-1 text-muted hover:bg-danger/10 hover:text-danger disabled:opacity-30">
                    <Trash2 size={13} />
                  </button>
                </div>
                {confirm?.file === s.file && d && (
                  <div className="mt-2 space-y-2 rounded-md bg-warn/10 p-3 text-xs">
                    <p className="text-warn">
                      This replaces the current contents of <b>{d.database}</b>. Zero saves a "pre-restore" snapshot first.
                      Type <code className="font-mono">{d.database.split("/").pop()}</code> to confirm.
                    </p>
                    <div className="flex gap-2">
                      <Input autoFocus className="w-64" value={confirm.typed} onChange={(e) => setConfirm({ ...confirm, typed: e.target.value })} />
                      <Button variant="primary" disabled={confirm.typed !== d.database.split("/").pop() || !!busy} onClick={() => restore(s.file)}>
                        {busy === `restore:${s.file}` ? "Restoring…" : "Restore"}
                      </Button>
                      <Button variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
          <div className="mt-2 flex items-center justify-end gap-2 text-xs text-muted">
            Keep newest
            <select value={keep} onChange={(e) => setKeep(Number(e.target.value))} className="rounded border border-line bg-surface px-1.5 py-0.5">
              {[1, 3, 5, 10, 20].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <Button variant="ghost" className="text-xs" onClick={prune} disabled={item.snapshots.length <= keep || !!busy}>Prune</Button>
            <Button variant="ghost" className="text-xs hover:text-danger" onClick={clear} disabled={!!busy}>Delete all</Button>
          </div>
        </>
      )}
    </div>
  );
}

export default function DatabasesPage() {
  const { settings, update } = useSettings();
  const [params] = useSearchParams();
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [items, setItems] = useState<RepoDb[] | null>(null);
  const [tools, setTools] = useState<DbTools | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<string>("");
  const focus = params.get("repo");

  const load = useCallback(async () => {
    try {
      const list = await loadRepos(settings);
      setRepos(list);
      const [res, t] = await Promise.all([db.list(list.map((r) => ({ path: r.path, slug: noteSlug(r) }))), db.tools()]);
      setItems(res);
      setTools(t);
    } catch (e) {
      setError(errorMessage(e));
      setItems([]);
    }
  }, [settings]);

  useEffect(() => { load(); }, [load]);

  const names = useMemo(() => new Map(repos.map((r) => [r.path, r.name])), [repos]);
  const without = repos.filter((r) => !items?.some((i) => i.repo === r.path)).sort((a, b) => a.name.localeCompare(b.name));
  const total = items?.reduce((n, i) => n + i.totalSize, 0) ?? 0;

  async function addConnection(c: DbConnection) {
    const r = repos.find((x) => x.path === adding);
    if (!r) return;
    await storage.write(`db-connections/${noteSlug(r)}.json`, c);
    setAdding("");
    await load();
  }

  return (
    <>
      <PageHeader title="Databases"
        description="Snapshot a project's local database before a risky migration, and restore it if things go wrong."
        actions={<Button onClick={load}><RefreshCw size={14} /> Refresh</Button>} />
      <div className="-mt-3 mb-5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        {tools && <span>Saved to <code className="selectable font-mono">{tools.snapshotsDir}</code> · {formatBytes(total)}</span>}
        <Toggle label="Commit snapshots with the backup repo" checked={settings.dbSnapshotsInGit}
          onChange={(v) => update({ dbSnapshotsInGit: v })} />
        {!settings.dbSnapshotsInGit && <span className="text-muted/70">(kept out of git by a .gitignore)</span>}
      </div>

      {error && <p className="mb-3 rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
      {!items && <p className="text-sm text-muted">Looking for databases…</p>}
      {items?.length === 0 && <p className="text-sm text-muted">No Laravel or Django databases found in your repos. Add a connection below.</p>}

      <div className="space-y-3">
        {items?.map((i) => (
          <RepoCard key={i.slug} item={i} name={names.get(i.repo) ?? i.repo.split("/").pop()!} tools={tools}
            highlight={focus === i.repo} onChanged={load} />
        ))}
      </div>

      {without.length > 0 && (
        <div className="mt-6 rounded-lg border border-dashed border-line p-4">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted">Add a connection for</span>
            <select value={adding} onChange={(e) => setAdding(e.target.value)} className="rounded-md border border-line bg-surface px-2 py-1 text-sm">
              <option value="">choose a repo…</option>
              {without.map((r) => <option key={r.path} value={r.path}>{r.name}</option>)}
            </select>
          </div>
          {adding && (
            <ConnectionForm key={adding} initial={{ driver: "mysql", host: "127.0.0.1", port: 3306, database: "", user: "root" }}
              onSave={addConnection} onCancel={() => setAdding("")} />
          )}
        </div>
      )}
    </>
  );
}
