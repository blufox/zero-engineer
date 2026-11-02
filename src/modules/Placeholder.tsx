import { Card, PageHeader } from "../components/ui";
import type { ModuleDef } from "../app/modules";

/** Shown for modules that haven't been built yet. */
export default function Placeholder({ mod }: { mod: ModuleDef }) {
  const Icon = mod.icon;
  return (
    <>
      <PageHeader title={mod.label} description={mod.description} />
      <Card className="grid place-items-center py-16 text-center">
        <Icon size={28} strokeWidth={1.5} className="mb-3 text-muted" />
        <p className="text-sm text-muted">
          Coming in milestone <span className="font-mono text-text">{mod.milestone}</span>. See{" "}
          <code className="font-mono text-xs">.docs/plan.md</code>.
        </p>
      </Card>
    </>
  );
}
