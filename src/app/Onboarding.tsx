import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen } from "lucide-react";
import { Button, Card, Field, Input } from "../components/ui";
import { errorMessage, storage, type AppConfig } from "../lib/storage";
import { useApplyTheme } from "../lib/settings";
import Logo from "../components/Logo";

/** First-run screen: choose (and optionally git-init) the data folder. */
export default function Onboarding({ onDone }: { onDone: (c: AppConfig) => void }) {
  const [path, setPath] = useState("");
  const [gitInit, setGitInit] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useApplyTheme("system");

  useEffect(() => {
    storage.defaultDataDir().then(setPath);
  }, []);

  async function browse() {
    const picked = await open({ directory: true, multiple: false, defaultPath: path || undefined });
    if (typeof picked === "string") setPath(picked);
  }

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const res = await storage.setDataDir(path, gitInit);
      onDone(res.config);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid h-full place-items-center p-8">
      <Card className="w-full max-w-lg p-8">
        <div className="mb-6 flex items-center gap-3">
          <Logo size={44} />
          <div>
            <h1 className="text-lg font-semibold">Welcome to Zero</h1>
            <p className="text-sm text-muted">Pick a folder to keep your hub's data in.</p>
          </div>
        </div>

        <p className="mb-5 text-sm leading-relaxed text-muted">
          Everything (snippets, cheat sheets, settings and config backups) is saved as plain JSON
          in this folder. Make it a git repo and push it somewhere to back it up.
        </p>

        <div className="space-y-4">
          <Field label="Data folder">
            <div className="flex gap-2">
              <Input value={path} onChange={(e) => setPath(e.target.value)} className="font-mono text-xs" />
              <Button onClick={browse} title="Browse">
                <FolderOpen size={15} />
              </Button>
            </div>
          </Field>

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={gitInit} onChange={(e) => setGitInit(e.target.checked)}
              className="accent-[var(--c-accent)]" />
            Initialise as a git repository (skipped if it already is one)
          </label>

          {error && <p className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}

          <Button variant="primary" className="w-full justify-center" onClick={confirm} disabled={busy || !path}>
            {busy ? "Setting up…" : "Use this folder"}
          </Button>
        </div>
      </Card>
    </div>
  );
}
