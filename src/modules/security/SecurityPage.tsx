import { useEffect, useMemo, useState } from "react";
import { BellOff, ChevronDown, ChevronRight, ExternalLink, EyeOff, RefreshCw, RotateCcw, Search, ShieldCheck } from "lucide-react";
import { Button, PageHeader, cx } from "../../components/ui";
import { useSettings } from "../../lib/settings";
import {
  activeAffected, affectedKey, eolIgnored, eolKey, loadSecurity, scanSecurity, setIgnored, snoozeUntil, urgentCount, useSecurity,
  type IgnoreEntry,
} from "../../lib/security";
import { launch, type EolItem, type Severity, type VulnFinding } from "../../lib/system";
import { loadRepos } from "../repos/ReposPage";
import { Toggle } from "../tools/shared";
import { relative } from "../tools/time";

const SEVERITIES: Severity[] = ["critical", "high", "medium", "low", "unknown"];
const SEV_STYLE: Record<Severity, string> = {
  critical: "bg-danger/15 text-danger",
  high: "bg-danger/10 text-danger",
  medium: "bg-warn/10 text-warn",
  low: "bg-surface-2 text-muted",
  unknown: "bg-surface-2 text-muted/70",
};
const PRODUCT: Record<string, string> = { laravel: "Laravel", django: "Django", php: "PHP", python: "Python", nodejs: "Node.js" };
const PAGE = 150;

const repoName = (p: string | null) => (p ? p.split("/").filter(Boolean).pop() ?? p : "Global tools");

function Pill({ className, children }: { className: string; children: React.ReactNode }) {
  return <span className={cx("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide", className)}>{children}</span>;
}

function IgnoreActions({ onSnooze, onIgnore }: { onSnooze: () => void; onIgnore: () => void }) {
  return (
    <>
      <button title="Snooze for 30 days" onClick={onSnooze} className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-text"><BellOff size={14} /></button>
      <button title="Ignore (accept the risk)" onClick={onIgnore} className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-text"><EyeOff size={14} /></button>
    </>
  );
}

function FindingRow({ f, repo }: { f: VulnFinding; repo: string | null }) {
  const sec = useSecurity();
  const active = activeAffected(f, sec.ignored).filter((a) => !repo || (a.repo ?? "global") === repo);
  const keys = active.map((a) => affectedKey(f, a));
  const ignore = (entry: IgnoreEntry) => setIgnored(keys, entry);
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3">
      <div className="flex items-start gap-3">
        <Pill className={SEV_STYLE[f.severity]}>{f.severity}</Pill>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="selectable font-mono text-sm font-medium">{f.package}</span>
            <span className="text-[11px] text-muted">{f.ecosystem}</span>
            <span className="selectable font-mono text-[11px] text-muted" title={f.aliases.join(", ")}>{f.id}</span>
          </div>
          <p className="selectable mt-0.5 text-sm">{f.summary}</p>
          <ul className="mt-1.5 space-y-0.5 text-xs text-muted">
            {active.map((a) => (
              <li key={`${a.repo}|${a.file}|${a.version}`} className="flex flex-wrap gap-x-2">
                <span className="font-medium text-text/80">{repoName(a.repo)}</span>
                <span className="font-mono">{a.file}</span>
                <span className="font-mono">
                  {a.version}{a.fixed ? <> → <span className="text-accent">{a.fixed}</span></> : <span className="text-muted/70"> (no fix yet)</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex shrink-0 items-center">
          <button title="Open advisory" onClick={() => launch.url(f.advisory ?? f.url)}
            className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-text"><ExternalLink size={14} /></button>
          <IgnoreActions onSnooze={() => ignore({ until: snoozeUntil(30) })} onIgnore={() => ignore({ until: null })} />
        </div>
      </div>
    </div>
  );
}

function EolRow({ e }: { e: EolItem }) {
  const style = e.status === "eol" ? "bg-danger/10 text-danger" : e.status === "soon" ? "bg-warn/10 text-warn" : "bg-surface-2 text-muted";
  const label = e.status === "eol" ? "end of life" : e.status === "soon" ? "ends soon" : e.status;
  return (
    <div className="flex items-start gap-3 rounded-lg border border-line bg-surface px-4 py-3">
      <Pill className={style}>{label}</Pill>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-medium">{PRODUCT[e.product] ?? e.product} {e.cycle}</span>
          {e.eol && <span className="text-xs text-muted">security support {e.status === "eol" ? "ended" : "ends"} {e.eol}</span>}
          {e.latest && <span className="text-xs text-muted">· latest {e.latest}</span>}
        </div>
        <p className="mt-0.5 text-xs text-muted">
          {e.used.map((u) => u.repo ? `${repoName(u.repo)} (${u.file})` : u.file).join(" · ")}
        </p>
      </div>
      <div className="flex shrink-0 items-center">
        <button title="Release and support dates" onClick={() => launch.url(`https://endoflife.date/${e.product}`)}
          className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-text"><ExternalLink size={14} /></button>
        <IgnoreActions onSnooze={() => setIgnored([eolKey(e)], { until: snoozeUntil(30) })} onIgnore={() => setIgnored([eolKey(e)], { until: null })} />
      </div>
    </div>
  );
}

export default function SecurityPage() {
  const { settings, update } = useSettings();
  const sec = useSecurity();
  const { report, ignored, scanning, error } = sec;
  const [sev, setSev] = useState<Severity | null>(null);
  const [repo, setRepo] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [showIgnored, setShowIgnored] = useState(false);

  useEffect(() => { loadSecurity(); }, []);
  useEffect(() => setLimit(PAGE), [sev, repo, query]);

  async function refresh() {
    const list = await loadRepos(settings);
    await scanSecurity(list.map((r) => r.path));
  }

  const repos = useMemo(() => {
    const s = new Set<string>();
    for (const f of report?.findings ?? []) for (const a of f.affected) s.add(a.repo ?? "global");
    return [...s].sort((a, b) => repoName(a === "global" ? null : a).localeCompare(repoName(b === "global" ? null : b)));
  }, [report]);

  const active = useMemo(() => (report?.findings ?? []).filter((f) =>
    activeAffected(f, ignored).some((a) => !repo || (a.repo ?? "global") === repo)), [report, ignored, repo]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const f of active) c[f.severity] = (c[f.severity] ?? 0) + 1;
    return c;
  }, [active]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return active.filter((f) => (!sev || f.severity === sev) &&
      (!q || [f.package, f.id, f.summary, ...f.aliases].some((v) => v.toLowerCase().includes(q))));
  }, [active, sev, query]);

  const ignoredList = useMemo(() => {
    const out: { key: string; label: string; entry: IgnoreEntry }[] = [];
    for (const f of report?.findings ?? []) for (const a of f.affected) {
      const key = affectedKey(f, a);
      const entry = ignored[key];
      if (entry && !activeAffected(f, ignored).includes(a)) out.push({ key, label: `${f.package} ${f.id} · ${repoName(a.repo)}`, entry });
    }
    for (const e of report?.eol ?? []) if (eolIgnored(e, ignored)) out.push({ key: eolKey(e), label: `${PRODUCT[e.product] ?? e.product} ${e.cycle} end of life`, entry: ignored[eolKey(e)] });
    return [...new Map(out.map((o) => [o.key, o])).values()];
  }, [report, ignored]);

  const eol = (report?.eol ?? []).filter((e) => e.status !== "ok" && e.status !== "unknown" && !eolIgnored(e, ignored));
  const urgent = urgentCount(report, ignored);

  return (
    <div>
      <PageHeader title="Security"
        description="Known vulnerabilities in your projects' lockfiles and global tools, and framework or runtime versions past end of life."
        actions={
          <Button onClick={refresh} disabled={scanning}>
            <RefreshCw size={14} className={cx(scanning && "animate-spin")} /> {scanning ? "Checking…" : "Refresh"}
          </Button>
        } />
      <div className="-mt-3 mb-5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        {report
          ? <span>Checked {relative(new Date(report.scannedAt * 1000))} · {report.packages.toLocaleString()} packages · {urgent} critical/high to look at</span>
          : !scanning && <span>Not checked yet. Press Refresh.</span>}
        <Toggle label="Check on launch when the last check is over a day old" checked={settings.securityCheckOnLaunch}
          onChange={(v) => update({ securityCheckOnLaunch: v })} />
        <span className="text-muted/70">Only package names and versions are sent to osv.dev and endoflife.date.</span>
      </div>

      {scanning && !report && <p className="mb-3 text-sm text-muted">Reading lockfiles and asking osv.dev… the first check can take a minute or two.</p>}
      {error && <p className="mb-3 rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}

      {report && (
        <div className="space-y-8">
          {eol.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-xs font-medium uppercase tracking-wide text-muted">End of life</h2>
              {eol.map((e) => <EolRow key={eolKey(e)} e={e} />)}
            </section>
          )}

          <section className="space-y-3">
            <h2 className="text-xs font-medium uppercase tracking-wide text-muted">Vulnerabilities</h2>
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex w-56 items-center gap-2 rounded-md border border-line bg-surface px-2.5 focus-within:border-accent">
                <Search size={14} className="shrink-0 text-muted" />
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Package, CVE, summary…"
                  className="min-w-0 flex-1 bg-transparent py-1.5 text-sm focus:outline-none" />
              </div>
              <div className="flex items-center gap-0.5">
                <button onClick={() => setSev(null)} className={cx("rounded-md px-2 py-0.5 text-xs", !sev ? "bg-accent-soft text-accent" : "text-muted hover:bg-surface-2")}>
                  All <span className="font-mono">{active.length}</span>
                </button>
                {SEVERITIES.filter((s) => counts[s]).map((s) => (
                  <button key={s} onClick={() => setSev(sev === s ? null : s)}
                    className={cx("rounded-md px-2 py-0.5 text-xs capitalize", sev === s ? "bg-accent-soft text-accent" : "text-muted hover:bg-surface-2")}>
                    {s} <span className="font-mono">{counts[s]}</span>
                  </button>
                ))}
              </div>
              <select value={repo ?? ""} onChange={(e) => setRepo(e.target.value || null)}
                className="rounded-md border border-line bg-surface px-2 py-1.5 text-xs">
                <option value="">All repos and tools</option>
                {repos.map((r) => <option key={r} value={r}>{repoName(r === "global" ? null : r)}</option>)}
              </select>
            </div>

            {visible.length === 0 ? (
              <p className="flex items-center gap-2 py-6 text-sm text-muted"><ShieldCheck size={16} className="text-accent" /> Nothing to show.</p>
            ) : (
              <div className="space-y-2">
                {visible.slice(0, limit).map((f) => <FindingRow key={`${f.id}|${f.package}`} f={f} repo={repo} />)}
                {visible.length > limit && (
                  <Button variant="ghost" onClick={() => setLimit(limit + PAGE)}>Show {Math.min(PAGE, visible.length - limit)} more of {visible.length - limit}</Button>
                )}
              </div>
            )}
          </section>

          {ignoredList.length > 0 && (
            <section className="space-y-2">
              <button onClick={() => setShowIgnored(!showIgnored)} className="flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted hover:text-text">
                {showIgnored ? <ChevronDown size={13} /> : <ChevronRight size={13} />} Ignored and snoozed <span className="font-mono">{ignoredList.length}</span>
              </button>
              {showIgnored && (
                <ul className="space-y-1 text-xs">
                  {ignoredList.map((o) => (
                    <li key={o.key} className="flex items-center gap-2 rounded-md bg-surface px-3 py-1.5">
                      <span className="min-w-0 flex-1 truncate font-mono">{o.label}</span>
                      <span className="text-muted">{o.entry.until ? `until ${o.entry.until}` : "ignored"}</span>
                      <button title="Show again" onClick={() => setIgnored([o.key], null)} className="rounded p-1 text-muted hover:bg-surface-2 hover:text-text"><RotateCcw size={12} /></button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {report.notes.length > 0 && (
            <section className="space-y-1">
              <h2 className="text-xs font-medium uppercase tracking-wide text-muted">Not checked</h2>
              <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted">
                {report.notes.map((n) => <li key={n}>{n}</li>)}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
