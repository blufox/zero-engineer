import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { readWithDefaults, storage } from "./storage";

export type ThemePref = "system" | "light" | "dark";
export type Accent = "green" | "blue" | "violet" | "teal" | "amber" | "rose";
export type UiScale = "small" | "default" | "large";

/** Swatches for the settings picker (light-mode accent values; CSS holds both themes). */
export const ACCENTS: { id: Accent; label: string; swatch: string }[] = [
  { id: "green", label: "Green", swatch: "#2f7a5b" },
  { id: "blue", label: "Zero blue", swatch: "#045cb5" },
  { id: "violet", label: "Violet", swatch: "#6d4fc2" },
  { id: "teal", label: "Teal", swatch: "#0f7680" },
  { id: "amber", label: "Amber", swatch: "#a65f00" },
  { id: "rose", label: "Rose", swatch: "#b8325a" },
];

const SCALE_PX: Record<UiScale, string> = { small: "15px", default: "16px", large: "17.5px" };

/** Stored at <data-dir>/settings.json — synced with the data repo. */
export interface Settings {
  version: 1;
  theme: ThemePref;
  accent: Accent;
  uiScale: UiScale;
  /** Command used to open files/folders in an editor; the path is appended. */
  editorCommand: string;
  /** Terminal used to host the editor and "open terminal here". */
  terminalCommand: string;
  /** Vim keybindings in code editors (snippets). */
  editorVimMode: boolean;
  /** Preferred language tab for glossary code examples. */
  glossaryLanguage: string;
  /** Folders scanned for git repositories and matched against running servers. */
  scanRoots: string[];
  /** Paths (or folder names) skipped by the repo scanner. */
  excludedPaths: string[];
  /** Dotfiles tracked by the config backup module. */
  dotfiles: string[];
  /** Let DB snapshots be committed with the backup repo (off: a .gitignore keeps them out). */
  dbSnapshotsInGit: boolean;
  /** Flashcards: enabled deck ids ("cs:<sheet>", "gl:<category>") and new cards per day. */
  review: { decks: string[]; newPerDay: number };
  /** Machine bootstrap: "<section>:<name>" → ticked or not, where you changed the default. */
  bootstrapOverrides: Record<string, boolean>;
}

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  theme: "system",
  accent: "green",
  uiScale: "default",
  editorCommand: "vim",
  terminalCommand: "gnome-terminal",
  editorVimMode: true,
  glossaryLanguage: "php",
  scanRoots: ["~/Documents/www"],
  excludedPaths: ["node_modules", "vendor"],
  dotfiles: ["~/.zshrc", "~/.gitconfig", "~/.oh-my-zsh/custom", "~/.ssh/config"],
  dbSnapshotsInGit: false,
  review: { decks: [], newPerDay: 10 },
  bootstrapOverrides: {},
};

const SETTINGS_FILE = "settings.json";

interface SettingsCtx {
  settings: Settings;
  update: (patch: Partial<Settings>) => Promise<void>;
}

const Ctx = createContext<SettingsCtx | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings | null>(null);

  useEffect(() => {
    readWithDefaults(SETTINGS_FILE, DEFAULT_SETTINGS).then(async (s) => {
      setSettings(s);
      // Persist on first run so the file exists in the data repo.
      if ((await storage.read(SETTINGS_FILE)) === null) await storage.write(SETTINGS_FILE, s);
    });
  }, []);

  useApplyTheme(settings?.theme ?? "system", settings?.accent, settings?.uiScale);

  const update = useCallback(
    async (patch: Partial<Settings>) => {
      if (!settings) return;
      const next = { ...settings, ...patch };
      setSettings(next);
      await storage.write(SETTINGS_FILE, next);
    },
    [settings],
  );

  if (!settings) return null;
  return <Ctx.Provider value={{ settings, update }}>{children}</Ctx.Provider>;
}

export function useSettings() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSettings must be used inside <SettingsProvider>");
  return ctx;
}

/** Toggle the `.dark` class on <html>, following the OS when set to "system". */
export function useApplyTheme(pref: ThemePref, accent: Accent = "green", scale: UiScale = "default") {
  useEffect(() => {
    document.documentElement.dataset.accent = accent;
    // Tailwind sizes are rem-based, so the root font size scales the whole UI.
    document.documentElement.style.fontSize = SCALE_PX[scale] ?? SCALE_PX.default;
  }, [accent, scale]);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = pref === "dark" || (pref === "system" && media.matches);
      document.documentElement.classList.toggle("dark", dark);
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [pref]);
}
