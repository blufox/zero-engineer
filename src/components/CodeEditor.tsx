/**
 * CodeMirror 6 wrapper used for snippets (and later anywhere we need an editor).
 * Colours come from CSS variables so it follows the light/dark theme automatically.
 */
import { useEffect, useRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder as placeholderExt } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { indentWithTab } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { vim, Vim } from "@replit/codemirror-vim";
import { LANGUAGES } from "../lib/languages";

const theme = EditorView.theme({
  "&": { backgroundColor: "var(--c-surface)", color: "var(--c-text)", fontSize: "12.5px", height: "100%" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.6" },
  ".cm-content": { caretColor: "var(--c-accent)", padding: "10px 0" },
  ".cm-gutters": { backgroundColor: "var(--c-surface)", color: "var(--c-muted)", border: "none" },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "color-mix(in srgb, var(--c-surface-2) 70%, transparent)" },
  "&.cm-focused": { outline: "none" },
  "&.cm-focused .cm-cursor": { borderLeftColor: "var(--c-accent)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--c-accent-soft) !important",
  },
  ".cm-fat-cursor": { background: "var(--c-accent) !important", color: "var(--c-bg) !important" },
  "&:not(.cm-focused) .cm-fat-cursor": { background: "none !important", outline: "1px solid var(--c-accent)" },
  ".cm-panels": { backgroundColor: "var(--c-surface-2)", color: "var(--c-text)", fontFamily: "var(--font-mono)" },
  ".cm-vim-panel input": { color: "var(--c-text)" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--c-surface-2)", border: "none", color: "var(--c-muted)" },
  ".cm-tooltip": { backgroundColor: "var(--c-surface)", border: "1px solid var(--c-line)" },
  ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--c-warn) 30%, transparent)" },
});

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword], color: "var(--s-keyword)" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--s-string)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--s-number)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--s-comment)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: "var(--s-func)" },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--s-type)" },
  { tag: [t.propertyName, t.attributeName], color: "var(--s-prop)" },
  { tag: [t.tagName, t.heading], color: "var(--s-tag)", fontWeight: "600" },
  { tag: [t.variableName, t.definition(t.variableName)], color: "var(--s-var)" },
  { tag: [t.link, t.url], color: "var(--c-accent)", textDecoration: "underline" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "700" },
]);

// Vim ex commands → app actions. Registered once (they're global to the Vim plugin);
// the event carries the EditorView that ran the command so only that editor reacts.
// (While the ":" prompt is open focus is in the prompt, so we can't rely on hasFocus.)
let exRegistered = false;
function registerVimEx() {
  if (exRegistered) return;
  exRegistered = true;
  const fire = (name: string, cm: { cm6?: EditorView }) =>
    window.dispatchEvent(new CustomEvent(`zero:editor-${name}`, { detail: cm.cm6 }));
  Vim.defineEx("write", "w", (cm) => fire("save", cm));
  Vim.defineEx("quit", "q", (cm) => fire("quit", cm));
  // Saving already closes the editor in the app, so :wq / :x are just "save".
  Vim.defineEx("wq", "wq", (cm) => fire("save", cm));
  Vim.defineEx("xit", "x", (cm) => fire("save", cm));
}

export interface CodeEditorProps {
  value: string;
  onChange?: (v: string) => void;
  language?: string;
  readOnly?: boolean;
  vimMode?: boolean;
  lineNumbers?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  /** Ctrl+S, or :w in Vim mode. */
  onSave?: () => void;
  /** :q in Vim mode. */
  onQuit?: () => void;
  className?: string;
}

export default function CodeEditor({
  value, onChange, language = "plaintext", readOnly = false, vimMode = false,
  lineNumbers = true, placeholder, autoFocus, onSave, onQuit, className,
}: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const langC = useRef(new Compartment());
  const roC = useRef(new Compartment());
  const vimC = useRef(new Compartment());
  // Keep latest callbacks without re-creating the editor.
  const cbs = useRef({ onChange, onSave, onQuit });
  cbs.current = { onChange, onSave, onQuit };

  useEffect(() => {
    registerVimEx();
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          vimC.current.of(vimMode && !readOnly ? vim({ status: true }) : []),
          basicSetup,
          keymap.of([
            indentWithTab,
            { key: "Mod-s", preventDefault: true, run: () => { cbs.current.onSave?.(); return true; } },
          ]),
          theme,
          syntaxHighlighting(highlight),
          EditorView.lineWrapping,
          placeholder ? placeholderExt(placeholder) : [],
          lineNumbers ? [] : EditorView.theme({ ".cm-gutters": { display: "none" } }),
          langC.current.of([]),
          roC.current.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cbs.current.onChange?.(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    if (autoFocus) v.focus();

    const mine = (e: Event) => (e as CustomEvent).detail === v;
    const onSaveEv = (e: Event) => mine(e) && cbs.current.onSave?.();
    const onQuitEv = (e: Event) => mine(e) && cbs.current.onQuit?.();
    window.addEventListener("zero:editor-save", onSaveEv);
    window.addEventListener("zero:editor-quit", onQuitEv);
    return () => {
      window.removeEventListener("zero:editor-save", onSaveEv);
      window.removeEventListener("zero:editor-quit", onQuitEv);
      v.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync external value changes (e.g. switching snippets) without clobbering typing.
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
    }
  }, [value]);

  useEffect(() => {
    let cancelled = false;
    const def = LANGUAGES.find((l) => l.id === language) ?? LANGUAGES[0];
    def.load().then((ext) => {
      if (!cancelled) view.current?.dispatch({ effects: langC.current.reconfigure(ext) });
    });
    return () => { cancelled = true; };
  }, [language]);

  useEffect(() => {
    view.current?.dispatch({
      effects: [
        roC.current.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
        vimC.current.reconfigure(vimMode && !readOnly ? vim({ status: true }) : []),
      ],
    });
  }, [readOnly, vimMode]);

  return <div ref={host} className={className} />;
}
