//! "Where was I?" context for a repo, and the `.env` drift checker.
//!
//! Everything here is computed on demand when the repo panel opens; nothing runs in
//! the background. `.env` values are never returned, only key names.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use crate::envfile;
use crate::repos::git;

const EXAMPLE_FILES: &[&str] = &[".env.example", ".env.sample", ".env.dist", ".env.template"];
const MAX_TODOS: usize = 30;
const MAX_FILES: usize = 40;
const TODO_MARKERS: &[&str] = &["TODO", "FIXME", "XXX", "HACK"];

// ---------------------------------------------------------------------------
// .env drift
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EnvDrift {
    pub path: String,
    /// `.env.example` (or similar) that was compared against; None = nothing to compare.
    pub example_file: Option<String>,
    pub has_env: bool,
    /// In the example but not in `.env`.
    pub missing: Vec<String>,
    /// In `.env` but not in the example.
    pub extra: Vec<String>,
    /// Present in `.env` but blank, while the example has it.
    pub empty: Vec<String>,
}

pub fn env_drift_for(dir: &Path) -> EnvDrift {
    let mut out = EnvDrift { path: dir.to_string_lossy().into_owned(), ..Default::default() };
    let env = envfile::read(&dir.join(".env"));
    out.has_env = env.is_some();
    let Some((name, example)) = EXAMPLE_FILES
        .iter()
        .find_map(|f| envfile::read(&dir.join(f)).map(|m| (f.to_string(), m)))
    else {
        return out;
    };
    out.example_file = Some(name);
    let env = env.unwrap_or_default();
    for key in example.keys() {
        match env.get(key) {
            None => out.missing.push(key.clone()),
            Some(v) if v.is_empty() => out.empty.push(key.clone()),
            _ => {}
        }
    }
    out.extra = env.keys().filter(|k| !example.contains_key(*k)).cloned().collect();
    out
}

#[tauri::command]
pub async fn env_drift_all(paths: Vec<String>) -> Result<Vec<EnvDrift>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        Ok(paths.iter().map(|p| env_drift_for(Path::new(p))).collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Repo context
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommitLine {
    pub hash: String,
    pub subject: String,
    pub date: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    /// Short status, e.g. "M", "A", "D", "??", "UU".
    pub status: String,
    /// Seconds since epoch of the file's mtime (0 if deleted).
    pub modified: u64,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TodoLine {
    pub file: String,
    pub line: u32,
    pub text: String,
    /// "uncommitted" or "committed".
    pub source: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoContext {
    pub path: String,
    pub branch: Option<String>,
    pub commits: Vec<CommitLine>,
    pub files: Vec<ChangedFile>,
    pub stashes: Vec<String>,
    pub todos: Vec<TodoLine>,
    pub env: EnvDrift,
}

/// Paths from `git status --porcelain=v2` with a short status code.
fn parse_changed(text: &str) -> Vec<(String, String)> {
    let unquote = |p: &str| p.trim_matches('"').to_string();
    text.lines()
        .filter_map(|line| {
            if let Some(p) = line.strip_prefix("? ") {
                return Some(("??".into(), unquote(p)));
            }
            let (n, code) = match line.as_bytes().first()? {
                b'1' => (9, None),
                b'2' => (10, None),
                b'u' => (11, Some("UU")),
                _ => return None,
            };
            let parts: Vec<&str> = line.splitn(n, ' ').collect();
            let path = parts.get(n - 1)?.split('\t').next()?;
            let xy = parts.get(1).copied().unwrap_or("..");
            let status = code.map(String::from).unwrap_or_else(|| {
                let c: String = xy.chars().filter(|c| *c != '.').collect();
                c.chars().next().map(String::from).unwrap_or_else(|| "M".into())
            });
            Some((status, unquote(path)))
        })
        .collect()
}

/// TODO/FIXME lines added in a `-U0` unified diff (works for `git diff` and `git log -p`).
pub fn todos_from_diff(diff: &str, source: &str) -> Vec<TodoLine> {
    let mut out = vec![];
    let mut file: Option<String> = None;
    let mut line_no: u32 = 0;
    for l in diff.lines() {
        if let Some(f) = l.strip_prefix("+++ ") {
            file = f.strip_prefix("b/").map(String::from);
        } else if let Some(h) = l.strip_prefix("@@ ") {
            // @@ -a,b +c,d @@
            line_no = h
                .split_whitespace()
                .find_map(|t| t.strip_prefix('+'))
                .and_then(|t| t.split(',').next())
                .and_then(|n| n.parse().ok())
                .unwrap_or(0);
        } else if let Some(added) = l.strip_prefix('+') {
            if let Some(f) = &file {
                if TODO_MARKERS.iter().any(|m| added.contains(m)) {
                    out.push(TodoLine {
                        file: f.clone(),
                        line: line_no,
                        text: added.trim().chars().take(200).collect(),
                        source: source.into(),
                    });
                }
            }
            line_no += 1;
        }
    }
    out
}

fn mtime(p: &Path) -> u64 {
    fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn repo_context_for(dir: &Path) -> Result<RepoContext, String> {
    if !dir.join(".git").exists() {
        return Err("Not a git repository".into());
    }
    let branch = git(dir, &["rev-parse", "--abbrev-ref", "HEAD"]).ok().map(|b| b.trim().to_string());

    let commits = git(dir, &["log", "-5", "--format=%h%x1f%s%x1f%cI"])
        .unwrap_or_default()
        .lines()
        .filter_map(|l| {
            let p: Vec<&str> = l.split('\x1f').collect();
            (p.len() == 3).then(|| CommitLine { hash: p[0].into(), subject: p[1].into(), date: p[2].into() })
        })
        .collect();

    let status = git(dir, &["status", "--porcelain=v2", "--untracked-files=normal"]).unwrap_or_default();
    let mut files: Vec<ChangedFile> = parse_changed(&status)
        .into_iter()
        .map(|(status, path)| ChangedFile { modified: mtime(&dir.join(&path)), status, path })
        .collect();
    files.sort_by(|a, b| b.modified.cmp(&a.modified));
    files.truncate(MAX_FILES);

    let stashes = git(dir, &["stash", "list", "--format=%gd: %s"])
        .unwrap_or_default()
        .lines()
        .map(String::from)
        .collect();

    let mut todos = todos_from_diff(&git(dir, &["diff", "HEAD", "-U0", "--no-color"]).unwrap_or_default(), "uncommitted");
    if let Ok(email) = git(dir, &["config", "user.email"]) {
        let author = format!("--author={}", email.trim());
        let log = git(dir, &["log", "-p", "-U0", "--no-color", "--since=14.days", &author, "--format="])
            .unwrap_or_default();
        for t in todos_from_diff(&log, "committed") {
            if !todos.iter().any(|x| x.file == t.file && x.text == t.text) {
                todos.push(t);
            }
        }
    }
    // Drop TODOs that no longer exist in the file (fixed since they were committed).
    todos.retain(|t| {
        fs::read_to_string(dir.join(&t.file)).map(|c| c.contains(&t.text)).unwrap_or(false)
    });
    todos.truncate(MAX_TODOS);

    Ok(RepoContext {
        path: dir.to_string_lossy().into_owned(),
        branch,
        commits,
        files,
        stashes,
        todos,
        env: env_drift_for(dir),
    })
}

#[tauri::command]
pub async fn repo_context(path: String) -> Result<RepoContext, String> {
    tauri::async_runtime::spawn_blocking(move || repo_context_for(&PathBuf::from(path)))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("zero-ctx-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn drift_reports_missing_extra_empty() {
        let d = tmp("drift");
        fs::write(d.join(".env.example"), "APP_KEY=\nDB_HOST=127.0.0.1\nMAIL_HOST=\n").unwrap();
        fs::write(d.join(".env"), "APP_KEY=\nDB_HOST=localhost\nLOCAL_ONLY=1\n").unwrap();
        let r = env_drift_for(&d);
        assert_eq!(r.example_file.as_deref(), Some(".env.example"));
        assert!(r.has_env);
        assert_eq!(r.missing, vec!["MAIL_HOST"]);
        assert_eq!(r.extra, vec!["LOCAL_ONLY"]);
        assert_eq!(r.empty, vec!["APP_KEY"]);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn drift_without_example() {
        let d = tmp("noex");
        let r = env_drift_for(&d);
        assert!(r.example_file.is_none());
        assert!(!r.has_env);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn todo_extraction() {
        let diff = "\
diff --git a/app/User.php b/app/User.php
--- a/app/User.php
+++ b/app/User.php
@@ -10,0 +11,2 @@
+    // TODO: validate email
+    $x = 1;
@@ -40 +42 @@
-old
+    # FIXME later
+++ /dev/null
";
        let t = todos_from_diff(diff, "uncommitted");
        assert_eq!(t.len(), 2);
        assert_eq!(t[0], TodoLine { file: "app/User.php".into(), line: 11, text: "// TODO: validate email".into(), source: "uncommitted".into() });
        assert_eq!(t[1].line, 42);
    }

    /// `cargo test -- --ignored --nocapture live_context` prints the context of this repo.
    #[test]
    #[ignore]
    fn live_context() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let ctx = repo_context_for(dir).unwrap();
        println!("{}", serde_json::to_string_pretty(&ctx).unwrap());
        assert!(!ctx.commits.is_empty());
    }

    #[test]
    fn changed_files() {
        let s = "1 .M N... 100644 100644 100644 abc abc app/a.php\n\
                 2 R. N... 100644 100644 100644 abc abc R100 new.php\told.php\n\
                 ? notes.txt\n\
                 u UU N... 100644 100644 100644 100644 a b c conflict.py\n";
        let f = parse_changed(s);
        assert_eq!(f, vec![
            ("M".to_string(), "app/a.php".to_string()),
            ("R".to_string(), "new.php".to_string()),
            ("??".to_string(), "notes.txt".to_string()),
            ("UU".to_string(), "conflict.py".to_string()),
        ]);
    }
}
