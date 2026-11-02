//! Local log viewer backend: find Laravel/Django log files in a repo and read them
//! incrementally (only the bytes appended since the last read).
//!
//! - Laravel: `storage/logs/*.log` in the repo root or a direct sub-folder with `artisan`.
//! - Django: `'filename': ...` entries in `settings*.py` / `settings/*.py`, resolved
//!   for string literals, `BASE_DIR / "x"` and `os.path.join(BASE_DIR, "x")`.
//! - Pinned: any file you add by hand, stored in `<data>/logs/pinned.json`.
//!
//! Reading is restricted to `*.log` files and pinned paths, so the frontend can't use
//! this to read arbitrary files.

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::UNIX_EPOCH;
use tauri::State;

use crate::envfile;
use crate::storage::{data_root, ConfigState};

const PINNED_FILE: &str = "logs/pinned.json";
/// First read of a file returns at most this much from the end.
const DEFAULT_TAIL: u64 = 256 * 1024;
const MAX_READ: u64 = 2 * 1024 * 1024;
const SKIP_DIRS: &[&str] = &["node_modules", "vendor", ".git", "venv", ".venv", "env", "__pycache__", "static", "media"];

type CmdResult<T> = Result<T, String>;

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LogSource {
    pub path: String,
    /// "laravel", "django" or "pinned".
    pub kind: String,
    pub exists: bool,
    pub size: u64,
    /// Seconds since epoch.
    pub modified: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoLogs {
    pub repo: String,
    pub sources: Vec<LogSource>,
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct Pinned {
    /// Repo path → pinned log paths.
    #[serde(default)]
    pub pinned: BTreeMap<String, Vec<String>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogChunk {
    pub text: String,
    /// Pass back as `offset` on the next read.
    pub offset: u64,
    pub size: u64,
    /// The file shrank since the last read (rotated or cleared); `text` starts over.
    pub rotated: bool,
    /// Older content exists before `text`.
    pub truncated: bool,
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

fn source(path: PathBuf, kind: &str) -> LogSource {
    let meta = fs::metadata(&path).ok();
    LogSource {
        path: path.to_string_lossy().into_owned(),
        kind: kind.into(),
        exists: meta.as_ref().is_some_and(|m| m.is_file()),
        size: meta.as_ref().map_or(0, |m| m.len()),
        modified: meta
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_secs()),
    }
}

/// The repo root plus its direct sub-folders (for backend/ + frontend/ monorepos).
fn project_dirs(repo: &Path) -> Vec<PathBuf> {
    let mut dirs = vec![repo.to_path_buf()];
    if let Ok(entries) = fs::read_dir(repo) {
        let mut subs: Vec<PathBuf> = entries
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
            .map(|e| e.path())
            .filter(|p| {
                let n = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                !n.starts_with('.') && !SKIP_DIRS.contains(&n)
            })
            .collect();
        subs.sort();
        dirs.extend(subs);
    }
    dirs
}

fn laravel_logs(dir: &Path) -> Vec<LogSource> {
    if !dir.join("artisan").is_file() {
        return vec![];
    }
    let Ok(entries) = fs::read_dir(dir.join("storage/logs")) else { return vec![] };
    let mut out: Vec<LogSource> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "log"))
        .map(|p| source(p, "laravel"))
        .collect();
    out.sort_by(|a, b| b.modified.cmp(&a.modified));
    out
}

fn django_settings_files(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for e in entries.filter_map(|e| e.ok()) {
        let p = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        if e.file_type().is_ok_and(|t| t.is_dir()) {
            if depth < 3 && !name.starts_with('.') && !SKIP_DIRS.contains(&name.as_str()) {
                django_settings_files(&p, depth + 1, out);
            }
        } else if name.ends_with(".py")
            && (name.starts_with("settings") || p.parent().is_some_and(|d| d.ends_with("settings")))
        {
            out.push(p);
        }
    }
}

fn filename_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"['"]filename['"]\s*:\s*([^\n]+)"#).unwrap())
}

fn string_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"['"]([^'"]+)['"]"#).unwrap())
}

fn getenv_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"^(?:os\.getenv|os\.environ\.get|env(?:\.str)?|config)\(\s*['"](\w+)['"]\s*(?:,\s*(?:default\s*=\s*)?['"]([^'"]*)['"])?"#).unwrap()
    })
}

/// Resolve the right-hand side of `'filename': <expr>` to a path, if it's simple enough.
/// `env` is the project's `.env`, used for `os.getenv("X", "default")`-style values.
pub fn resolve_filename_expr(expr: &str, base: &Path, env: &BTreeMap<String, String>) -> Option<PathBuf> {
    // Cut at the end of the value: a trailing comma/brace outside the expression.
    let expr = expr.trim().trim_end_matches(|c| c == ',' || c == '}' || c == ' ');
    if let Some(c) = getenv_re().captures(expr) {
        let value = env.get(&c[1]).cloned().filter(|v| !v.is_empty()).or_else(|| c.get(2).map(|d| d.as_str().to_string()))?;
        return Some(if value.starts_with('/') { PathBuf::from(value) } else { base.join(value) });
    }
    let parts: Vec<String> = string_re().captures_iter(expr).map(|c| c[1].to_string()).collect();
    if parts.is_empty() {
        return None;
    }
    let uses_base = expr.contains("BASE_DIR") || expr.contains("PROJECT_ROOT");
    let is_plain_literal = expr.starts_with('\'') || expr.starts_with('"');
    if !uses_base && !is_plain_literal {
        return None; // env("LOG_FILE"), f-strings with variables, etc.
    }
    let mut path = if uses_base || !parts[0].starts_with('/') { base.to_path_buf() } else { PathBuf::new() };
    for p in &parts {
        path.push(p.trim_start_matches('/'));
        if p.starts_with('/') && !uses_base {
            path = PathBuf::from(p);
        }
    }
    Some(path)
}

fn django_logs(dir: &Path) -> Vec<LogSource> {
    if !dir.join("manage.py").is_file() {
        return vec![];
    }
    let mut files = vec![];
    django_settings_files(dir, 0, &mut files);
    let env = envfile::read(&dir.join(".env")).unwrap_or_default();
    files.sort();
    let mut out: Vec<LogSource> = vec![];
    for f in files {
        let Ok(text) = fs::read_to_string(&f) else { continue };
        for cap in filename_re().captures_iter(&text) {
            if let Some(p) = resolve_filename_expr(&cap[1], dir, &env) {
                let s = source(p, "django");
                if !out.iter().any(|o| o.path == s.path) {
                    out.push(s);
                }
            }
        }
    }
    out
}

fn read_pinned(data: Option<&Path>) -> Pinned {
    data.and_then(|d| fs::read_to_string(d.join(PINNED_FILE)).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

pub fn sources_for(repo: &Path, pinned: &[String]) -> Vec<LogSource> {
    let mut out = vec![];
    for dir in project_dirs(repo) {
        out.extend(laravel_logs(&dir));
        out.extend(django_logs(&dir));
    }
    for p in pinned {
        if !out.iter().any(|o| &o.path == p) {
            out.push(source(PathBuf::from(p), "pinned"));
        }
    }
    out
}

/// Only `*.log` files and pinned paths may be read or cleared.
fn allowed(path: &Path, data: Option<&Path>) -> CmdResult<()> {
    let meta = fs::symlink_metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if !meta.is_file() {
        return Err(format!("{} is not a regular file", path.display()));
    }
    if path.extension().is_some_and(|x| x == "log") {
        return Ok(());
    }
    let pinned = read_pinned(data);
    let p = path.to_string_lossy();
    if pinned.pinned.values().flatten().any(|x| *x == p) {
        Ok(())
    } else {
        Err("Only .log files or pinned log files can be opened".into())
    }
}

pub fn read_chunk(path: &Path, offset: Option<u64>, max: u64) -> CmdResult<LogChunk> {
    let mut f = File::open(path).map_err(|e| e.to_string())?;
    let size = f.metadata().map_err(|e| e.to_string())?.len();
    let max = max.clamp(1024, MAX_READ);
    // Continue from `offset` when it's still valid; otherwise tail the last `max` bytes.
    let continuing = offset.filter(|o| *o <= size);
    let start = match continuing {
        Some(o) => o.max(size.saturating_sub(max)),
        None => size.saturating_sub(max),
    };
    // Bytes were skipped: either a fresh tail of a big file, or more was appended than `max`.
    let truncated = start > continuing.unwrap_or(0);
    // The caller must start over when the file shrank or we couldn't continue seamlessly.
    let rotated = offset.is_some() && (continuing.is_none() || truncated);
    f.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    let mut buf = Vec::with_capacity((size - start) as usize);
    f.take(size - start).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    let mut text = String::from_utf8_lossy(&buf).into_owned();
    // Starting mid-file: drop the partial first line.
    if truncated {
        if let Some(i) = text.find('\n') {
            text.drain(..=i);
        }
    }
    Ok(LogChunk { text, offset: size, size, rotated, truncated })
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn log_sources(state: State<'_, ConfigState>, repos: Vec<String>) -> CmdResult<Vec<RepoLogs>> {
    let pinned = read_pinned(data_root(&state).ok().as_deref());
    tauri::async_runtime::spawn_blocking(move || {
        repos
            .into_iter()
            .map(|r| {
                let pins = pinned.pinned.get(&r).cloned().unwrap_or_default();
                RepoLogs { sources: sources_for(Path::new(&r), &pins), repo: r }
            })
            .filter(|r| !r.sources.is_empty())
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn read_log(state: State<'_, ConfigState>, path: String, offset: Option<u64>) -> CmdResult<LogChunk> {
    let data = data_root(&state).ok();
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        allowed(&p, data.as_deref())?;
        read_chunk(&p, offset, if offset.is_some() { MAX_READ } else { DEFAULT_TAIL })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn clear_log(state: State<ConfigState>, path: String) -> CmdResult<()> {
    let p = PathBuf::from(&path);
    allowed(&p, data_root(&state).ok().as_deref())?;
    OpenOptions::new().write(true).truncate(true).open(&p).map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("zero-logs-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn resolves_django_filename_expressions() {
        let base = Path::new("/srv/app");
        let env: BTreeMap<String, String> = [("LOG_FILE".to_string(), "logs/from-env.log".to_string())].into();
        let r = |e: &str| resolve_filename_expr(e, base, &env).map(|p| p.to_string_lossy().into_owned());
        assert_eq!(r(r#"BASE_DIR / "logs" / "debug.log","#).as_deref(), Some("/srv/app/logs/debug.log"));
        assert_eq!(r(r#"os.path.join(BASE_DIR, 'logs', 'app.log'),"#).as_deref(), Some("/srv/app/logs/app.log"));
        assert_eq!(r(r#"'/var/log/app/django.log',"#).as_deref(), Some("/var/log/app/django.log"));
        assert_eq!(r(r#""debug.log"}"#).as_deref(), Some("/srv/app/debug.log"));
        assert_eq!(r(r#"env("LOG_FILE"),"#).as_deref(), Some("/srv/app/logs/from-env.log"));
        assert_eq!(r(r#"os.getenv("DJANGO_LOG_FILE", "exurl.log"),"#).as_deref(), Some("/srv/app/exurl.log"));
        assert_eq!(r(r#"os.environ.get('NOPE'),"#), None);
        assert_eq!(r("LOG_PATH,"), None);
    }

    #[test]
    fn detects_laravel_and_django() {
        let d = tmp("detect");
        fs::write(d.join("artisan"), "").unwrap();
        fs::create_dir_all(d.join("storage/logs")).unwrap();
        fs::write(d.join("storage/logs/laravel.log"), "x").unwrap();
        fs::write(d.join("storage/logs/.gitignore"), "*").unwrap();
        let api = d.join("api");
        fs::create_dir_all(api.join("core")).unwrap();
        fs::write(api.join("manage.py"), "").unwrap();
        fs::write(api.join("core/settings.py"),
            "LOGGING = {'handlers': {'file': {'class': 'logging.FileHandler', 'filename': BASE_DIR / 'debug.log',}}}").unwrap();
        let s = sources_for(&d, &["/tmp/pinned.txt".into()]);
        let kinds: Vec<&str> = s.iter().map(|x| x.kind.as_str()).collect();
        assert_eq!(kinds, ["laravel", "django", "pinned"]);
        assert!(s[0].exists);
        assert!(s[1].path.ends_with("api/debug.log"));
        assert!(!s[1].exists);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn reads_incrementally_and_detects_rotation() {
        let d = tmp("read");
        let f = d.join("app.log");
        fs::write(&f, "one\ntwo\n").unwrap();
        let c = read_chunk(&f, None, DEFAULT_TAIL).unwrap();
        assert_eq!(c.text, "one\ntwo\n");
        assert!(!c.truncated);
        OpenOptions::new().append(true).open(&f).unwrap().write_all(b"three\n").unwrap();
        let c2 = read_chunk(&f, Some(c.offset), MAX_READ).unwrap();
        assert_eq!(c2.text, "three\n");
        fs::write(&f, "new\n").unwrap();
        let c3 = read_chunk(&f, Some(c2.offset), MAX_READ).unwrap();
        assert!(c3.rotated);
        assert_eq!(c3.text, "new\n");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn tail_drops_partial_first_line() {
        let d = tmp("tail");
        let f = d.join("big.log");
        let line = "x".repeat(99) + "\n";
        fs::write(&f, line.repeat(30)).unwrap();
        let c = read_chunk(&f, None, 1024).unwrap();
        assert!(c.truncated);
        assert!(c.text.lines().all(|l| l.len() == 99));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn only_log_or_pinned_files_are_allowed() {
        let d = tmp("allow");
        fs::write(d.join("a.log"), "").unwrap();
        fs::write(d.join("secret.txt"), "").unwrap();
        assert!(allowed(&d.join("a.log"), None).is_ok());
        assert!(allowed(&d.join("secret.txt"), None).is_err());
        let data = d.join("data");
        fs::create_dir_all(data.join("logs")).unwrap();
        let pinned = format!(r#"{{"pinned":{{"/r":["{}"]}}}}"#, d.join("secret.txt").display());
        fs::write(data.join(PINNED_FILE), pinned).unwrap();
        assert!(allowed(&d.join("secret.txt"), Some(&data)).is_ok());
        let _ = fs::remove_dir_all(&d);
    }
}
