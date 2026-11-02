//! Config backup: copy tracked dotfiles into `<backup-dir>/dotfiles/` (or `<data-dir>/configs/`
//! when no backup folder is chosen), mirroring their path relative to $HOME, and record
//! them in `manifest.json` there.
//!
//! - Copy-only: Zero never runs git on the data folder, and never writes to $HOME.
//! - Folders that are themselves git clones (oh-my-zsh plugins/themes) are recorded as
//!   remote URL + commit instead of being copied.
//! - Private keys and similar files are always refused.
//! - Files are scanned for secret-looking values so the user can review before exporting.

use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

use crate::paths::expand_home;
use crate::storage::{backup_root, data_root, ConfigState};

/// Files bigger than this are skipped (dotfiles are small; big files are usually binaries).
const MAX_FILE_BYTES: u64 = 1024 * 1024;
const MANIFEST: &str = "manifest.json";

type CmdResult<T> = Result<T, String>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ManifestFile {
    /// Absolute source path, e.g. /home/u/.zshrc
    pub source: String,
    /// Path inside configs/, e.g. .zshrc
    pub dest: String,
    pub sha256: String,
    pub size: u64,
    pub mode: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RepoRecord {
    /// Absolute path of the clone, e.g. /home/u/.oh-my-zsh/custom/themes/powerlevel10k
    pub path: String,
    /// Path relative to $HOME, for restoring on another machine.
    pub rel: String,
    pub remote: Option<String>,
    pub commit: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub exported_at: Option<u64>,
    pub hostname: Option<String>,
    pub files: Vec<ManifestFile>,
    pub repos: Vec<RepoRecord>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Skipped {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileStatus {
    pub source: String,
    pub rel: String,
    pub size: u64,
    /// "new" (never exported), "changed", or "same".
    pub state: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackedItem {
    /// As written in settings, e.g. "~/.zshrc".
    pub input: String,
    pub path: String,
    /// "file" | "dir" | "missing" | "blocked" | "outside-home"
    pub kind: String,
    /// "never" | "in-sync" | "changed" | "missing" | "blocked"
    pub state: String,
    pub files: Vec<FileStatus>,
    pub repos: Vec<RepoRecord>,
    pub skipped: Vec<Skipped>,
    pub total_size: u64,
    /// Files previously exported for this item that no longer exist at the source.
    pub removed: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusReport {
    pub items: Vec<TrackedItem>,
    pub configs_dir: String,
    pub last_export: Option<u64>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SecretHit {
    pub file: String,
    pub line: usize,
    pub kind: String,
    /// The line with the secret value masked.
    pub preview: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSummary {
    pub added: Vec<String>,
    pub updated: Vec<String>,
    pub removed: Vec<String>,
    pub unchanged: usize,
    pub repos: usize,
    pub skipped: Vec<Skipped>,
    pub configs_dir: String,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn home() -> PathBuf {
    expand_home("~")
}

/// Never export these, whatever the settings say.
pub fn blocked_reason(path: &Path, home: &Path) -> Option<&'static str> {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    if path.components().any(|c| c.as_os_str() == ".gnupg") {
        return Some("GnuPG keyring");
    }
    if path.starts_with(home.join(".ssh")) {
        if name.starts_with("id_") || name == "known_hosts" || name == "known_hosts.old" || name == "authorized_keys" {
            return Some("SSH key material");
        }
    }
    if ["pem", "key", "p12", "pfx", "keystore", "jks"].contains(&ext.as_str()) {
        return Some("private key / certificate file");
    }
    None
}

fn sha256_file(path: &Path) -> CmdResult<String> {
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    Ok(format!("{:x}", Sha256::digest(&bytes)))
}

fn git_out(dir: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .arg("-C").arg(dir).args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string()).filter(|s| !s.is_empty())
}

struct SourceFile {
    path: PathBuf,
    rel: PathBuf,
    size: u64,
    mode: u32,
}

#[derive(Default)]
struct Collected {
    files: Vec<SourceFile>,
    repos: Vec<RepoRecord>,
    skipped: Vec<Skipped>,
}

/// Walk a tracked path and decide what to copy, record or skip.
fn collect(path: &Path, home: &Path, out: &mut Collected) {
    let Ok(meta) = fs::symlink_metadata(path) else { return };
    let rel = path.strip_prefix(home).map(Path::to_path_buf).unwrap_or_default();
    let skip = |out: &mut Collected, reason: &str| out.skipped.push(Skipped { path: path.to_string_lossy().into(), reason: reason.into() });

    if let Some(reason) = blocked_reason(path, home) {
        return skip(out, reason);
    }
    if meta.file_type().is_symlink() {
        return skip(out, "symlink (not followed)");
    }
    if meta.is_dir() {
        if path.file_name().is_some_and(|n| n == ".git") {
            return;
        }
        if path.join(".git").exists() {
            out.repos.push(RepoRecord {
                path: path.to_string_lossy().into(),
                rel: rel.to_string_lossy().into(),
                remote: git_out(path, &["remote", "get-url", "origin"]),
                commit: git_out(path, &["rev-parse", "HEAD"]),
            });
            return;
        }
        let Ok(entries) = fs::read_dir(path) else { return skip(out, "unreadable folder") };
        let mut children: Vec<PathBuf> = entries.filter_map(|e| e.ok().map(|e| e.path())).collect();
        children.sort();
        for c in children {
            collect(&c, home, out);
        }
        return;
    }
    if path.extension().is_some_and(|e| e == "zwc") {
        return skip(out, "compiled zsh (.zwc), regenerated automatically");
    }
    if meta.len() > MAX_FILE_BYTES {
        return skip(out, "larger than 1 MB");
    }
    out.files.push(SourceFile { path: path.to_path_buf(), rel, size: meta.len(), mode: meta.permissions().mode() & 0o777 });
}

/// `<backup-dir>/dotfiles` when a backup folder is chosen, else the legacy `<data-dir>/configs`.
fn configs_dir(state: &State<ConfigState>) -> CmdResult<PathBuf> {
    match backup_root(state)? {
        Some(b) => Ok(b.join("dotfiles")),
        None => Ok(data_root(state)?.join("configs")),
    }
}

fn load_manifest(dir: &Path) -> Manifest {
    fs::read_to_string(dir.join(MANIFEST)).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

/// Write via a temp file + rename so a crash never leaves a half-written copy.
fn atomic_copy(bytes: &[u8], dest: &Path) -> CmdResult<()> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = dest.with_file_name(format!(
        ".{}.zero-tmp",
        dest.file_name().and_then(|n| n.to_str()).unwrap_or("file")
    ));
    {
        let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(bytes).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, dest).map_err(|e| e.to_string())
}

/// Resolve a settings entry into an absolute path under $HOME.
fn resolve_tracked(input: &str, home: &Path) -> Result<PathBuf, &'static str> {
    let p = expand_home(input.trim());
    if !p.is_absolute() || !p.starts_with(home) || p == home {
        return Err("outside-home");
    }
    Ok(p)
}

fn status_for(input: &str, home: &Path, manifest: &Manifest) -> TrackedItem {
    let mut item = TrackedItem {
        input: input.to_string(), path: String::new(), kind: "missing".into(), state: "missing".into(),
        files: vec![], repos: vec![], skipped: vec![], total_size: 0, removed: vec![],
    };
    let path = match resolve_tracked(input, home) {
        Ok(p) => p,
        Err(kind) => {
            item.kind = kind.into();
            item.state = "blocked".into();
            return item;
        }
    };
    item.path = path.to_string_lossy().into();
    if let Some(reason) = blocked_reason(&path, home) {
        item.kind = "blocked".into();
        item.state = "blocked".into();
        item.skipped.push(Skipped { path: item.path.clone(), reason: reason.into() });
        return item;
    }
    let previously: Vec<&ManifestFile> = manifest.files.iter().filter(|f| Path::new(&f.source).starts_with(&path)).collect();
    if !path.exists() {
        item.removed = previously.iter().map(|f| f.source.clone()).collect();
        return item;
    }
    item.kind = if path.is_dir() { "dir" } else { "file" }.into();

    let mut c = Collected::default();
    collect(&path, home, &mut c);
    let by_source: BTreeMap<&str, &ManifestFile> = previously.iter().map(|f| (f.source.as_str(), *f)).collect();
    let mut seen = HashSet::new();
    for f in &c.files {
        let source = f.path.to_string_lossy().to_string();
        let state = match by_source.get(source.as_str()) {
            None => "new",
            Some(m) if sha256_file(&f.path).ok().as_deref() == Some(m.sha256.as_str()) => "same",
            Some(_) => "changed",
        };
        item.total_size += f.size;
        seen.insert(source.clone());
        item.files.push(FileStatus { source, rel: f.rel.to_string_lossy().into(), size: f.size, state: state.into() });
    }
    item.removed = previously.iter().filter(|f| !seen.contains(&f.source)).map(|f| f.source.clone()).collect();

    let prev_repos: Vec<&RepoRecord> = manifest.repos.iter().filter(|r| Path::new(&r.path).starts_with(&path)).collect();
    let repos_changed = c.repos.len() != prev_repos.len() || c.repos.iter().any(|r| !prev_repos.contains(&r));

    item.state = if previously.is_empty() && prev_repos.is_empty() {
        "never"
    } else if item.files.iter().any(|f| f.state != "same") || !item.removed.is_empty() || repos_changed {
        "changed"
    } else {
        "in-sync"
    }
    .into();
    item.repos = c.repos;
    item.skipped = c.skipped;
    item
}

// ---------------------------------------------------------------------------
// Secret scanning
// ---------------------------------------------------------------------------

fn secret_patterns() -> &'static [(&'static str, Regex)] {
    static P: OnceLock<Vec<(&'static str, Regex)>> = OnceLock::new();
    P.get_or_init(|| {
        [
            ("Private key", r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
            ("AWS access key", r"\bAKIA[0-9A-Z]{16}\b"),
            ("GitHub token", r"\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})"),
            ("Slack token", r"\bxox[abprs]-[A-Za-z0-9-]{10,}"),
            ("API key (sk-…)", r"\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}"),
            ("Secret-looking assignment",
             r#"(?i)\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_KEY)[A-Z0-9_]*\s*[=:]\s*['"]?([^\s'"$`{}()]{8,})"#),
        ]
        .into_iter()
        .map(|(k, re)| (k, Regex::new(re).expect("valid secret regex")))
        .collect()
    })
}

/// Mask everything but the first 4 characters of the matched secret.
fn mask(line: &str, start: usize, end: usize) -> String {
    let secret = &line[start..end];
    let keep: String = secret.chars().take(4).collect();
    let preview = format!("{}{}…[{} chars hidden]{}", &line[..start], keep, secret.chars().count().saturating_sub(4), &line[end..]);
    preview.chars().take(160).collect()
}

pub fn scan_text(file: &str, text: &str) -> Vec<SecretHit> {
    let mut hits = vec![];
    for (i, line) in text.lines().enumerate() {
        for (kind, re) in secret_patterns() {
            if let Some(caps) = re.captures(line) {
                // Prefer the value capture group when the pattern has one.
                let m = caps.get(1).unwrap_or_else(|| caps.get(0).expect("match"));
                hits.push(SecretHit { file: file.into(), line: i + 1, kind: (*kind).into(), preview: mask(line, m.start(), m.end()) });
                break; // one finding per line is enough
            }
        }
    }
    hits
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn config_status(state: State<'_, ConfigState>, dotfiles: Vec<String>) -> CmdResult<StatusReport> {
    let dir = configs_dir(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let home = home();
        let manifest = load_manifest(&dir);
        Ok(StatusReport {
            items: dotfiles.iter().map(|d| status_for(d, &home, &manifest)).collect(),
            configs_dir: dir.to_string_lossy().into(),
            last_export: manifest.exported_at,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn scan_config_secrets(dotfiles: Vec<String>) -> CmdResult<Vec<SecretHit>> {
    tauri::async_runtime::spawn_blocking(move || {
        let home = home();
        let mut hits = vec![];
        for d in &dotfiles {
            let Ok(path) = resolve_tracked(d, &home) else { continue };
            let mut c = Collected::default();
            collect(&path, &home, &mut c);
            for f in c.files {
                if let Ok(text) = fs::read_to_string(&f.path) {
                    hits.extend(scan_text(&f.path.to_string_lossy(), &text));
                }
            }
        }
        Ok(hits)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Copy tracked files into configs/, prune files that disappeared, and write the manifest.
/// `skip` lists source paths the user chose to leave out (e.g. after a secret warning).
#[tauri::command]
pub async fn export_configs(state: State<'_, ConfigState>, dotfiles: Vec<String>, skip: Vec<String>) -> CmdResult<ExportSummary> {
    let dir = configs_dir(&state)?;
    tauri::async_runtime::spawn_blocking(move || export_into(&dir, &home(), &dotfiles, &skip))
        .await
        .map_err(|e| e.to_string())?
}

pub fn export_into(dir: &Path, home: &Path, dotfiles: &[String], skip: &[String]) -> CmdResult<ExportSummary> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let old = load_manifest(dir);
    let skip: HashSet<&str> = skip.iter().map(String::as_str).collect();
    let mut summary = ExportSummary {
        added: vec![], updated: vec![], removed: vec![], unchanged: 0, repos: 0, skipped: vec![],
        configs_dir: dir.to_string_lossy().into(),
    };
    let mut manifest = Manifest {
        exported_at: SystemTime::now().duration_since(UNIX_EPOCH).ok().map(|d| d.as_secs()),
        hostname: fs::read_to_string("/etc/hostname").ok().map(|h| h.trim().to_string()),
        ..Default::default()
    };

    for d in dotfiles {
        let Ok(path) = resolve_tracked(d, home) else {
            summary.skipped.push(Skipped { path: d.clone(), reason: "outside your home folder".into() });
            continue;
        };
        if !path.exists() {
            continue;
        }
        let mut c = Collected::default();
        collect(&path, home, &mut c);
        summary.skipped.extend(c.skipped);
        manifest.repos.extend(c.repos);

        for f in c.files {
            let source = f.path.to_string_lossy().to_string();
            if skip.contains(source.as_str()) {
                summary.skipped.push(Skipped { path: source, reason: "skipped by you".into() });
                continue;
            }
            let bytes = fs::read(&f.path).map_err(|e| format!("{source}: {e}"))?;
            let sha = format!("{:x}", Sha256::digest(&bytes));
            let dest_rel = f.rel.to_string_lossy().to_string();
            let dest = dir.join(&f.rel);
            match old.files.iter().find(|m| m.source == source) {
                Some(m) if m.sha256 == sha && dest.exists() => summary.unchanged += 1,
                Some(_) => { atomic_copy(&bytes, &dest)?; summary.updated.push(dest_rel.clone()); }
                None => { atomic_copy(&bytes, &dest)?; summary.added.push(dest_rel.clone()); }
            }
            manifest.files.push(ManifestFile { source, dest: dest_rel, sha256: sha, size: f.size, mode: f.mode });
        }
    }

    // Remove copies whose source is no longer exported. Only ever touches files inside configs/.
    let keep: HashSet<&str> = manifest.files.iter().map(|f| f.dest.as_str()).collect();
    for m in &old.files {
        if keep.contains(m.dest.as_str()) {
            continue;
        }
        let target = dir.join(&m.dest);
        let inside = target.canonicalize().map(|t| t.starts_with(dir.canonicalize().unwrap_or_default())).unwrap_or(false);
        if inside && fs::remove_file(&target).is_ok() {
            summary.removed.push(m.dest.clone());
        }
    }

    summary.repos = manifest.repos.len();
    let json = serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?;
    atomic_copy(&json, &dir.join(MANIFEST))?;
    Ok(summary)
}

/// Text of the backed-up copy of `source` (None if never exported or not text).
#[tauri::command]
pub fn config_backup_text(state: State<ConfigState>, source: String) -> CmdResult<Option<String>> {
    let dir = configs_dir(&state)?;
    let manifest = load_manifest(&dir);
    Ok(manifest
        .files
        .iter()
        .find(|f| f.source == source)
        .and_then(|f| fs::read_to_string(dir.join(&f.dest)).ok()))
}

/// Current text of a tracked file (must be under $HOME and not blocked).
#[tauri::command]
pub fn config_current_text(source: String) -> CmdResult<Option<String>> {
    let home = home();
    let path = PathBuf::from(&source);
    if !path.starts_with(&home) || blocked_reason(&path, &home).is_some() {
        return Err("Not a trackable file".into());
    }
    Ok(fs::read_to_string(path).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("zero-cfg-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn blocks_key_material() {
        let home = PathBuf::from("/home/u");
        assert!(blocked_reason(&home.join(".ssh/id_ed25519"), &home).is_some());
        assert!(blocked_reason(&home.join(".ssh/id_rsa.pub"), &home).is_some());
        assert!(blocked_reason(&home.join(".ssh/known_hosts"), &home).is_some());
        assert!(blocked_reason(&home.join(".gnupg/pubring.kbx"), &home).is_some());
        assert!(blocked_reason(&home.join("certs/server.pem"), &home).is_some());
        assert!(blocked_reason(&home.join(".ssh/config"), &home).is_none());
        assert!(blocked_reason(&home.join(".zshrc"), &home).is_none());
    }

    #[test]
    fn finds_and_masks_secrets() {
        let text = "alias ll='ls -la'\nexport GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789\nexport API_KEY=\"supersecretvalue\"\nexport PATH=$HOME/bin:$PATH\nexport DB_PASSWORD=$PASS_FROM_ENV\n";
        let hits = scan_text("f", text);
        assert_eq!(hits.iter().map(|h| h.line).collect::<Vec<_>>(), vec![2, 3]);
        assert!(!hits[0].preview.contains("ghp_abcdefghijklmnopqrstuvwxyz"));
        assert!(!hits[1].preview.contains("supersecretvalue"));
        assert!(hits[1].preview.contains("supe…"));
    }

    #[test]
    fn export_copies_records_clones_and_prunes() {
        let home = tmp("home");
        let data = tmp("data").join("configs");
        fs::write(home.join(".zshrc"), "alias g=git\n").unwrap();
        let custom = home.join(".oh-my-zsh/custom");
        fs::create_dir_all(custom.join("plugins/mine")).unwrap();
        fs::write(custom.join("aliases.zsh"), "alias x=1\n").unwrap();
        fs::write(custom.join("plugins/mine/mine.plugin.zsh"), "echo hi\n").unwrap();
        fs::write(custom.join("cache.zwc"), "bin").unwrap();
        // A plugin that is a git clone: recorded, not copied.
        let clone = custom.join("themes/p10k");
        fs::create_dir_all(clone.join(".git")).unwrap();
        fs::write(clone.join("p10k.zsh-theme"), "theme\n").unwrap();
        fs::create_dir_all(home.join(".ssh")).unwrap();
        fs::write(home.join(".ssh/id_ed25519"), "PRIVATE").unwrap();

        let tracked: Vec<String> = [".zshrc", ".oh-my-zsh/custom", ".ssh/id_ed25519"]
            .iter().map(|p| home.join(p).to_string_lossy().into()).collect();

        let s = export_into(&data, &home, &tracked, &[]).unwrap();
        assert_eq!(s.added.len(), 3, "{:?}", s.added);
        assert_eq!(s.repos, 1);
        assert!(data.join(".zshrc").exists());
        assert!(data.join(".oh-my-zsh/custom/plugins/mine/mine.plugin.zsh").exists());
        assert!(!data.join(".oh-my-zsh/custom/themes/p10k").exists(), "clone must not be copied");
        assert!(!data.join(".oh-my-zsh/custom/cache.zwc").exists());
        assert!(!data.join(".ssh/id_ed25519").exists(), "private key must never be exported");

        let manifest = load_manifest(&data);
        let st = status_for(&tracked[0], &home, &manifest);
        assert_eq!(st.state, "in-sync");

        // Change one file, delete another, re-export.
        fs::write(home.join(".zshrc"), "alias g=git\nalias k=kubectl\n").unwrap();
        assert_eq!(status_for(&tracked[0], &home, &load_manifest(&data)).state, "changed");
        fs::remove_file(custom.join("aliases.zsh")).unwrap();
        let s2 = export_into(&data, &home, &tracked, &[]).unwrap();
        assert_eq!(s2.updated, vec![".zshrc".to_string()]);
        assert_eq!(s2.removed, vec![".oh-my-zsh/custom/aliases.zsh".to_string()]);
        assert_eq!(s2.unchanged, 1);
        assert!(!data.join(".oh-my-zsh/custom/aliases.zsh").exists());

        fs::remove_dir_all(&home).unwrap();
        fs::remove_dir_all(data.parent().unwrap()).unwrap();
    }

    #[test]
    fn refuses_paths_outside_home() {
        let home = PathBuf::from("/home/u");
        assert!(resolve_tracked("/etc/passwd", &home).is_err());
        assert!(resolve_tracked("/home/u", &home).is_err());
        assert!(resolve_tracked("/home/u/.zshrc", &home).is_ok());
    }
}

#[cfg(test)]
mod live {
    use super::*;

    /// Read-only scan of the real dotfiles: `cargo test live_secret_scan -- --ignored --nocapture`
    /// Prints only file:line:kind, never the values.
    #[test]
    #[ignore]
    fn live_secret_scan() {
        let home = home();
        for d in ["~/.zshrc", "~/.gitconfig", "~/.oh-my-zsh/custom", "~/.ssh/config"] {
            let Ok(path) = resolve_tracked(d, &home) else { continue };
            let mut c = Collected::default();
            collect(&path, &home, &mut c);
            let size: u64 = c.files.iter().map(|f| f.size).sum();
            println!("{d}: {} files ({} KB), {} repos, {} skipped", c.files.len(), size / 1024, c.repos.len(), c.skipped.len());
            for r in &c.repos { println!("   repo {} -> {:?} @ {:?}", r.rel, r.remote, r.commit.as_deref().map(|c| &c[..7])); }
            for f in c.files {
                if let Ok(t) = fs::read_to_string(&f.path) {
                    for h in scan_text(&f.path.to_string_lossy(), &t) { println!("   SECRET? {}:{} {}", h.file, h.line, h.kind); }
                }
            }
        }
    }
}

#[cfg(test)]
mod live_export {
    use super::*;

    /// Export the real dotfiles into the real data folder:
    /// `ZERO_DATA=~/Documents/www/Locals/zero-data cargo test live_export -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_export() {
        let data = PathBuf::from(std::env::var("ZERO_DATA").expect("set ZERO_DATA")).join("configs");
        let tracked: Vec<String> = ["~/.zshrc", "~/.gitconfig", "~/.oh-my-zsh/custom", "~/.ssh/config"].iter().map(|s| s.to_string()).collect();
        let s = export_into(&data, &home(), &tracked, &[]).unwrap();
        println!("added={:?}\nupdated={:?}\nremoved={:?}\nunchanged={} repos={} skipped={:?}", s.added, s.updated, s.removed, s.unchanged, s.repos, s.skipped);
    }
}
