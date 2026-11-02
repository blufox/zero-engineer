/** Building blocks shared by every dev tool. */
import { useEffect, useState, type ReactNode, type TextareaHTMLAttributes } from "react";
import { Check, Copy } from "lucide-react";
import { cx } from "../../components/ui";

// ---------------------------------------------------------------------------
// State that survives switching between tools (in memory, for this app session).
// ---------------------------------------------------------------------------
const memory = new Map<string, unknown>();

export function useToolState<T>(key: string, initial: T | (() => T)) {
  const [value, setValue] = useState<T>(() => {
    if (memory.has(key)) return memory.get(key) as T;
    return typeof initial === "function" ? (initial as () => T)() : initial;
  });
  useEffect(() => {
    memory.set(key, value);
  }, [key, value]);
  return [value, setValue] as const;
}

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------
export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback for webviews without async clipboard permission.
    const el = document.createElement("textarea");
    el.value = text;
    document.body.appendChild(el);
    el.select();
    document.execCommand("copy");
    el.remove();
  }
}

export function CopyButton({ value, className }: { value: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      title="Copy"
      disabled={!value}
      onClick={async () => {
        await copyText(value);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
      className={cx(
        "rounded p-1 text-muted transition hover:bg-surface-2 hover:text-text disabled:opacity-30",
        className,
      )}
    >
      {done ? <Check size={14} className="text-accent" /> : <Copy size={14} />}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------
export function Pane({ label, actions, children, className }: {
  label: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cx("flex min-h-0 flex-col", className)}>
      <div className="mb-1.5 flex h-7 items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">{label}</span>
        {actions && <div className="flex items-center gap-1">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

export function CodeArea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      spellCheck={false}
      autoCorrect="off"
      autoCapitalize="off"
      className={cx(
        "w-full flex-1 resize-none rounded-md border border-line bg-surface p-3 font-mono text-xs leading-relaxed",
        "text-text placeholder:text-muted focus:border-accent focus:outline-none",
        className,
      )}
      {...props}
    />
  );
}

/** A labelled read-only value with a copy button. */
export function OutputRow({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center gap-3 border-b border-line px-3 py-2 last:border-b-0">
      <span className="w-28 shrink-0 text-xs text-muted">{label}</span>
      <span className={cx("selectable flex-1 break-all text-[13px]", mono && "font-mono text-xs")}>
        {value || <span className="text-muted">—</span>}
      </span>
      <CopyButton value={value} />
    </div>
  );
}

export function OutputList({ children }: { children: ReactNode }) {
  return <div className="rounded-md border border-line bg-surface">{children}</div>;
}

export function Message({ kind, children }: { kind: "error" | "ok" | "info"; children: ReactNode }) {
  const styles = {
    error: "bg-danger/10 text-danger",
    ok: "bg-accent-soft text-accent",
    info: "bg-surface-2 text-muted",
  };
  return <div className={cx("rounded-md px-3 py-2 text-xs", styles[kind])}>{children}</div>;
}

/** Small segmented toggle used for modes (encode/decode, s/ms, ...). */
export function Segmented<T extends string>({ value, options, onChange }: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex rounded-md border border-line bg-surface-2 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cx(
            "rounded px-2.5 py-0.5 text-xs transition",
            value === o.value ? "bg-surface text-text shadow-sm" : "text-muted hover:text-text",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)}
        className="accent-[var(--c-accent)]" />
      {label}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Encoding helpers (UTF-8 safe base64)
// ---------------------------------------------------------------------------
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  let s = b64.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (s.length % 4 === 1) throw new Error("Invalid base64 length");
  s += "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export const toBase64Url = (b64: string) => b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const strictDecoder = new TextDecoder("utf-8", { fatal: true });
export const decodeUtf8 = (bytes: Uint8Array) => strictDecoder.decode(bytes);
export const encodeUtf8 = (s: string) => new TextEncoder().encode(s);
