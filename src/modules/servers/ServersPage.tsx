import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ask, message } from "@tauri-apps/plugin-dialog";
import {
  ChevronDown, ChevronRight, Cog, Copy, ExternalLink, FileCode2, RefreshCw, Server, Square, SquareTerminal, Workflow,
} from "lucide-react";
import { Button, Card, cx } from "../../components/ui";
import { useSettings } from "../../lib/settings";
import { errorMessage } from "../../lib/storage";
import {
  isExposed, launch, servers, type Listener, type ProcessInfo, type ServersSnapshot, type ServiceInfo,
} from "../../lib/system";
import { copyText, Toggle } from "../tools/shared";

const REFRESH_MS = 5000;

const KIND_COLORS: Record<string, string> = {
  Laravel: "text-[#e5533d] bg-[#e5533d]/10",
  Django: "text-[#2ba977] bg-[#2ba977]/10",
  Python: "text-[#3d7ab8] bg-[#3d7ab8]/10",
  Vite: "text-[#9b6cf0] bg-[#9b6cf0]/10",
  "Next.js": "text-text bg-surface-2",
  Flutter: "text-[#3b9fe8] bg-[#3b9fe8]/10",
  Rails: "text-[#d0453b] bg-[#d0453b]/10",
  PHP: "text-[#7a86b8] bg-[#7a86b8]/10",
};

let cache: ServersSnapshot | null = null;

function duration(secs: number): string {
  const d = Math.floor(secs / 86400), h = Math.floor((secs % 86400) / 3600), m = Math.floor((secs % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${secs}s`;
}

const mb = (kb: number) => (kb >= 1024 * 1024 ? `${(kb / 1024 / 1024).toFixed(1)} GB` : `${Math.round(kb / 1024)} MB`);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const urlFor = (l: Listener) => `http://localhost:${l.port}`;

function Section({ icon, title, count, children, collapsible, defaultOpen = true }: {
  icon: ReactNode; title: string; count: number; children: ReactNode; collapsible?: boolean; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <section className="mb-8">
      <button disabled={!collapsible} onClick={() => setOpen(!open)}
        className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted enabled:hover:text-text">
        {collapsible && <Chevron size={13} />}
        {icon} {title} <span className="font-mono normal-case text-muted/70">{count}</span>
      </button>
      {open && children}
    </section>
  );
}

function Act({ title, onClick, children, danger }: { title: string; onClick: () => void; children: ReactNode; danger?: boolean }) {
  return (
    <button title={title} onClick={onClick}
      className={cx("rounded-md p-1.5 text-muted transition hover:bg-surface-2", danger ? "hover:text-danger" : "hover:text-text")}>
      {children}
    </button>
  );
}

function PortChip({ l, onOpen }: { l: Listener; onOpen?: () => void }) {
  const exposed = isExposed(l);
  return (
    <span className="inline-flex items-center gap-1">
      <button onClick={onOpen} disabled={!onOpen} title={`${l.addresses.join(", ")}${onOpen ? " · open in browser" : ""}`}
        className="rounded-md bg-surface-2 px-2 py-0.5 font-mono text-xs text-text transition enabled:hover:bg-accent-soft enabled:hover:text-accent">
        :{l.port}
      </button>
      {exposed && <span className="rounded bg-warn/15 px-1 text-[10px] text-warn" title="Bound to all interfaces: reachable from your network">LAN</span>}
    </span>
  );
}

export default function ServersPage() {
  const { settings } = useSettings();
  const [snap, setSnap] = useState<ServersSnapshot | null>(cache);
  const [auto, setAuto] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updated, setUpdated] = useState<Date | null>(null);
  const [stopping, setStopping] = useState<Set<number>>(new Set());

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const s = await servers.list(settings);
      cache = s;
      setSnap(s);
      setUpdated(new Date());
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [settings]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    if (!auto) return;
    const t = setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
    return () => clearInterval(t);
  }, [auto, refresh]);

  async function stop(p: ProcessInfo) {
    const label = [p.kind, p.role].filter(Boolean).join(" · ") || p.name;
    const ok = await ask(
      `Stop ${label}${p.projectName ? ` in ${p.projectName}` : ""} (pid ${p.stopPid})?\n\n${p.cmdline}`,
      { title: "Stop process", kind: "warning", okLabel: "Stop" },
    );
    if (!ok) return;
    setStopping((s) => new Set(s).add(p.pid));
    try {
      await servers.stop(p.stopPid);
      // Give it a moment to shut down gracefully; offer a force kill if it refuses.
      for (let i = 0; i < 10 && (await servers.alive(p.stopPid)); i++) await new Promise((r) => setTimeout(r, 300));
      if (await servers.alive(p.stopPid)) {
        if (await ask(`${label} is still running after SIGTERM. Force kill it (SIGKILL)?`, { title: "Still running", kind: "warning", okLabel: "Force kill" })) {
          await servers.stop(p.stopPid, true);
        }
      }
    } catch (e) {
      await message(errorMessage(e), { title: "Could not stop process", kind: "error" });
    } finally {
      setStopping((s) => { const n = new Set(s); n.delete(p.pid); return n; });
      refresh();
    }
  }

  const run = (f: () => Promise<unknown>) => f().catch((e) => message(errorMessage(e), { title: "Error", kind: "error" }));

  function ProcessCard({ p, compact }: { p: ProcessInfo; compact?: boolean }) {
    const busy = stopping.has(p.pid);
    return (
      <div className={cx("group rounded-lg border border-line bg-surface px-4 py-3 transition", busy && "opacity-50")}>
        <div className="flex items-center gap-3">
          {p.kind && <span className={cx("rounded px-1.5 py-0.5 text-[11px] font-medium", KIND_COLORS[p.kind] ?? "bg-surface-2 text-muted")}>{p.kind}</span>}
          <span className="font-mono text-sm">{p.role ?? p.name}</span>
          {p.projectName && <span className="truncate text-sm text-muted">in <span className="text-text">{p.projectName}</span></span>}
          <div className="flex flex-wrap gap-1.5">
            {p.ports.map((l) => <PortChip key={l.port} l={l} onOpen={compact ? undefined : () => launch.url(urlFor(l))} />)}
          </div>
          <div className="flex-1" />
          <div className="flex shrink-0 items-center opacity-60 transition group-hover:opacity-100">
            {!compact && p.ports[0] && <>
              <Act title={`Open ${urlFor(p.ports[0])}`} onClick={() => launch.url(urlFor(p.ports[0]))}><ExternalLink size={15} /></Act>
              <Act title="Copy URL" onClick={() => copyText(urlFor(p.ports[0]))}><Copy size={15} /></Act>
            </>}
            {(p.projectPath ?? p.cwd) && <>
              <Act title={`Open project in ${settings.editorCommand}`} onClick={() => run(() => launch.editor((p.projectPath ?? p.cwd)!, settings))}><FileCode2 size={15} /></Act>
              <Act title="Terminal in project" onClick={() => run(() => launch.terminal((p.projectPath ?? p.cwd)!, settings))}><SquareTerminal size={15} /></Act>
            </>}
            {p.owned && <Act danger title={`Stop (pid ${p.stopPid})`} onClick={() => stop(p)}><Square size={14} /></Act>}
          </div>
        </div>
        <div className="mt-1.5 flex items-center gap-3 text-xs text-muted">
          <span className="font-mono">pid {p.pid}</span>
          <span>up {duration(p.uptimeSecs)}</span>
          <span>{mb(p.memoryKb)}</span>
          <span className="selectable min-w-0 flex-1 truncate font-mono" title={p.cmdline}>{p.cmdline}</span>
        </div>
      </div>
    );
  }

  function ServiceTile({ s }: { s: ServiceInfo }) {
    const state = s.active === "active" ? "running" : s.active === "failed" ? "failed" : "stopped";
    const dot = { running: "bg-accent", failed: "bg-danger", stopped: "bg-muted/40" }[state];
    const cmd = `sudo systemctl ${state === "running" ? "restart" : "start"} ${s.unit}`;
    return (
      <div className="rounded-lg border border-line bg-surface p-3">
        <div className="flex items-center gap-2">
          <span className={cx("h-2 w-2 rounded-full", dot)} />
          <span className="font-medium">{s.label}</span>
          <span className="font-mono text-[11px] text-muted">{s.unit}</span>
          <span className="ml-auto text-xs text-muted">{state}</span>
        </div>
        <div className="mt-2 flex items-center gap-1.5">
          {s.ports.map((l) => <PortChip key={l.port} l={l} onOpen={[80, 443, 8025, 15672].includes(l.port) ? () => launch.url(urlFor(l)) : undefined} />)}
          {s.ports.length === 0 && <span className="text-xs text-muted">no ports</span>}
          <button onClick={() => copyText(cmd)} title={`Copy: ${cmd}`}
            className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] text-muted hover:bg-surface-2 hover:text-text">
            <Copy size={11} /> {state === "running" ? "restart" : "start"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <header className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Running Servers</h1>
          <p className="mt-1 text-sm text-muted">
            {snap ? <>{plural(snap.devServers.length, "dev server")} · {plural(snap.workers.length, "worker")} · {plural(snap.services.filter((s) => s.active === "active").length, "service")} running</> : "Looking…"}
            {updated && <span className="ml-2 text-xs">updated {updated.toLocaleTimeString()}</span>}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Toggle label={`Auto-refresh (${REFRESH_MS / 1000}s)`} checked={auto} onChange={setAuto} />
          <Button onClick={refresh} disabled={loading}><RefreshCw size={14} className={cx(loading && "animate-spin")} /> Refresh</Button>
        </div>
      </header>

      {error && <p className="mb-4 rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}

      {snap && <>
        <Section icon={<Server size={13} />} title="Dev servers" count={snap.devServers.length}>
          {snap.devServers.length ? (
            <div className="space-y-2">{snap.devServers.map((p) => <ProcessCard key={p.pid} p={p} />)}</div>
          ) : (
            <Card className="py-8 text-center text-sm text-muted">
              Nothing running. Start one with <code className="font-mono text-text">php artisan serve</code>,{" "}
              <code className="font-mono text-text">python manage.py runserver</code> or <code className="font-mono text-text">npm run dev</code>.
            </Card>
          )}
        </Section>

        {snap.workers.length > 0 && (
          <Section icon={<Workflow size={13} />} title="Background workers" count={snap.workers.length}>
            <div className="space-y-2">{snap.workers.map((p) => <ProcessCard key={p.pid} p={p} compact />)}</div>
          </Section>
        )}

        <Section icon={<Cog size={13} />} title="System services" count={snap.services.length}>
          <div className="grid grid-cols-2 gap-2 xl:grid-cols-3">
            {snap.services.map((s) => <ServiceTile key={s.unit} s={s} />)}
          </div>
          <p className="mt-2 text-xs text-muted">
            Services are read-only here. The copy button gives you the <code className="font-mono">sudo systemctl</code> command to run yourself.
          </p>
        </Section>

        <Section icon={<ExternalLink size={13} />} title="Other listeners" count={snap.other.length + snap.unattributed.length} collapsible defaultOpen={false}>
          <div className="overflow-hidden rounded-lg border border-line bg-surface text-xs">
            {snap.other.map((p) => (
              <div key={p.pid} className="flex items-center gap-3 border-b border-line px-4 py-2 last:border-b-0">
                <span className="w-32 truncate font-medium">{p.name}</span>
                <span className="flex flex-wrap gap-1">{p.ports.map((l) => <PortChip key={l.port} l={l} />)}</span>
                <span className="ml-auto font-mono text-muted">pid {p.pid}</span>
                {p.owned && <Act danger title={`Stop (pid ${p.pid})`} onClick={() => stop(p)}><Square size={13} /></Act>}
              </div>
            ))}
            {snap.unattributed.map((l) => (
              <div key={`u${l.port}`} className="flex items-center gap-3 border-b border-line px-4 py-2 last:border-b-0">
                <span className="w-32 text-muted">system / other user</span>
                <PortChip l={l} />
                <span className="ml-auto truncate font-mono text-muted">{l.addresses.join(", ")}</span>
              </div>
            ))}
          </div>
        </Section>
      </>}
    </>
  );
}
