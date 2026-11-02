/** Languages available in the code editor. Loaded lazily so unused grammars aren't parsed up front. */
import { StreamLanguage, type LanguageSupport } from "@codemirror/language";
import type { Extension } from "@codemirror/state";

export interface LanguageDef {
  id: string;
  label: string;
  load: () => Promise<Extension | LanguageSupport>;
}

export const LANGUAGES: LanguageDef[] = [
  { id: "plaintext", label: "Plain text", load: async () => [] },
  { id: "bash", label: "Bash / Zsh", load: async () => StreamLanguage.define((await import("@codemirror/legacy-modes/mode/shell")).shell) },
  { id: "php", label: "PHP", load: async () => (await import("@codemirror/lang-php")).php({ plain: false }) },
  { id: "python", label: "Python", load: async () => (await import("@codemirror/lang-python")).python() },
  { id: "dart", label: "Dart", load: async () => StreamLanguage.define((await import("@codemirror/legacy-modes/mode/clike")).dart) },
  { id: "javascript", label: "JavaScript", load: async () => (await import("@codemirror/lang-javascript")).javascript({ jsx: true }) },
  { id: "typescript", label: "TypeScript", load: async () => (await import("@codemirror/lang-javascript")).javascript({ typescript: true, jsx: true }) },
  { id: "sql", label: "SQL", load: async () => (await import("@codemirror/lang-sql")).sql() },
  { id: "json", label: "JSON", load: async () => (await import("@codemirror/lang-json")).json() },
  { id: "yaml", label: "YAML", load: async () => (await import("@codemirror/lang-yaml")).yaml() },
  { id: "html", label: "HTML / Blade", load: async () => (await import("@codemirror/lang-html")).html() },
  { id: "css", label: "CSS", load: async () => (await import("@codemirror/lang-css")).css() },
  { id: "markdown", label: "Markdown", load: async () => (await import("@codemirror/lang-markdown")).markdown() },
  { id: "rust", label: "Rust", load: async () => (await import("@codemirror/lang-rust")).rust() },
  { id: "go", label: "Go", load: async () => StreamLanguage.define((await import("@codemirror/legacy-modes/mode/go")).go) },
  { id: "dockerfile", label: "Dockerfile", load: async () => StreamLanguage.define((await import("@codemirror/legacy-modes/mode/dockerfile")).dockerFile) },
  { id: "nginx", label: "Nginx / Apache conf", load: async () => StreamLanguage.define((await import("@codemirror/legacy-modes/mode/nginx")).nginx) },
];

export const languageLabel = (id: string) => LANGUAGES.find((l) => l.id === id)?.label ?? id;
