import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { Search } from "lucide-react";
import { MODULES, type ModuleDef } from "./modules";
import { cx } from "../components/ui";
import Logo from "../components/Logo";
import CommandPalette from "./CommandPalette";
import ErrorBoundary from "../components/ErrorBoundary";
import { useSettings } from "../lib/settings";
import { STALE_MS, loadSecurity, peekSecurity, scanSecurity, urgentCount, useSecurity } from "../lib/security";
import { loadRepos } from "../modules/repos/ReposPage";

function NavItem({ mod, badge }: { mod: ModuleDef; badge?: number }) {
  const Icon = mod.icon;
  return (
    <NavLink
      to={mod.path}
      end={mod.path === "/"}
      className={({ isActive }) =>
        cx(
          "group flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] transition",
          isActive ? "bg-accent-soft text-accent font-medium" : "text-muted hover:bg-surface-2 hover:text-text",
        )
      }
    >
      <Icon size={16} strokeWidth={1.75} />
      <span className="flex-1 truncate">{mod.label}</span>
      {!!badge && (
        <span className="rounded-full bg-danger/15 px-1.5 font-mono text-[10px] font-medium text-danger" title={`${badge} critical/high issues`}>{badge}</span>
      )}
      {mod.milestone && (
        <span className="font-mono text-[10px] text-muted/60 group-hover:text-muted">{mod.milestone}</span>
      )}
    </NavLink>
  );
}

export default function Layout() {
  const main = MODULES.filter((m) => !m.footer);
  const footer = MODULES.filter((m) => m.footer);
  // Full-bleed modules manage their own layout (sub-navigation, full-height editors).
  const { pathname } = useLocation();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { settings } = useSettings();
  const sec = useSecurity();
  const badges: Record<string, number> = { security: urgentCount(sec.report, sec.ignored) };

  // Security: once per launch, re-check if the last report is over a day old.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await loadSecurity();
      const { securityCheckOnLaunch, scanRoots, excludedPaths } = settings;
      const { report } = peekSecurity();
      if (cancelled || !securityCheckOnLaunch) return;
      if (report && Date.now() - report.scannedAt * 1000 < STALE_MS) return;
      const list = await loadRepos({ scanRoots, excludedPaths });
      if (!cancelled) await scanSecurity(list.map((r) => r.path), true);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ctrl+K anywhere opens the command palette (even while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  const fullBleed = ["/tools", "/cheatsheets", "/snippets", "/repos", "/glossary"].some((p) => pathname.startsWith(p));

  return (
    <div className="flex h-full">
      <aside className="flex w-56 shrink-0 flex-col border-r border-line bg-surface">
        <div className="flex items-center gap-2 px-4 pt-4 pb-5">
          <Logo size={28} />
          <span className="font-semibold tracking-tight">Zero</span>
        </div>
        <button onClick={() => setPaletteOpen(true)}
          className="mx-2 mb-3 flex items-center gap-2 rounded-md border border-line bg-bg px-2.5 py-1.5 text-left text-xs text-muted transition hover:border-muted hover:text-text">
          <Search size={13} /> <span className="flex-1">Search everything</span>
          <kbd className="rounded border border-line px-1 font-mono text-[10px]">Ctrl K</kbd>
        </button>
        <nav className="flex flex-1 flex-col gap-0.5 px-2">
          {main.map((m) => <NavItem key={m.id} mod={m} badge={badges[m.id]} />)}
        </nav>
        <nav className="flex flex-col gap-0.5 border-t border-line p-2">
          {footer.map((m) => <NavItem key={m.id} mod={m} />)}
        </nav>
      </aside>
      <main className={cx("min-w-0 flex-1", fullBleed ? "overflow-hidden" : "overflow-y-auto")}>
        <ErrorBoundary key={pathname}>
          {fullBleed ? <Outlet /> : (
            <div className="mx-auto max-w-5xl px-8 py-8">
              <Outlet />
            </div>
          )}
        </ErrorBoundary>
      </main>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
