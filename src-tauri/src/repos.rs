//! Repository scanner: finds git repos under the configured roots and collects
//! status via the git CLI (so it honours the user's own git config, SSH keys and
//! credential helpers).

use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::paths::expand_home;

/// How deep below a scan root we look for repos (www/Category/project = 2).
const MAX_DEPTH: usize = 5;
/// Folders never worth descending into.
const ALWAYS_SKIP: &[&str] = &[
    "node_modules", "vendor", "target", "build", "dist", ".dart_tool", "venv", ".venv",
    "__pycache__", "storage", "Pods",
];

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LastCommit {
    pub hash: String,
    pub subject: String,
    pub author: String,
    pub date: String,
}

#[derive(Debug, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    pub name: String,
    pub path: String,
    /// First folder under the scan root, e.g. "FS" for ~/Documents/www/FS/zero.
    pub group: String,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub staged: u32,
    pub modified: u32,
    pub untracked: u32,
    pub conflicted: u32,
    pub stashes: u32,
    pub last_commit: Option<LastCommit>,
    pub remote_url: Option<String>,
    /// Browser URL for the remote (GitHub/GitLab/Bitbucket), if derivable.
    pub web_url: Option<String>,
    pub stacks: Vec<String>,
    pub error: Option<String>,
}

pub(crate) fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        // Never hang waiting for a password/passphrase prompt.
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes -o ConnectTimeout=10")
        .output()
        .map_err(|e| format!("could not run git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

struct Exclusions {
    names: HashSet<String>,
    paths: Vec<PathBuf>,
}

impl Exclusions {
    fn new(excluded: &[String]) -> Self {
        let mut names: HashSet<String> = ALWAYS_SKIP.iter().map(|s| s.to_string()).collect();
        let mut paths = vec![];
        for e in excluded.iter().map(|e| e.trim()).filter(|e| !e.is_empty()) {
            if e.contains('/') {
                paths.push(expand_home(e.trim_end_matches('/')));
            } else {
                names.insert(e.to_string());
            }
        }
        Self { names, paths }
    }

    fn skip(&self, path: &Path) -> bool {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        name.starts_with('.') || self.names.contains(name) || self.paths.iter().any(|p| path.starts_with(p))
    }
}

fn find_repos(dir: &Path, depth: usize, ex: &Exclusions, out: &mut Vec<PathBuf>) {
    if dir.join(".git").exists() {
        out.push(dir.to_path_buf());
        return; // don't descend into repos (nested/sub-modules are noise here)
    }
    if depth >= MAX_DEPTH {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut children: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false)) // not following symlinks
        .map(|e| e.path())
        .filter(|p| !ex.skip(p))
        .collect();
    children.sort();
    for child in children {
        find_repos(&child, depth + 1, ex, out);
    }
}

// ---------------------------------------------------------------------------
// Per-repo info
// ---------------------------------------------------------------------------

/// Parse `git status --porcelain=v2 --branch --show-stash`.
fn parse_status(info: &mut RepoInfo, text: &str) {
    for line in text.lines() {
        if let Some(head) = line.strip_prefix("# branch.head ") {
            info.branch = (head != "(detached)").then(|| head.to_string());
        } else if let Some(up) = line.strip_prefix("# branch.upstream ") {
            info.upstream = Some(up.to_string());
        } else if let Some(ab) = line.strip_prefix("# branch.ab ") {
            let mut it = ab.split_whitespace();
            info.ahead = it.next().and_then(|a| a.trim_start_matches('+').parse().ok()).unwrap_or(0);
            info.behind = it.next().and_then(|b| b.trim_start_matches('-').parse().ok()).unwrap_or(0);
        } else if let Some(n) = line.strip_prefix("# stash ") {
            info.stashes = n.trim().parse().unwrap_or(0);
        } else if line.starts_with("? ") {
            info.untracked += 1;
        } else if line.starts_with("u ") {
            info.conflicted += 1;
        } else if line.starts_with("1 ") || line.starts_with("2 ") {
            // "1 XY ..." — X = staged state, Y = worktree state ('.' = unchanged)
            let xy = line.as_bytes();
            if xy.len() > 3 {
                if xy[2] != b'.' { info.staged += 1; }
                if xy[3] != b'.' { info.modified += 1; }
            }
        }
    }
}

/// git@github.com:user/repo.git | https://github.com/user/repo.git → https://github.com/user/repo
pub fn web_url(remote: &str) -> Option<String> {
    let r = remote.trim().trim_end_matches(".git");
    if let Some(rest) = r.strip_prefix("git@") {
        let (host, path) = rest.split_once(':')?;
        return Some(format!("https://{host}/{path}"));
    }
    if let Some(rest) = r.strip_prefix("ssh://") {
        let rest = rest.split_once('@').map(|(_, r)| r).unwrap_or(rest);
        let (host, path) = rest.split_once('/')?;
        let host = host.split(':').next()?;
        return Some(format!("https://{host}/{path}"));
    }
    if r.starts_with("https://") || r.starts_with("http://") {
        // Strip embedded credentials: https://user:token@host/...
        if let Some((scheme, rest)) = r.split_once("://") {
            let rest = rest.split_once('@').map(|(_, r)| r).unwrap_or(rest);
            return Some(format!("{scheme}://{rest}"));
        }
    }
    None
}

fn detect_stacks_in(dir: &Path) -> Vec<String> {
    let has = |f: &str| dir.join(f).exists();
    let read = |f: &str| fs::read_to_string(dir.join(f)).unwrap_or_default();
    let mut s = vec![];
    if has("artisan") && has("composer.json") {
        s.push("Laravel");
    } else if has("composer.json") {
        s.push("PHP");
    }
    if has("manage.py") {
        s.push("Django");
    } else if has("pyproject.toml") || has("requirements.txt") {
        s.push("Python");
    }
    if has("pubspec.yaml") {
        s.push(if read("pubspec.yaml").contains("flutter:") { "Flutter" } else { "Dart" });
    }
    if has("package.json") {
        let pkg = read("package.json");
        let js = [
            ("\"next\"", "Next.js"), ("\"nuxt\"", "Nuxt"), ("\"@sveltejs/kit\"", "SvelteKit"),
            ("\"@tauri-apps/api\"", "Tauri"), ("\"react\"", "React"), ("\"vue\"", "Vue"),
            ("\"svelte\"", "Svelte"), ("\"express\"", "Express"),
        ];
        // Laravel projects always have a package.json for Vite; only label the framework.
        match js.iter().find(|(k, _)| pkg.contains(k)) {
            Some((_, name)) => s.push(name),
            None if s.is_empty() => s.push("Node"),
            None => {}
        }
    }
    if has("Gemfile") {
        s.push(if read("Gemfile").contains("rails") { "Rails" } else { "Ruby" });
    }
    if has("Cargo.toml") && !s.contains(&"Tauri") { s.push("Rust"); }
    if has("go.mod") { s.push("Go"); }
    if has("docker-compose.yml") || has("compose.yaml") || has("Dockerfile") { s.push("Docker"); }
    s.into_iter().map(String::from).collect()
}

/// Stacks at the repo root plus one level down, so monorepos
/// (backend/ + web/ + mobile/) show everything they contain.
fn detect_stacks(dir: &Path) -> Vec<String> {
    let mut stacks = detect_stacks_in(dir);
    if let Ok(entries) = fs::read_dir(dir) {
        let mut subdirs: Vec<PathBuf> = entries
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .map(|e| e.path())
            .filter(|p| {
                let n = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                !n.starts_with('.') && !ALWAYS_SKIP.contains(&n)
            })
            .collect();
        subdirs.sort();
        for sub in subdirs {
            for st in detect_stacks_in(&sub) {
                if !stacks.contains(&st) { stacks.push(st); }
            }
        }
    }
    // Docker is supporting infrastructure; list it last.
    stacks.sort_by_key(|s| s == "Docker");
    stacks
}

fn group_for(path: &Path, roots: &[PathBuf]) -> String {
    roots
        .iter()
        .find_map(|r| path.strip_prefix(r).ok())
        .and_then(|rel| {
            let mut comps = rel.components();
            let first = comps.next()?;
            // Repo directly under the root → no group.
            comps.next()?;
            Some(first.as_os_str().to_string_lossy().into_owned())
        })
        .unwrap_or_default()
}

pub fn repo_info(dir: &Path, roots: &[PathBuf]) -> RepoInfo {
    let mut info = RepoInfo {
        name: dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        path: dir.to_string_lossy().into_owned(),
        group: group_for(dir, roots),
        stacks: detect_stacks(dir),
        ..Default::default()
    };

    match git(dir, &["status", "--porcelain=v2", "--branch", "--show-stash"]) {
        Ok(text) => parse_status(&mut info, &text),
        Err(e) => {
            info.error = Some(e);
            return info;
        }
    }

    // Empty repos have no HEAD yet; that's not an error worth showing.
    if let Ok(log) = git(dir, &["log", "-1", "--format=%h%x1f%s%x1f%an%x1f%cI"]) {
        let p: Vec<&str> = log.trim().split('\x1f').collect();
        if p.len() == 4 {
            info.last_commit = Some(LastCommit {
                hash: p[0].into(), subject: p[1].into(), author: p[2].into(), date: p[3].into(),
            });
        }
    }

    let remote = git(dir, &["remote"]).ok().and_then(|r| {
        let names: Vec<&str> = r.lines().collect();
        names.iter().find(|n| **n == "origin").or(names.first()).map(|n| n.to_string())
    });
    if let Some(name) = remote {
        if let Ok(url) = git(dir, &["remote", "get-url", &name]) {
            info.web_url = web_url(&url);
            info.remote_url = Some(url.trim().to_string());
        }
    }
    info
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn scan_repos(roots: Vec<String>, excluded: Vec<String>) -> Result<Vec<RepoInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let roots: Vec<PathBuf> = roots.iter().map(|r| expand_home(r.trim())).filter(|r| r.is_dir()).collect();
        let ex = Exclusions::new(&excluded);
        let mut dirs = vec![];
        for root in &roots {
            find_repos(root, 0, &ex, &mut dirs);
        }
        dirs.sort();
        dirs.dedup();

        // git status is I/O bound: run repos in parallel, a few threads at a time.
        let mut results = Vec::with_capacity(dirs.len());
        for chunk in dirs.chunks(8) {
            std::thread::scope(|s| {
                let handles: Vec<_> = chunk.iter().map(|d| s.spawn(|| repo_info(d, &roots))).collect();
                results.extend(handles.into_iter().filter_map(|h| h.join().ok()));
            });
        }
        Ok(results)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// `git fetch --all --prune`, then return fresh info for the repo.
#[tauri::command]
pub async fn fetch_repo(path: String, roots: Vec<String>) -> Result<RepoInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = PathBuf::from(&path);
        if !dir.join(".git").exists() {
            return Err("Not a git repository".into());
        }
        git(&dir, &["fetch", "--all", "--prune", "--quiet"])?;
        let roots: Vec<PathBuf> = roots.iter().map(|r| expand_home(r)).collect();
        Ok(repo_info(&dir, &roots))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Scan the real workspace: `cargo test scan_real -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn scan_real_workspace() {
        let roots = vec![expand_home("~/Documents/www")];
        let mut dirs = vec![];
        find_repos(&roots[0], 0, &Exclusions::new(&[]), &mut dirs);
        for d in &dirs {
            let i = repo_info(d, &roots);
            println!("{:>12} {:<36} {:<14} +{}-{} S{} M{} U{} {:?} {:?}", i.group, i.name,
                i.branch.unwrap_or_default(), i.ahead, i.behind, i.staged, i.modified, i.untracked,
                i.stacks, i.error);
        }
    }

    #[test]
    fn web_urls() {
        assert_eq!(web_url("git@github.com:me/zero.git").unwrap(), "https://github.com/me/zero");
        assert_eq!(web_url("https://github.com/me/zero.git").unwrap(), "https://github.com/me/zero");
        assert_eq!(web_url("https://me:tok@gitlab.com/g/r.git").unwrap(), "https://gitlab.com/g/r");
        assert_eq!(web_url("ssh://git@bitbucket.org:22/t/r.git").unwrap(), "https://bitbucket.org/t/r");
        assert!(web_url("/local/path").is_none());
    }

    #[test]
    fn parses_porcelain_v2() {
        let mut i = RepoInfo::default();
        parse_status(&mut i, "# branch.oid abc\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -1\n# stash 3\n1 M. N... 100644 100644 100644 a b f1\n1 .M N... 100644 100644 100644 a b f2\n1 MM N... 100644 100644 100644 a b f3\n? new.txt\nu UU N... 1 2 3 4 a b c f4\n");
        assert_eq!(i.branch.as_deref(), Some("main"));
        assert_eq!((i.ahead, i.behind, i.stashes), (2, 1, 3));
        assert_eq!((i.staged, i.modified, i.untracked, i.conflicted), (2, 2, 1, 1));
    }
}
