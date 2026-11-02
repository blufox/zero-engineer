import { useMemo } from "react";
import { diffLines } from "diff";
import { cx } from "./ui";

/** Line diff of `oldText` → `newText`, with long unchanged stretches collapsed. */
export default function DiffLines({ oldText, newText, empty = "No differences." }: {
  oldText: string; newText: string; empty?: string;
}) {
  const parts = useMemo(() => diffLines(oldText, newText), [oldText, newText]);
  if (!parts.some((p) => p.added || p.removed)) return <div className="p-3 text-muted">{empty}</div>;
  return (
    <>
      {parts.map((p, i) => {
        const lines = p.value.replace(/\n$/, "").split("\n");
        // Collapse long unchanged stretches to 3 lines of context each side.
        const shown = !p.added && !p.removed && lines.length > 8
          ? [...lines.slice(0, 3), `… ${lines.length - 6} unchanged lines …`, ...lines.slice(-3)]
          : lines;
        return shown.map((l, j) => (
          <div key={`${i}-${j}`} className={cx("px-3",
            p.added && "bg-accent-soft text-accent", p.removed && "bg-danger/10 text-danger",
            l.startsWith("… ") && !p.added && !p.removed && "text-center italic text-muted")}>
            {p.added ? "+ " : p.removed ? "− " : "  "}{l}
          </div>
        ));
      })}
    </>
  );
}
