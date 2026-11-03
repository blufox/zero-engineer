//! Pending migrations for Laravel (`php artisan migrate:status`) and Django
//! (`manage.py showmigrations --plan`). Read-only: nothing is ever migrated.

use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::bootstrap::find_bin;
use crate::logs::project_dirs;

const TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct MigrationStatus {
    pub path: String,
    /// "Laravel" or "Django"; None when the repo has neither.
    pub framework: Option<String>,
    pub pending: Vec<String>,
    pub error: Option<String>,
}

/// Laravel 9+ (`name .... Pending`) and the older table (`| No | name | |`).
pub fn parse_laravel(out: &str) -> Vec<String> {
    let mut pending = vec![];
    for line in out.lines() {
        let l = line.trim();
        if l.starts_with('|') {
            let cols: Vec<&str> = l.trim_matches('|').split('|').map(str::trim).collect();
            if cols.len() >= 2 && cols[0].eq_ignore_ascii_case("no") {
                pending.push(cols[1].to_string());
            }
        } else if l.ends_with("Pending") {
            if let Some(name) = l.split_whitespace().next() {
                pending.push(name.to_string());
            }
        }
    }
    pending
}

/// `[ ]  app.0002_name` lines from `showmigrations --plan`.
pub fn parse_django(out: &str) -> Vec<String> {
    out.lines()
        .filter_map(|l| l.trim().strip_prefix("[ ]"))
        .map(|rest| rest.split_whitespace().next().unwrap_or("").to_string())
        .filter(|n| !n.is_empty())
        .collect()
}

fn python_for(project: &Path, repo: &Path) -> Option<PathBuf> {
    for base in [project, repo] {
        for venv in [".venv", "venv", "env"] {
            let p = base.join(venv).join("bin/python");
            if p.is_file() {
                return Some(p);
            }
        }
    }
    find_bin("python3")
}

/// Run with a timeout; stdout on success, a short error otherwise.
fn run_in(dir: &Path, exe: &Path, args: &[&str]) -> Result<String, String> {
    let mut child = Command::new(exe)
        .args(args)
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("COMPOSER_NO_INTERACTION", "1")
        // Symfony console wraps errors to the terminal width; keep messages on one line.
        .env("COLUMNS", "400")
        .spawn()
        .map_err(|e| format!("could not run {}: {e}", exe.display()))?;
    let (mut so, mut se) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
    let out_t = std::thread::spawn(move || { let mut s = String::new(); let _ = so.read_to_string(&mut s); s });
    let err_t = std::thread::spawn(move || { let mut s = String::new(); let _ = se.read_to_string(&mut s); s });
    let start = Instant::now();
    let status = loop {
        if let Some(st) = child.try_wait().map_err(|e| e.to_string())? {
            break st;
        }
        if start.elapsed() > TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            return Err("timed out after 20s (is the database running?)".into());
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let (out, err) = (out_t.join().unwrap_or_default(), err_t.join().unwrap_or_default());
    if status.success() {
        Ok(out)
    } else {
        let msg = if err.trim().is_empty() { out } else { err };
        Err(error_line(&msg).chars().take(300).collect())
    }
}

/// The useful line of a failure: a Python traceback's last line, or the message
/// under Laravel's "In File.php line N:" header.
pub fn error_line(msg: &str) -> String {
    let lines: Vec<&str> = msg.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    let Some(first) = lines.first() else { return "command failed".into() };
    if first.starts_with("Traceback") {
        return lines.last().unwrap_or(first).to_string();
    }
    if first.starts_with("In ") && first.ends_with(':') {
        // Symfony wraps the message over several lines; it ends at the next blank line.
        let block: Vec<&str> = msg.lines().map(str::trim).skip_while(|l| !l.starts_with("In ")).skip(1)
            .skip_while(|l| l.is_empty()).take_while(|l| !l.is_empty()).collect();
        if !block.is_empty() {
            return block.join(" ");
        }
    }
    first.to_string()
}

fn status_for(repo: &Path) -> MigrationStatus {
    let mut s = MigrationStatus { path: repo.to_string_lossy().into_owned(), ..Default::default() };
    for dir in project_dirs(repo) {
        if dir.join("artisan").is_file() {
            s.framework = Some("Laravel".into());
            let Some(php) = find_bin("php") else { s.error = Some("php is not installed".into()); return s };
            match run_in(&dir, &php, &["artisan", "migrate:status", "--no-ansi", "--no-interaction"]) {
                Ok(out) => s.pending = parse_laravel(&out),
                Err(e) => s.error = Some(e),
            }
            return s;
        }
        if dir.join("manage.py").is_file() {
            s.framework = Some("Django".into());
            let Some(py) = python_for(&dir, repo) else { s.error = Some("python3 is not installed".into()); return s };
            match run_in(&dir, &py, &["manage.py", "showmigrations", "--plan", "--no-color"]) {
                Ok(out) => s.pending = parse_django(&out),
                Err(e) => s.error = Some(e),
            }
            return s;
        }
    }
    s
}

#[tauri::command]
pub async fn migration_status(paths: Vec<String>) -> Result<Vec<MigrationStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // A few at a time: each one boots a framework.
        let queue = std::sync::Mutex::new(paths.into_iter().enumerate().collect::<Vec<_>>());
        let results = std::sync::Mutex::new(vec![]);
        std::thread::scope(|sc| {
            for _ in 0..4 {
                sc.spawn(|| loop {
                    let Some((i, p)) = queue.lock().unwrap().pop() else { break };
                    let st = status_for(Path::new(&p));
                    results.lock().unwrap().push((i, st));
                });
            }
        });
        let mut r = results.into_inner().unwrap();
        r.sort_by_key(|(i, _)| *i);
        Ok(r.into_iter().map(|(_, s)| s).filter(|s| s.framework.is_some()).collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn laravel_new_format() {
        let out = "\n  Migration name ............................ Batch / Status  \n  \
            2014_10_12_000000_create_users_table ............. [1] Ran  \n  \
            2024_05_01_120000_add_flags ...................... Pending  \n";
        assert_eq!(parse_laravel(out), ["2024_05_01_120000_add_flags"]);
    }

    #[test]
    fn laravel_table_format() {
        let out = "+------+------------------+-------+\n| Ran? | Migration        | Batch |\n+------+------------------+-------+\n\
            | Yes  | 2014_create_users | 1     |\n| No   | 2020_add_x        |       |\n";
        assert_eq!(parse_laravel(out), ["2020_add_x"]);
    }

    #[test]
    fn error_lines() {
        assert_eq!(error_line("Traceback (most recent call last):\n  File x\nModuleNotFoundError: No module named 'environ'\n"), "ModuleNotFoundError: No module named 'environ'");
        assert_eq!(error_line("\n  In Connection.php line 841:\n\n    SQLSTATE[HY000] [2002]\n    Connection refused\n\n  more\n"), "SQLSTATE[HY000] [2002] Connection refused");
    }

    #[test]
    fn django_plan() {
        let out = "[X]  contenttypes.0001_initial\n[X]  auth.0001_initial\n[ ]  shop.0004_order_note\n[ ]  shop.0005_x (2 squashed migrations)\n";
        assert_eq!(parse_django(out), ["shop.0004_order_note", "shop.0005_x"]);
    }
}

#[cfg(test)]
mod live {
    /// cargo test migrations_live -- --ignored --nocapture
    #[test]
    #[ignore]
    fn migrations_live() {
        let root = crate::paths::expand_home("~/Documents/www");
        let repos: Vec<String> = std::fs::read_dir(&root).unwrap().filter_map(|e| e.ok()).flat_map(|g| {
            std::fs::read_dir(g.path()).map(|e| e.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.join(".git").exists())
                .map(|p| p.to_string_lossy().into_owned()).collect::<Vec<_>>()).unwrap_or_default()
        }).collect();
        let r = tauri::async_runtime::block_on(super::migration_status(repos)).unwrap();
        for s in r {
            println!("{:8} {} pending={:?} err={:?}", s.framework.unwrap_or_default(), s.path, s.pending, s.error);
        }
    }
}
