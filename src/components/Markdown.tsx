import { useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { openUrl } from "@tauri-apps/plugin-opener";

/** Renders Markdown safely; links open in the system browser, not inside the app. */
export default function Markdown({ source, className }: { source: string; className?: string }) {
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(source, { gfm: true, breaks: true, async: false }) as string),
    [source],
  );
  return (
    <div
      className={`prose-zero selectable ${className ?? ""}`}
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest("a");
        if (a?.href) {
          e.preventDefault();
          openUrl(a.href);
        }
      }}
    />
  );
}
