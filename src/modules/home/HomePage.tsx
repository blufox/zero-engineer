import { Link } from "react-router-dom";
import { MODULES } from "../../app/modules";
import { Kbd, PageHeader } from "../../components/ui";

export default function HomePage() {
  const modules = MODULES.filter((m) => m.id !== "home" && !m.footer);

  return (
    <>
      <PageHeader title="Your hub" description="Everything you reach for when you're stuck, in one place." />
      <p className="-mt-3 mb-6 text-sm text-muted">
        Press <Kbd>Ctrl K</Kbd> to search everything: shortcuts, snippets, patterns, repos and tools.
      </p>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        {modules.map((m) => {
          const Icon = m.icon;
          return (
            <Link
              key={m.id}
              to={m.path}
              className="group rounded-lg border border-line bg-surface p-4 transition hover:border-accent"
            >
              <div className="mb-3 flex items-center justify-between">
                <Icon size={18} strokeWidth={1.75} className="text-accent" />
                {m.milestone && (
                  <span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-muted">
                    soon · {m.milestone}
                  </span>
                )}
              </div>
              <h2 className="text-sm font-medium">{m.label}</h2>
              <p className="mt-1 text-xs leading-relaxed text-muted">{m.description}</p>
            </Link>
          );
        })}
      </div>
    </>
  );
}
