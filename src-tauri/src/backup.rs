//! App-data backup: copy Zero's own JSON (settings, snippets, cheat sheets, glossary
//! edits) between the data folder and `<backup-dir>/zero/`, so a new machine can be set
//! up by cloning the backup repo, choosing it as the backup folder and pressing Import.
//!
//! - Only `.json` files in the known folders are copied; symlinks and big files are ignored.
//! - Export mirrors the data folder (stale backup copies are removed), but a category that
//!   is empty locally is never wiped from the backup (protects a fresh install).
//! - Import never deletes local files; it only adds and overwrites.

use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::State;

use crate::configs::{scan_text, SecretHit};
use crate::storage::{atomic_write, backup_root, data_root, ConfigState};

/// Sub-folder of the backup folder that holds app data.
pub const APP_DATA_DIR: &str = "zero";
const SETTINGS: &str = "settings.json";
const FOLDERS: &[&str] = &["snippets", "cheatsheets", "glossary", "repo-notes", "review", "logs", "db-connections"];
const CATEGORIES: &[&str] = &[
    "settings", "snippets", "cheatsheets", "glossary", "repo-notes", "review", "logs", "db-connections",
];
const MAX_BYTES: u64 = 10 * 1024 * 1024;

type CmdResult<T> = Result<T, String>;

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncSummary {
    pub added: Vec<String>,
    pub updated: Vec<String>,
    pub removed: Vec<String>,
    pub unchanged: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryStatus {
    pub name: String,
    pub local: usize,
    pub backup: usize,
    /// Local files that are new or differ from the backup.
    pub to_export: usize,
    /// Backup files that are new or differ from the local copy.
    pub to_import: usize,
    /// Backup files Export would remove (deleted locally).
    pub to_remove: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppDataStatus {
    /// `<backup-dir>/zero`, or None when no backup folder is chosen.
    pub backup_dir: Option<String>,
    pub categories: Vec<CategoryStatus>,
    /// Secret-looking values in the local data that Export would copy.
    pub secrets: Vec<SecretHit>,
}

/// Relative path ("snippets/x.json") → absolute path, for every app-data file under `root`.
fn list_files(root: &Path) -> BTreeMap<String, PathBuf> {
    let is_plain_json = |p: &Path| {
        p.extension().is_some_and(|x| x == "json")
            && fs::symlink_metadata(p).is_ok_and(|m| m.is_file() && m.len() <= MAX_BYTES)
    };
    let mut out = BTreeMap::new();
    let settings = root.join(SETTINGS);
    if is_plain_json(&settings) {
        out.insert(SETTINGS.to_string(), settings);
    }
    for dir in FOLDERS {
        let Ok(entries) = fs::read_dir(root.join(dir)) else { continue };
        for e in entries.filter_map(|e| e.ok()) {
            let p = e.path();
            if let (true, Some(name)) = (is_plain_json(&p), e.file_name().to_str()) {
                out.insert(format!("{dir}/{name}"), p);
            }
        }
    }
    out
}

fn category(rel: &str) -> &str {
    rel.split_once('/').map_or("settings", |(dir, _)| dir)
}

fn differs(a: &Path, b: Option<&PathBuf>) -> bool {
    match b {
        None => true,
        Some(b) => !matches!((fs::read(a), fs::read(b)), (Ok(x), Ok(y)) if x == y),
    }
}

/// Copy every app-data file from `from` into `to`. With `prune`, files in `to` that no
/// longer exist in `from` are removed, but only for categories `from` has files in.
pub fn sync(from: &Path, to: &Path, prune: bool) -> CmdResult<SyncSummary> {
    let src = list_files(from);
    let dst = list_files(to);
    let mut s = SyncSummary::default();
    for (rel, path) in &src {
        let bytes = fs::read(path).map_err(|e| format!("{rel}: {e}"))?;
        serde_json::from_slice::<serde_json::Value>(&bytes).map_err(|e| format!("{rel} is not valid JSON: {e}"))?;
        match dst.get(rel) {
            Some(d) if fs::read(d).is_ok_and(|x| x == bytes) => s.unchanged += 1,
            Some(_) => {
                atomic_write(&to.join(rel), &bytes)?;
                s.updated.push(rel.clone());
            }
            None => {
                atomic_write(&to.join(rel), &bytes)?;
                s.added.push(rel.clone());
            }
        }
    }
    if prune {
        let present: BTreeSet<&str> = src.keys().map(|r| category(r)).collect();
        for (rel, path) in &dst {
            if rel != SETTINGS && !src.contains_key(rel) && present.contains(category(rel)) {
                fs::remove_file(path).map_err(|e| format!("{rel}: {e}"))?;
                s.removed.push(rel.clone());
            }
        }
    }
    Ok(s)
}

fn status(data: &Path, backup: Option<&Path>) -> Vec<CategoryStatus> {
    let local = list_files(data);
    let remote = backup.map(list_files).unwrap_or_default();
    CATEGORIES
        .iter()
        .map(|&name| {
            let l: Vec<_> = local.iter().filter(|(r, _)| category(r) == name).collect();
            let b: Vec<_> = remote.iter().filter(|(r, _)| category(r) == name).collect();
            CategoryStatus {
                name: name.into(),
                local: l.len(),
                backup: b.len(),
                to_export: l.iter().filter(|(r, p)| differs(p, remote.get(*r))).count(),
                to_import: b.iter().filter(|(r, p)| differs(p, local.get(*r))).count(),
                to_remove: if l.is_empty() || name == "settings" { 0 } else { b.iter().filter(|(r, _)| !local.contains_key(*r)).count() },
            }
        })
        .collect()
}

fn app_data_backup(state: &State<ConfigState>) -> CmdResult<PathBuf> {
    backup_root(state)?
        .map(|b| b.join(APP_DATA_DIR))
        .ok_or_else(|| "Choose a backup folder first".to_string())
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn app_data_status(state: State<'_, ConfigState>) -> CmdResult<AppDataStatus> {
    let data = data_root(&state)?;
    let backup = backup_root(&state)?.map(|b| b.join(APP_DATA_DIR));
    tauri::async_runtime::spawn_blocking(move || {
        let secrets = list_files(&data)
            .iter()
            .filter_map(|(rel, p)| fs::read_to_string(p).ok().map(|t| scan_text(rel, &t)))
            .flatten()
            .collect();
        Ok(AppDataStatus {
            categories: status(&data, backup.as_deref()),
            backup_dir: backup.map(|b| b.to_string_lossy().into_owned()),
            secrets,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Data folder → `<backup-dir>/zero/` (mirrors).
#[tauri::command]
pub async fn export_app_data(state: State<'_, ConfigState>) -> CmdResult<SyncSummary> {
    let data = data_root(&state)?;
    let backup = app_data_backup(&state)?;
    tauri::async_runtime::spawn_blocking(move || sync(&data, &backup, true))
        .await
        .map_err(|e| e.to_string())?
}

/// `<backup-dir>/zero/` → data folder (adds and overwrites, never deletes).
#[tauri::command]
pub async fn import_app_data(state: State<'_, ConfigState>) -> CmdResult<SyncSummary> {
    let data = data_root(&state)?;
    let backup = app_data_backup(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        if list_files(&backup).is_empty() {
            return Err(format!("No Zero data found in {}. Export from your other machine first.", backup.display()));
        }
        sync(&backup, &data, false)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("zero-backup-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn put(root: &Path, rel: &str, text: &str) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, text).unwrap();
    }

    #[test]
    fn export_mirrors_and_import_never_deletes() {
        let (data, backup) = (tmp("data"), tmp("bk"));
        put(&data, "settings.json", r#"{"theme":"dark"}"#);
        put(&data, "snippets/a.json", r#"{"id":"a"}"#);
        put(&data, "snippets/notes.txt", "ignored");
        put(&backup, "snippets/old.json", r#"{"id":"old"}"#);
        put(&backup, "cheatsheets/vim.json", r#"{"id":"vim"}"#);

        let s = sync(&data, &backup, true).unwrap();
        assert_eq!(s.added, vec!["settings.json", "snippets/a.json"]);
        // Removed: stale snippet. Kept: cheat sheets, because none exist locally.
        assert_eq!(s.removed, vec!["snippets/old.json"]);
        assert!(backup.join("cheatsheets/vim.json").exists());
        assert!(!backup.join("snippets/notes.txt").exists());

        put(&data, "snippets/local-only.json", r#"{"id":"l"}"#);
        let s = sync(&backup, &data, false).unwrap();
        assert_eq!(s.added, vec!["cheatsheets/vim.json"]);
        assert_eq!(s.unchanged, 2);
        assert!(data.join("snippets/local-only.json").exists());

        let st = status(&data, Some(&backup));
        let snip = st.iter().find(|c| c.name == "snippets").unwrap();
        assert_eq!((snip.local, snip.backup, snip.to_export, snip.to_import, snip.to_remove), (2, 1, 1, 0, 0));
        fs::remove_file(data.join("snippets/a.json")).unwrap();
        let snip = status(&data, Some(&backup)).into_iter().find(|c| c.name == "snippets").unwrap();
        assert_eq!(snip.to_remove, 1);

        fs::remove_dir_all(data).unwrap();
        fs::remove_dir_all(backup).unwrap();
    }

    #[test]
    fn refuses_invalid_json() {
        let (data, backup) = (tmp("bad"), tmp("bad-bk"));
        put(&data, "snippets/x.json", "{not json");
        assert!(sync(&data, &backup, true).unwrap_err().contains("not valid JSON"));
        fs::remove_dir_all(data).unwrap();
        fs::remove_dir_all(backup).unwrap();
    }
}
