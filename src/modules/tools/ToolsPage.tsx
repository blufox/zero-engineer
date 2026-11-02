import { NavLink, Navigate, useParams } from "react-router-dom";
import { cx } from "../../components/ui";
import { TOOLS } from "./registry";

export default function ToolsPage() {
  const { toolId } = useParams();
  const tool = TOOLS.find((t) => t.id === toolId);
  if (!tool) return <Navigate to={`/tools/${TOOLS[0].id}`} replace />;
  const Tool = tool.component;

  return (
    <div className="flex h-full">
      <nav className="w-44 shrink-0 space-y-0.5 border-r border-line p-2">
        <div className="px-2.5 pt-2 pb-3 text-xs font-medium uppercase tracking-wide text-muted">Dev Tools</div>
        {TOOLS.map((t) => {
          const Icon = t.icon;
          return (
            <NavLink key={t.id} to={`/tools/${t.id}`}
              className={({ isActive }) => cx(
                "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] transition",
                isActive ? "bg-surface-2 font-medium text-text" : "text-muted hover:bg-surface-2 hover:text-text",
              )}>
              <Icon size={15} strokeWidth={1.75} /> {t.label}
            </NavLink>
          );
        })}
      </nav>
      <div className={cx("flex min-w-0 flex-1 flex-col px-8 py-6", tool.fullHeight ? "h-full" : "overflow-y-auto")}>
        <header className="mb-5 shrink-0">
          <h1 className="text-lg font-semibold tracking-tight">{tool.label}</h1>
          <p className="text-sm text-muted">{tool.description}</p>
        </header>
        <div className={cx(tool.fullHeight && "min-h-0 flex-1")}>
          <Tool key={tool.id} />
        </div>
      </div>
    </div>
  );
}
