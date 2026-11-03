import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown, ArrowUp, CloudDownload, DatabaseZap, FolderOpen, GitBranch, Globe, KeyRound, RefreshCw, Search, SquareTerminal, FileCode2,
} from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { Button, Kbd, cx } from "../../components/ui";
import { useSettings, type Settings } from "../../lib/settings";
import { errorMessage } from "../../lib/storage";
import { context, hasDrift, isDirty, launch, repos, type EnvDrift, type RepoInfo } from "../../lib/system";
import RepoPanel from "./RepoPanel";
import { checkMigrations, useMigrations } from "../../lib/migrations";
import { Toggle } from "../tools/shared";
import { relative } from "../tools/time";

type Sort = "activity" | "name" | "changes";

// Survives navigating away and back, so the page opens instantly and refreshes in the background.
let cache: RepoInfo[] | null = null;

/** Last scan result (used by the command palette to avoid rescanning). */
export const getCachedRepos = () => cache;

/** Cached repos, or one scan that also fills the cache (shared by Home and the Repos page). */
export async function loadRepos(s: Pick<Settings, "scanRoots" | "excludedPaths">): Promise<RepoInfo[]> {
  if (cache) return cache;
  cache = await repos.scan(s);
  return cache;
}

const STACK_COLORS: Record<string, string> = {
  Laravel: "text-[#e5533d] bg-[#e5533d]/10",
  Django: "text-[#2ba977] bg-[#2ba977]/10",
  Flutter: "text-[#3b9fe8] bg-[#3b9fe8]/10",
  React: "text-[#2fb3d4] bg-[#2fb3d4]/10",
  Rails: "text-[#d0453b] bg-[#d0453b]/10",
};

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      className={cx("rounded-md px-2 py-0.5 text-xs transition",
        active ? "bg-accent-soft text-accent" : "text-muted hover:bg-surface-2 hover:text-text")}>
      {children}
    </button>
  );
}

function IconAction({ title, onClick, children, disabled }: {
  title: string; onClick: () => void; children: React.ReactNode; disabled?: boolean;
}) {
  return (
    <button title={title} onClick={onClick} disabled={disabled}
      className="rounded-md p-1.5 text-muted transition hover:bg-surface-2 hover:text-text disabled:opacity-30">
      {children}
    </button>
  );
}

export default function ReposPage() {
  const { settings } = useSettings();
  const [list, setList] = useState<RepoInfo[] | null>(cache);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<string | null>(null);
  const [stack, setStack] = useState<string | null>(null);
  const [dirtyOnly, setDirtyOnly] = useState(false);
  const [sort, setSort] = useState<Sort>("activity");
  const [fetching, setFetching] = useState<Set<string>>(new Set());
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const searchRef = useRef<HTMLInputElement>(null);
  const [params, setParams] = useSearchParams();
  const selectedPath = params.get("repo");
  const select = useCallback((path: string | null) => {
    setParams(path ? { repo: path } : {}, { replace: true });
  }, [setParams]);
  const closePanel = useCallback(() => select(null), [select]);
  const [envDrift, setEnvDrift] = useState<Record<string, EnvDrift> | null>(null);
  const [checkingEnv, setCheckingEnv] = useState(false);
  const migrationsByPath = useMigrations();
  const [checkingMigrations, setCheckingMigrations] = useState(false);

  async function checkAllMigrations() {
    if (!list) return;
    setCheckingMigrations(true);
    try {
      await checkMigrations(list.filter((r) => r.stacks.includes("Laravel") || r.stacks.includes("Django")).map((r) => r.path));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setCheckingMigrations(false);
    }
  }

  async function checkEnv() {
    if (!list) return;
    setCheckingEnv(true);
    try {
      const results = await context.envDriftAll(list.map((r) => r.path));
      setEnvDrift(Object.fromEntries(results.map((d) => [d.path, d])));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setCheckingEnv(false);
    }
  }

  const scan = useCallback(async () => {
    setScanning(true);
    setError(null);
    try {
      const result = await repos.scan(settings);
      cache = result;
      setList(result);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setScanning(false);
    }
  }, [settings]);

  useEffect(() => { scan(); }, [scan]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (e.key === "/" && !typing) { e.preventDefault(); searchRef.current?.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const replace = (info: RepoInfo) => setList((l) => {
    const next = (l ?? []).map((r) => (r.path === info.path ? info : r));
    cache = next;
    return next;
  });

  async function fetchOne(r: RepoInfo) {
    setFetching((s) => new Set(s).add(r.path));
    setRowErrors(({ [r.path]: _, ...rest }) => rest);
    try {
      replace(await repos.fetch(r.path, settings));
    } catch (e) {
      setRowErrors((m) => ({ ...m, [r.path]: errorMessage(e) }));
    } finally {
      setFetching((s) => { const n = new Set(s); n.delete(r.path); return n; });
    }
  }

  async function run(action: () => Promise<void>, path: string) {
    try { await action(); } catch (e) { setRowErrors((m) => ({ ...m, [path]: errorMessage(e) })); }
  }

  const groups = useMemo(() => [...new Set((list ?? []).map((r) => r.group).filter(Boolean))].sort(), [list]);
  const stacks = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of list ?? []) for (const s of r.stacks) counts.set(s, (counts.get(s) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1]).map(([s]) => s);
  }, [list]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = (list ?? []).filter((r) =>
      (!group || r.group === group) &&
      (!stack || r.stacks.includes(stack)) &&
      (!dirtyOnly || isDirty(r) || r.ahead > 0) &&
      (!q || [r.name, r.path, r.branch ?? "", r.lastCommit?.subject ?? ""].some((v) => v.toLowerCase().includes(q))));
    const changes = (r: RepoInfo) => r.staged + r.modified + r.untracked + r.conflicted + r.ahead;
    return filtered.sort((a, b) =>
      sort === "name" ? a.name.localeCompare(b.name)
        : sort === "changes" ? changes(b) - changes(a)
          : (b.lastCommit?.date ?? "").localeCompare(a.lastCommit?.date ?? ""));
  }, [list, query, group, stack, dirtyOnly, sort]);

  const selected = (list ?? []).find((r) => r.path === selectedPath) ?? null;
  const dirtyCount = (list ?? []).filter(isDirty).length;
  const aheadCount = (list ?? []).filter((r) => r.ahead > 0).length;

  return (
    <div className="flex h-full flex-col">
      <header className="shrink-0 space-y-3 border-b border-line px-8 pt-6 pb-4">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Repositories</h1>
            <p className="mt-1 text-sm text-muted">
              {list ? <>{list.length} repos · {dirtyCount} with changes · {aheadCount} unpushed</> : "Scanning…"}
              <span className="ml-2 font-mono text-xs" title="Scan roots (change in Settings)">{settings.scanRoots.join(", ")}</span>
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">
            <Toggle label="Changes only" checked={dirtyOnly} onChange={setDirtyOnly} />
            <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}
              className="rounded-md border border-line bg-surface px-2 py-1.5 text-xs">
              <option value="activity">Recent activity</option>
              <option value="changes">Most changes</option>
              <option value="name">Name</option>
            </select>
            <Button onClick={checkEnv} disabled={!list || checkingEnv} title="Compare .env with .env.example in every repo (key names only)">
              <KeyRound size={14} className={cx(checkingEnv && "animate-pulse")} /> Check .env
            </Button>
            <Button onClick={checkAllMigrations} disabled={!list || checkingMigrations}
              title="Run migrate:status / showmigrations in every Laravel and Django repo (read-only)">
              <DatabaseZap size={14} className={cx(checkingMigrations && "animate-pulse")} /> Check migrations
            </Button>
            <Button onClick={scan} disabled={scanning}>
              <RefreshCw size={14} className={cx(scanning && "animate-spin")} /> Refresh
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex w-56 items-center gap-2 rounded-md border border-line bg-surface px-2.5 focus-within:border-accent">
            <Search size={14} className="shrink-0 text-muted" />
            <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && (setQuery(""), e.currentTarget.blur())}
              placeholder="Name, branch, commit…" className="min-w-0 flex-1 bg-transparent py-1.5 text-sm focus:outline-none focus-visible:outline-none" />
            {!query && <Kbd>/</Kbd>}
          </div>
          {groups.length > 0 && (
            <div className="flex items-center gap-0.5">
              <Chip active={!group} onClick={() => setGroup(null)}>All</Chip>
              {groups.map((g) => <Chip key={g} active={group === g} onClick={() => setGroup(group === g ? null : g)}>{g}</Chip>)}
            </div>
          )}
          <div className="h-4 w-px bg-line" />
          <div className="flex flex-wrap items-center gap-0.5">
            {stacks.map((s) => <Chip key={s} active={stack === s} onClick={() => setStack(stack === s ? null : s)}>{s}</Chip>)}
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
      <div className="min-h-0 flex-1 overflow-y-auto px-8 py-4">
        {error && <p className="mb-3 rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
        {list && visible.length === 0 && <p className="py-8 text-center text-sm text-muted">No repositories match.</p>}

        <div className="space-y-2">
          {visible.map((r) => {
            const dirty = isDirty(r);
            const busy = fetching.has(r.path);
            const rowError = rowErrors[r.path] ?? r.error;
            const drift = envDrift?.[r.path];
            const driftCount = drift ? drift.missing.length + drift.empty.length + (drift.hasEnv ? 0 : 1) : 0;
            const mig = migrationsByPath[r.path];
            return (
              <div key={r.path}
                onClick={(e) => { if (!(e.target as HTMLElement).closest("button, a")) select(selectedPath === r.path ? null : r.path); }}
                className={cx("group cursor-pointer rounded-lg border bg-surface px-4 py-3 transition hover:border-muted/50",
                  selectedPath === r.path ? "border-accent" : "border-line")}>
                <div className="flex items-center gap-3">
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    {r.group && <span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-muted">{r.group}</span>}
                    <span className="selectable truncate font-medium">{r.name}</span>
                    {r.stacks.map((s) => (
                      <span key={s} className={cx("rounded px-1.5 py-0.5 text-[10px] font-medium", STACK_COLORS[s] ?? "bg-surface-2 text-muted")}>{s}</span>
                    ))}
                    {drift && hasDrift(drift) && (
                      <span className="rounded bg-warn/10 px-1.5 py-0.5 text-[10px] font-medium text-warn"
                        title={drift.hasEnv ? `Missing: ${drift.missing.join(", ") || "none"}\nEmpty: ${drift.empty.join(", ") || "none"}` : "No .env file"}>
                        .env {drift.hasEnv ? `${driftCount} to fix` : "missing"}
                      </span>
                    )}
                    {mig && mig.pending.length > 0 && (
                      <span className="rounded bg-warn/10 px-1.5 py-0.5 text-[10px] font-medium text-warn" title={mig.pending.join("\n")}>
                        {mig.pending.length} pending migration{mig.pending.length > 1 ? "s" : ""}
                      </span>
                    )}
                    {mig?.error && (
                      <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-muted" title={mig.error}>migrations: couldn't check</span>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center opacity-60 transition group-hover:opacity-100">
                    <IconAction title={`Open in ${settings.editorCommand}`} onClick={() => run(() => launch.editor(r.path, settings), r.path)}>
                      <FileCode2 size={15} />
                    </IconAction>
                    <IconAction title="Open terminal here" onClick={() => run(() => launch.terminal(r.path, settings), r.path)}>
                      <SquareTerminal size={15} />
                    </IconAction>
                    <IconAction title="Open folder" onClick={() => run(() => launch.folder(r.path), r.path)}>
                      <FolderOpen size={15} />
                    </IconAction>
                    <IconAction title={r.webUrl ? `Open ${r.webUrl}` : "No browsable remote"} disabled={!r.webUrl}
                      onClick={() => r.webUrl && launch.url(r.webUrl)}>
                      <Globe size={15} />
                    </IconAction>
                    <IconAction title="git fetch" disabled={!r.remoteUrl || busy} onClick={() => fetchOne(r)}>
                      <CloudDownload size={15} className={cx(busy && "animate-pulse text-accent")} />
                    </IconAction>
                  </div>
                </div>

                <div className="mt-1.5 flex items-center gap-3 text-xs text-muted">
                  <span className="flex items-center gap-1 font-mono" title={r.upstream ? `tracking ${r.upstream}` : "no upstream"}>
                    <GitBranch size={12} /> {r.branch ?? "detached"}
                  </span>
                  {r.ahead > 0 && <span className="flex items-center text-accent" title={`${r.ahead} commits not pushed`}><ArrowUp size={12} />{r.ahead}</span>}
                  {r.behind > 0 && <span className="flex items-center text-warn" title={`${r.behind} commits to pull`}><ArrowDown size={12} />{r.behind}</span>}
                  {!r.upstream && r.branch && r.remoteUrl && <span className="text-muted/70">no upstream</span>}
                  {dirty ? (
                    <span className="flex gap-2 font-mono">
                      {r.conflicted > 0 && <span className="text-danger">{r.conflicted} conflicted</span>}
                      {r.staged > 0 && <span className="text-accent">{r.staged} staged</span>}
                      {r.modified > 0 && <span className="text-warn">{r.modified} modified</span>}
                      {r.untracked > 0 && <span>{r.untracked} untracked</span>}
                    </span>
                  ) : !r.error && <span className="text-accent/80">clean</span>}
                  {r.stashes > 0 && <span>{r.stashes} stash{r.stashes > 1 && "es"}</span>}
                  {r.lastCommit && (
                    <span className="ml-auto flex min-w-0 items-center gap-2">
                      <span className="selectable truncate" title={`${r.lastCommit.hash} by ${r.lastCommit.author}`}>{r.lastCommit.subject}</span>
                      <span className="shrink-0" title={new Date(r.lastCommit.date).toLocaleString()}>{relative(new Date(r.lastCommit.date))}</span>
                    </span>
                  )}
                </div>
                {rowError && <p className="mt-1.5 truncate text-xs text-danger" title={rowError}>{rowError}</p>}
              </div>
            );
          })}
        </div>
      </div>
      {selected && <RepoPanel key={selected.path} repo={selected} onClose={closePanel} />}
      </div>
    </div>
  );
}
