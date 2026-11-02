import { useCallback, useEffect, useState } from "react";
import { NavLink, Navigate, useNavigate, useParams } from "react-router-dom";
import { ask, message, open, save } from "@tauri-apps/plugin-dialog";
import { Plus, Upload } from "lucide-react";
import { cx } from "../../components/ui";
import { errorMessage, storage } from "../../lib/storage";
import {
  countItems, deleteSheet, loadSheets, normalize, saveSheet, uniqueId, type CheatSheet, type SheetEntry,
} from "./data";
import SheetEditor from "./SheetEditor";
import SheetView from "./SheetView";

type EditState = null | { sheet: CheatSheet; isNew: boolean };

export default function CheatSheetsPage() {
  const { sheetId } = useParams();
  const navigate = useNavigate();
  const [entries, setEntries] = useState<SheetEntry[] | null>(null);
  const [editing, setEditing] = useState<EditState>(null);

  const reload = useCallback(() => loadSheets().then(setEntries), []);
  useEffect(() => { reload(); }, [reload]);

  useEffect(() => setEditing(null), [sheetId]);

  if (!entries) return null;
  const current = entries.find((e) => e.sheet.id === sheetId);
  if (!current && !editing?.isNew) {
    return entries.length ? <Navigate to={`/cheatsheets/${entries[0].sheet.id}`} replace /> : null;
  }

  const ids = entries.map((e) => e.sheet.id);

  function startNew() {
    setEditing({
      isNew: true,
      sheet: { id: "", title: "", tags: [], sections: [{ title: "General", items: [{ keys: [""], description: "" }] }] },
    });
  }

  async function handleSave(sheet: CheatSheet) {
    const final = editing?.isNew ? { ...sheet, id: uniqueId(sheet.title, ids) } : sheet;
    await saveSheet(final);
    await reload();
    setEditing(null);
    navigate(`/cheatsheets/${final.id}`);
  }

  async function handleDelete(entry: SheetEntry) {
    const restoring = entry.origin === "modified";
    const ok = await ask(
      restoring
        ? `Discard your edits to “${entry.sheet.title}” and restore the built-in version?`
        : `Delete “${entry.sheet.title}”? This removes cheatsheets/${entry.sheet.id}.json from your data folder.`,
      { title: restoring ? "Restore built-in" : "Delete cheat sheet", kind: "warning" },
    );
    if (!ok) return;
    await deleteSheet(entry.sheet.id);
    await reload();
    if (!restoring) navigate("/cheatsheets");
  }

  async function handleExport(sheet: CheatSheet) {
    const path = await save({ defaultPath: `${sheet.id}.json`, filters: [{ name: "JSON", extensions: ["json"] }] });
    if (!path) return;
    try {
      await storage.exportFile(path, JSON.stringify(sheet, null, 2) + "\n");
    } catch (e) {
      await message(errorMessage(e), { title: "Export failed", kind: "error" });
    }
  }

  async function handleImport() {
    const path = await open({ multiple: false, filters: [{ name: "JSON", extensions: ["json"] }] });
    if (typeof path !== "string") return;
    try {
      const sheet = normalize(JSON.parse(await storage.importFile(path)));
      if (ids.includes(sheet.id)) {
        const replace = await ask(`A sheet with id “${sheet.id}” already exists. Replace it?`,
          { title: "Import cheat sheet", kind: "warning", okLabel: "Replace", cancelLabel: "Keep both" });
        if (!replace) sheet.id = uniqueId(sheet.id, ids);
      }
      await saveSheet(sheet);
      await reload();
      navigate(`/cheatsheets/${sheet.id}`);
    } catch (e) {
      await message(errorMessage(e), { title: "Import failed", kind: "error" });
    }
  }

  return (
    <div className="flex h-full">
      <nav className="flex w-52 shrink-0 flex-col border-r border-line">
        <div className="flex items-center justify-between px-4 pt-4 pb-3">
          <span className="text-xs font-medium uppercase tracking-wide text-muted">Cheat Sheets</span>
          <div className="flex">
            <button title="Import JSON" onClick={handleImport} className="rounded p-1 text-muted hover:bg-surface-2 hover:text-text"><Upload size={14} /></button>
            <button title="New sheet" onClick={startNew} className="rounded p-1 text-muted hover:bg-surface-2 hover:text-text"><Plus size={15} /></button>
          </div>
        </div>
        <div className="flex-1 space-y-0.5 overflow-y-auto px-2">
          {entries.map(({ sheet, origin }) => (
            <NavLink key={sheet.id} to={`/cheatsheets/${sheet.id}`}
              className={({ isActive }) => cx(
                "flex items-center justify-between rounded-md px-2.5 py-1.5 text-[13px] transition",
                isActive && !editing?.isNew ? "bg-surface-2 font-medium text-text" : "text-muted hover:bg-surface-2 hover:text-text",
              )}>
              <span className="truncate">{sheet.title}{origin === "modified" && <span className="text-warn"> •</span>}</span>
              <span className="font-mono text-[10px] text-muted">{countItems(sheet)}</span>
            </NavLink>
          ))}
        </div>
        <p className="border-t border-line px-4 py-3 text-[11px] leading-relaxed text-muted">
          Saved to <code className="font-mono">cheatsheets/</code> in your data folder.
        </p>
      </nav>

      <div className="min-w-0 flex-1">
        {editing ? (
          <SheetEditor key={editing.isNew ? "new" : editing.sheet.id} initial={editing.sheet} isNew={editing.isNew}
            onSave={handleSave} onCancel={() => setEditing(null)} />
        ) : current && (
          <SheetView sheet={current.sheet} origin={current.origin}
            onEdit={() => setEditing({ sheet: current.sheet, isNew: false })}
            onExport={() => handleExport(current.sheet)}
            onDelete={() => handleDelete(current)} />
        )}
      </div>
    </div>
  );
}
