import { useSyncExternalStore } from "react";
import { sendNotification, isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { errorMessage, storage } from "./storage";
import { security, type EolItem, type SecurityReport, type VulnAffected, type VulnFinding } from "./system";

/** `until`: ISO date the snooze ends, or null for ignored for good. */
export interface IgnoreEntry { until: string | null }
interface IgnoreFile { entries: Record<string, IgnoreEntry> }

const IGNORED = "security/ignored.json";
const NOTIFIED = "security/notified.json";
export const STALE_MS = 24 * 60 * 60 * 1000;

interface State {
  report: SecurityReport | null;
  ignored: Record<string, IgnoreEntry>;
  scanning: boolean;
  error: string | null;
  loaded: boolean;
}

let state: State = { report: null, ignored: {}, scanning: false, error: null, loaded: false };
const listeners = new Set<() => void>();
const set = (patch: Partial<State>) => { state = { ...state, ...patch }; listeners.forEach((l) => l()); };

export const peekSecurity = (): State => state;

export function useSecurity(): State {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => state);
}

// Keys --------------------------------------------------------------------

export const affectedKey = (f: VulnFinding, a: Pick<VulnAffected, "repo">) => `${f.id}|${f.package}|${a.repo ?? "global"}`;
export const eolKey = (e: EolItem) => `eol|${e.product}|${e.cycle}`;

function isIgnored(key: string, ignored: Record<string, IgnoreEntry>): boolean {
  const e = ignored[key];
  return !!e && (e.until === null || new Date(e.until) > new Date());
}

/** Affected locations not ignored or snoozed. */
export const activeAffected = (f: VulnFinding, ignored = state.ignored) =>
  f.affected.filter((a) => !isIgnored(affectedKey(f, a), ignored));
export const eolIgnored = (e: EolItem, ignored = state.ignored) => isIgnored(eolKey(e), ignored);

/** Critical/high findings and past-EOL cycles that still need attention. */
export function urgentKeys(report: SecurityReport | null, ignored: Record<string, IgnoreEntry>): string[] {
  if (!report) return [];
  const keys: string[] = [];
  for (const f of report.findings) {
    if (f.severity !== "critical" && f.severity !== "high") continue;
    for (const a of activeAffected(f, ignored)) keys.push(affectedKey(f, a));
  }
  for (const e of report.eol) if (e.status === "eol" && !eolIgnored(e, ignored)) keys.push(eolKey(e));
  return [...new Set(keys)];
}

/** Badge count: distinct urgent advisories + EOL cycles. */
export function urgentCount(report: SecurityReport | null, ignored: Record<string, IgnoreEntry>): number {
  if (!report) return 0;
  const n = report.findings.filter((f) => (f.severity === "critical" || f.severity === "high") && activeAffected(f, ignored).length > 0).length;
  return n + report.eol.filter((e) => e.status === "eol" && !eolIgnored(e, ignored)).length;
}

// Loading and scanning ----------------------------------------------------

export async function loadSecurity(): Promise<void> {
  if (state.loaded) return;
  try {
    const [report, ign] = await Promise.all([security.last(), storage.read<IgnoreFile>(IGNORED)]);
    set({ report, ignored: ign?.entries ?? {}, loaded: true });
  } catch (e) {
    set({ error: errorMessage(e), loaded: true });
  }
}

export async function scanSecurity(paths: string[], notify = false): Promise<void> {
  if (state.scanning) return;
  set({ scanning: true, error: null });
  try {
    const report = await security.scan(paths);
    set({ report });
    if (notify) await notifyNew(report);
  } catch (e) {
    set({ error: errorMessage(e) });
  } finally {
    set({ scanning: false });
  }
}

async function notifyNew(report: SecurityReport) {
  const urgent = urgentKeys(report, state.ignored);
  const seen = new Set((await storage.read<{ keys: string[] }>(NOTIFIED))?.keys ?? []);
  const fresh = urgent.filter((k) => !seen.has(k));
  await storage.write(NOTIFIED, { keys: urgent });
  if (fresh.length === 0) return;
  let ok = await isPermissionGranted();
  if (!ok) ok = (await requestPermission()) === "granted";
  if (!ok) return;
  const pkgs = new Set(fresh.map((k) => k.split("|")[1]));
  sendNotification({
    title: `${fresh.length} new security issue${fresh.length > 1 ? "s" : ""}`,
    body: `Critical/high advisories or end-of-life versions in ${[...pkgs].slice(0, 4).join(", ")}${pkgs.size > 4 ? "…" : ""}. Open Zero → Security.`,
  });
}

// Ignore / snooze ---------------------------------------------------------

export async function setIgnored(keys: string[], entry: IgnoreEntry | null): Promise<void> {
  const next = { ...state.ignored };
  for (const k of keys) {
    if (entry) next[k] = entry; else delete next[k];
  }
  set({ ignored: next });
  await storage.write<IgnoreFile>(IGNORED, { entries: next });
}

export const snoozeUntil = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
