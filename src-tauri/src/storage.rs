//! JSON storage layer.
//!
//! Two locations are involved:
//! - `app.json` in the OS config dir (`~/.config/dev.vivico.zero/`) — only remembers
//!   *where* the data folder is. This is machine-local and never synced.
//! - The data folder itself (user-chosen, git-tracked) — holds every other JSON file.
//!
//! All data paths coming from the frontend are relative to the data folder and are
//! validated so they can't escape it.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

use crate::paths::expand_home;

/// Sub-folders created inside a fresh data folder.
const DATA_SUBDIRS: &[&str] = &["cheatsheets", "glossary", "snippets", "configs"];

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub data_dir: Option<String>,
    /// Where Config Backup writes dotfiles and app data. Machine-local, so a new PC can
    /// point at a freshly cloned backup repo before any data exists. `None` = `<data>/configs`.
    #[serde(default)]
    pub backup_dir: Option<String>,
}

pub struct ConfigState(pub Mutex<AppConfig>);

type CmdResult<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn config_file(app: &AppHandle) -> CmdResult<PathBuf> {
    let dir = app.path().app_config_dir().map_err(err)?;
    fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir.join("app.json"))
}

pub fn load_config(app: &AppHandle) -> AppConfig {
    config_file(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Write via temp file + rename so a crash never leaves half-written JSON.
pub(crate) fn atomic_write(path: &Path, contents: &[u8]) -> CmdResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(err)?;
    }
    let tmp = path.with_extension("json.tmp");
    {
        let mut f = fs::File::create(&tmp).map_err(err)?;
        f.write_all(contents).map_err(err)?;
        f.sync_all().map_err(err)?;
    }
    fs::rename(&tmp, path).map_err(err)
}

pub(crate) fn data_root(state: &State<ConfigState>) -> CmdResult<PathBuf> {
    let cfg = state.0.lock().map_err(err)?;
    cfg.data_dir
        .as_ref()
        .map(PathBuf::from)
        .ok_or_else(|| "Data folder is not configured yet".to_string())
}

/// The user-chosen backup folder, if any.
pub(crate) fn backup_root(state: &State<ConfigState>) -> CmdResult<Option<PathBuf>> {
    Ok(state.0.lock().map_err(err)?.backup_dir.as_ref().map(PathBuf::from))
}

fn save_config(app: &AppHandle, state: &State<ConfigState>, config: AppConfig) -> CmdResult<AppConfig> {
    let json = serde_json::to_vec_pretty(&config).map_err(err)?;
    atomic_write(&config_file(app)?, &json)?;
    *state.0.lock().map_err(err)? = config.clone();
    Ok(config)
}

/// Resolve a frontend-supplied relative path inside the data folder.
fn resolve(state: &State<ConfigState>, rel: &str) -> CmdResult<PathBuf> {
    Ok(data_root(state)?.join(safe_relative(rel)?))
}

/// Only plain relative segments are allowed: no `..`, no absolute paths, no `./`.
fn safe_relative(rel: &str) -> CmdResult<&Path> {
    let path = Path::new(rel);
    let ok = !rel.is_empty() && path.components().all(|c| matches!(c, Component::Normal(_)));
    if ok { Ok(path) } else { Err(format!("Invalid data path: {rel}")) }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_app_config(state: State<ConfigState>) -> CmdResult<AppConfig> {
    Ok(state.0.lock().map_err(err)?.clone())
}

#[tauri::command]
pub fn default_data_dir() -> String {
    let home = std::env::var("HOME").unwrap_or_else(|_| "~".into());
    format!("{home}/Documents/www/Locals/zero-data")
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataDirResult {
    pub config: AppConfig,
    pub git_initialized: bool,
    pub already_git_repo: bool,
}

/// Point the app at a data folder. Creates the folder structure and, if asked,
/// runs `git init` there. Existing files are never overwritten.
#[tauri::command]
pub fn set_data_dir(
    app: AppHandle,
    state: State<ConfigState>,
    path: String,
    git_init: bool,
) -> CmdResult<DataDirResult> {
    let root = expand_home(path.trim());
    if !root.is_absolute() {
        return Err("Please choose an absolute folder path".into());
    }
    fs::create_dir_all(&root).map_err(err)?;
    for sub in DATA_SUBDIRS {
        fs::create_dir_all(root.join(sub)).map_err(err)?;
    }

    let gitignore = root.join(".gitignore");
    if !gitignore.exists() {
        atomic_write(&gitignore, b"*.tmp\n.DS_Store\n").map_err(err)?;
    }

    let already_git_repo = root.join(".git").exists();
    let mut git_initialized = false;
    if git_init && !already_git_repo {
        let out = Command::new("git")
            .arg("init")
            .current_dir(&root)
            .output()
            .map_err(|e| format!("Could not run git: {e}"))?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).into_owned());
        }
        git_initialized = true;
    }

    let current = state.0.lock().map_err(err)?.clone();
    let config = save_config(&app, &state, AppConfig {
        data_dir: Some(root.to_string_lossy().into_owned()),
        ..current
    })?;

    Ok(DataDirResult {
        config,
        git_initialized,
        already_git_repo,
    })
}

/// Choose (or with `None`, reset) the backup folder. It is created if missing.
#[tauri::command]
pub fn set_backup_dir(app: AppHandle, state: State<ConfigState>, path: Option<String>) -> CmdResult<AppConfig> {
    let current = state.0.lock().map_err(err)?.clone();
    let backup_dir = match path.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        None => None,
        Some(p) => {
            let dir = expand_home(p);
            if !dir.is_absolute() {
                return Err("Please choose an absolute folder path".into());
            }
            let home = std::env::var("HOME").map(PathBuf::from).unwrap_or_default();
            if dir == Path::new("/") || dir == home {
                return Err("Pick a dedicated folder, not / or your home folder".into());
            }
            if current.data_dir.as_deref().map(Path::new) == Some(dir.as_path()) {
                return Err("The backup folder must be different from the data folder".into());
            }
            fs::create_dir_all(&dir).map_err(err)?;
            Some(dir.to_string_lossy().into_owned())
        }
    };
    save_config(&app, &state, AppConfig { backup_dir, ..current })
}

/// Read a JSON file from the data folder. Returns `null` if it doesn't exist.
#[tauri::command]
pub fn read_json(state: State<ConfigState>, path: String) -> CmdResult<Option<Value>> {
    let file = resolve(&state, &path)?;
    if !file.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(&file).map_err(err)?;
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|e| format!("{path} is not valid JSON: {e}"))
}

/// Write (pretty-printed) JSON to the data folder atomically.
#[tauri::command]
pub fn write_json(state: State<ConfigState>, path: String, value: Value) -> CmdResult<()> {
    let file = resolve(&state, &path)?;
    let mut bytes = serde_json::to_vec_pretty(&value).map_err(err)?;
    bytes.push(b'\n');
    atomic_write(&file, &bytes)
}

#[tauri::command]
pub fn delete_json(state: State<ConfigState>, path: String) -> CmdResult<()> {
    let file = resolve(&state, &path)?;
    if file.exists() {
        fs::remove_file(file).map_err(err)?;
    }
    Ok(())
}

/// List the `.json` files (names only) in a folder of the data dir.
#[tauri::command]
pub fn list_json(state: State<ConfigState>, dir: String) -> CmdResult<Vec<String>> {
    let folder = resolve(&state, &dir)?;
    if !folder.is_dir() {
        return Ok(vec![]);
    }
    let mut names: Vec<String> = fs::read_dir(folder)
        .map_err(err)?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();
    names.sort();
    Ok(names)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_plain_relative_paths() {
        assert!(safe_relative("settings.json").is_ok());
        assert!(safe_relative("snippets/snippets.json").is_ok());
    }

    #[test]
    fn rejects_escaping_paths() {
        for bad in ["", "../x.json", "a/../../x.json", "/etc/passwd", "./x.json"] {
            assert!(safe_relative(bad).is_err(), "{bad} should be rejected");
        }
    }

    #[test]
    fn atomic_write_creates_parents_and_leaves_no_tmp() {
        let dir = std::env::temp_dir().join(format!("zero-test-{}", std::process::id()));
        let file = dir.join("nested/x.json");
        atomic_write(&file, b"{}").unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "{}");
        assert!(!file.with_extension("json.tmp").exists());
        fs::remove_dir_all(dir).unwrap();
    }
}

// ---------------------------------------------------------------------------
// Disk usage of the data folder
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageEntry {
    pub name: String,
    pub bytes: u64,
    pub files: u64,
    pub is_dir: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataUsage {
    pub path: String,
    pub total_bytes: u64,
    pub total_files: u64,
    /// Top-level files/folders, largest first.
    pub entries: Vec<UsageEntry>,
}

/// Size and file count of a path (symlinks are counted, not followed).
fn measure(path: &Path) -> (u64, u64) {
    let Ok(meta) = fs::symlink_metadata(path) else { return (0, 0) };
    if !meta.is_dir() {
        return (meta.len(), 1);
    }
    let mut total = (0, 0);
    if let Ok(entries) = fs::read_dir(path) {
        for e in entries.filter_map(|e| e.ok()) {
            let (b, f) = measure(&e.path());
            total.0 += b;
            total.1 += f;
        }
    }
    total
}

#[tauri::command]
pub async fn data_usage(state: State<'_, ConfigState>) -> CmdResult<DataUsage> {
    let root = data_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut entries: Vec<UsageEntry> = fs::read_dir(&root)
            .map_err(err)?
            .filter_map(|e| e.ok())
            .map(|e| {
                let (bytes, files) = measure(&e.path());
                UsageEntry {
                    name: e.file_name().to_string_lossy().into_owned(),
                    bytes,
                    files,
                    is_dir: e.file_type().map(|t| t.is_dir()).unwrap_or(false),
                }
            })
            .collect();
        entries.sort_by(|a, b| b.bytes.cmp(&a.bytes));
        Ok(DataUsage {
            path: root.to_string_lossy().into_owned(),
            total_bytes: entries.iter().map(|e| e.bytes).sum(),
            total_files: entries.iter().map(|e| e.files).sum(),
            entries,
        })
    })
    .await
    .map_err(err)?
}
