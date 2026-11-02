//! Machine bootstrap: record what's installed on this machine and generate a
//! `bootstrap.sh` that rebuilds it on a new one. Zero never runs the script.
//!
//! Sources (each skipped when the tool isn't installed):
//! - apt: `apt-mark showmanual`; packages you named in `apt install` (from
//!   /var/log/apt/history*, user-requested runs only) are pre-selected, the rest
//!   (installer/base system) start unticked.
//! - third-party apt sources in /etc/apt/sources.list.d + the keyrings they reference
//! - snap, flatpak, npm -g, composer global, cargo install, uv tool, rustup toolchains
//! - plugin clones recorded by Config Backup (`dotfiles/manifest.json`)
//!
//! Output: `<backup>/bootstrap/{bootstrap.sh, packages.json, apt/}`.

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

use crate::configs::{configs_dir, load_manifest, scan_text, RepoRecord, SecretHit};
use crate::dbsnap::stamp;
use crate::paths::expand_home;
use crate::storage::{atomic_write, backup_root, data_root, ConfigState};

const OUT_DIR: &str = "bootstrap";
const SCRIPT: &str = "bootstrap.sh";
const PACKAGES: &str = "packages.json";
/// Snaps that come with the system.
const SNAP_BASE: &[&str] = &["core", "snapd", "bare", "gtk-common-themes", "snap-store", "firmware-updater", "snapd-desktop-integration"];
/// Apt sources that belong to the OS itself.
const APT_SOURCE_BASE: &[&str] = &["system.sources", "pop-os-apps.sources", "pop-os-release.sources", "ubuntu.sources"];

type CmdResult<T> = Result<T, String>;

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub name: String,
    /// Pre-ticked in the UI.
    pub selected: bool,
    /// Extra install info: snap "classic", flatpak remote, ...
    #[serde(default)]
    pub extra: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    /// "apt", "aptSources", "snap", "flatpak", "npm", "composer", "cargo", "uv", "rustup", "clones".
    pub id: String,
    pub items: Vec<Item>,
    /// Why this section is empty or partial, e.g. "flatpak is not installed".
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Scan {
    pub hostname: String,
    pub scanned_at: u64,
    pub node_version: Option<String>,
    pub sections: Vec<Section>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub script: String,
    pub previous: Option<String>,
    pub secrets: Vec<SecretHit>,
    pub out_dir: String,
}

// ---------------------------------------------------------------------------
// Running tools
// ---------------------------------------------------------------------------

/// Find a binary on PATH, or in the usual per-user places a desktop launcher's PATH misses.
fn find_bin(name: &str) -> Option<PathBuf> {
    let path = std::env::var("PATH").unwrap_or_default();
    let mut dirs: Vec<PathBuf> = path.split(':').filter(|d| !d.is_empty()).map(PathBuf::from).collect();
    for d in ["~/.cargo/bin", "~/.local/bin", "~/.config/composer/vendor/bin", "/usr/local/bin", "/snap/bin"] {
        dirs.push(expand_home(d));
    }
    dirs.extend(nvm_bin());
    dirs.into_iter().map(|d| d.join(name)).find(|p| p.is_file())
}

/// `~/.nvm/versions/node/<default or newest>/bin`.
fn nvm_bin() -> Option<PathBuf> {
    let root = expand_home("~/.nvm/versions/node");
    let mut versions: Vec<String> = fs::read_dir(&root).ok()?.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    versions.sort_by_key(|v| v.trim_start_matches('v').split('.').map(|n| n.parse::<u32>().unwrap_or(0)).collect::<Vec<_>>());
    let wanted = fs::read_to_string(expand_home("~/.nvm/alias/default")).ok().map(|s| s.trim().to_string());
    let pick = wanted
        .and_then(|w| versions.iter().rev().find(|v| v.trim_start_matches('v').starts_with(w.trim_start_matches('v'))).cloned())
        .or_else(|| versions.last().cloned())?;
    Some(root.join(pick).join("bin"))
}

/// Run a tool and return stdout, or None if it's missing or fails.
fn run(bin: &str, args: &[&str]) -> Option<String> {
    let exe = find_bin(bin)?;
    let mut cmd = Command::new(&exe);
    cmd.args(args).stdin(Stdio::null()).stderr(Stdio::null());
    // npm is a node script: make sure `node` from the same folder is found.
    if let Some(dir) = exe.parent() {
        cmd.env("PATH", format!("{}:{}", dir.display(), std::env::var("PATH").unwrap_or_default()));
    }
    cmd.env("COMPOSER_NO_INTERACTION", "1");
    let out = cmd.output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

fn missing(id: &str, tool: &str) -> Section {
    Section { id: id.into(), items: vec![], note: Some(format!("{tool} is not installed")) }
}

fn items(names: impl IntoIterator<Item = String>, selected: bool) -> Vec<Item> {
    let set: BTreeSet<String> = names.into_iter().filter(|n| !n.is_empty()).collect();
    set.into_iter().map(|name| Item { name, selected, extra: None }).collect()
}

// ---------------------------------------------------------------------------
// Parsers (pure, tested)
// ---------------------------------------------------------------------------

/// Packages named on `apt install` command lines that a user ran (blocks with `Requested-By`).
pub fn requested_packages(history: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for block in history.split("\n\n") {
        if !block.lines().any(|l| l.starts_with("Requested-By:")) {
            continue;
        }
        let Some(cmd) = block.lines().find_map(|l| l.strip_prefix("Commandline: ")) else { continue };
        let words: Vec<&str> = cmd.split_whitespace().collect();
        let Some(i) = words.iter().position(|w| *w == "install") else { continue };
        if !words[..i].iter().any(|w| w.ends_with("apt") || w.ends_with("apt-get")) {
            continue;
        }
        for w in &words[i + 1..] {
            if w.starts_with('-') || w.contains('/') || w.ends_with(".deb") {
                continue;
            }
            let name = w.split(['=', ':']).next().unwrap_or("");
            if valid_name(name) {
                out.insert(name.to_string());
            }
        }
    }
    out
}

/// `snap list` → (name, classic).
pub fn parse_snaps(text: &str) -> Vec<Item> {
    text.lines()
        .skip(1)
        .filter_map(|l| {
            let f: Vec<&str> = l.split_whitespace().collect();
            let name = *f.first()?;
            let notes = f.get(5).copied().unwrap_or("");
            if SNAP_BASE.contains(&name) || name.starts_with("core") || name.starts_with("gnome-") || name.starts_with("kf5-") || name.starts_with("mesa-") {
                return None;
            }
            Some(Item { name: name.into(), selected: true, extra: notes.contains("classic").then(|| "classic".into()) })
        })
        .collect()
}

/// `npm ls -g --depth=0 --json` → package names (without npm itself and corepack).
pub fn parse_npm(json: &str) -> Vec<String> {
    let v: serde_json::Value = serde_json::from_str(json).unwrap_or_default();
    v.get("dependencies")
        .and_then(|d| d.as_object())
        .map(|d| d.keys().filter(|k| !["npm", "corepack"].contains(&k.as_str())).cloned().collect())
        .unwrap_or_default()
}

/// `cargo install --list`: unindented lines are "name vX.Y.Z:" (or "name vX (path):").
pub fn parse_cargo(text: &str) -> Vec<String> {
    text.lines()
        .filter(|l| !l.starts_with(char::is_whitespace) && !l.contains(" (/"))
        .filter_map(|l| l.split_whitespace().next().map(String::from))
        .collect()
}

/// `uv tool list`: "name vX.Y" lines, executables indented with "- ".
pub fn parse_uv(text: &str) -> Vec<String> {
    text.lines()
        .filter(|l| !l.starts_with('-') && !l.starts_with(char::is_whitespace))
        .filter_map(|l| l.split_whitespace().next().map(String::from))
        .collect()
}

/// `rustup toolchain list` → "stable", "nightly", "1.80" (host triple and "(default)" removed).
pub fn parse_toolchains(text: &str) -> Vec<Item> {
    text.lines()
        .filter_map(|l| {
            let name = l.split_whitespace().next()?;
            let short = name.split('-').next().unwrap_or(name);
            Some(Item { name: short.into(), selected: true, extra: l.contains("(default)").then(|| "default".into()) })
        })
        .collect()
}

fn keyring_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)signed-by[=:]\s*(/[^\s\]]+)").unwrap())
}

/// Keyring paths referenced by an apt source file.
pub fn keyrings_in(source: &str) -> Vec<String> {
    keyring_re().captures_iter(source).map(|c| c[1].to_string()).collect()
}

/// Names that are safe to put in a shell script unquoted (apt, npm @scope/x, vendor/pkg).
pub fn valid_name(n: &str) -> bool {
    !n.is_empty() && n.len() < 200 && n.chars().all(|c| c.is_ascii_alphanumeric() || "@._+-/:".contains(c)) && !n.starts_with('-')
}

fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

fn apt_history() -> String {
    let mut text = fs::read_to_string("/var/log/apt/history.log").unwrap_or_default();
    if let Ok(entries) = fs::read_dir("/var/log/apt") {
        for e in entries.filter_map(|e| e.ok()) {
            let p = e.path();
            if p.file_name().is_some_and(|n| n.to_string_lossy().starts_with("history.log.")) && p.extension().is_some_and(|x| x == "gz") {
                if let Ok(out) = Command::new("zcat").arg(&p).output() {
                    text.push_str("\n\n");
                    text.push_str(&String::from_utf8_lossy(&out.stdout));
                }
            }
        }
    }
    text
}

fn scan_apt() -> Section {
    let Some(manual) = run("apt-mark", &["showmanual"]) else { return missing("apt", "apt-mark") };
    let requested = requested_packages(&apt_history());
    let mut list: Vec<Item> = manual
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|n| valid_name(n))
        .map(|name| Item { selected: requested.contains(&name), name, extra: None })
        .collect();
    list.sort_by(|a, b| b.selected.cmp(&a.selected).then(a.name.cmp(&b.name)));
    let picked = list.iter().filter(|i| i.selected).count();
    Section {
        id: "apt".into(),
        note: Some(format!("{picked} you installed with apt install are ticked; {} others came with the system or as dependencies", list.len() - picked)),
        items: list,
    }
}

fn scan_apt_sources() -> Section {
    let mut list = vec![];
    if let Ok(entries) = fs::read_dir("/etc/apt/sources.list.d") {
        for e in entries.filter_map(|e| e.ok()) {
            let name = e.file_name().to_string_lossy().into_owned();
            if !(name.ends_with(".list") || name.ends_with(".sources")) || APT_SOURCE_BASE.contains(&name.as_str()) {
                continue;
            }
            let keys = fs::read_to_string(e.path()).map(|t| keyrings_in(&t)).unwrap_or_default();
            list.push(Item { name, selected: true, extra: (!keys.is_empty()).then(|| keys.join(" ")) });
        }
    }
    list.sort_by(|a, b| a.name.cmp(&b.name));
    Section { id: "aptSources".into(), items: list, note: None }
}

fn scan_clones(state: &State<ConfigState>) -> Section {
    let manifest = configs_dir(state).map(|d| load_manifest(&d)).unwrap_or_default();
    let list = manifest
        .repos
        .iter()
        .filter_map(|r: &RepoRecord| {
            let remote = r.remote.clone()?;
            Some(Item { name: r.rel.clone(), selected: true, extra: Some(format!("{remote} {}", r.commit.clone().unwrap_or_default()).trim().to_string()) })
        })
        .collect::<Vec<_>>();
    let note = list.is_empty().then(|| "Export your dotfiles on the Config Backup page to record plugin clones".to_string());
    Section { id: "clones".into(), items: list, note }
}

fn hostname() -> String {
    fs::read_to_string("/etc/hostname").map(|h| h.trim().to_string()).unwrap_or_else(|_| "this machine".into())
}

#[tauri::command]
pub async fn bootstrap_scan(state: State<'_, ConfigState>) -> CmdResult<Scan> {
    let clones = scan_clones(&state);
    tauri::async_runtime::spawn_blocking(move || Ok(scan_machine(clones)))
        .await
        .map_err(|e| e.to_string())?
}

/// Every package manager in parallel (each is a few hundred ms of subprocess time).
fn scan_machine(clones: Section) -> Scan {
        let sections = std::thread::scope(|s| {
            let apt = s.spawn(scan_apt);
            let snap = s.spawn(|| match run("snap", &["list"]) {
                Some(t) => Section { id: "snap".into(), items: parse_snaps(&t), note: None },
                None => missing("snap", "snap"),
            });
            let flatpak = s.spawn(|| match run("flatpak", &["list", "--app", "--columns=application,origin"]) {
                Some(t) => Section {
                    id: "flatpak".into(),
                    items: t.lines().filter_map(|l| {
                        let (app, origin) = l.split_once('\t').unwrap_or((l, "flathub"));
                        valid_name(app.trim()).then(|| Item { name: app.trim().into(), selected: true, extra: Some(origin.trim().into()) })
                    }).collect(),
                    note: None,
                },
                None => missing("flatpak", "flatpak"),
            });
            let npm = s.spawn(|| match run("npm", &["ls", "-g", "--depth=0", "--json"]) {
                Some(t) => Section { id: "npm".into(), items: items(parse_npm(&t), true), note: None },
                None => missing("npm", "npm"),
            });
            let composer = s.spawn(|| match run("composer", &["global", "show", "--direct", "-N", "--no-ansi"]) {
                Some(t) => Section { id: "composer".into(), items: items(t.lines().map(|l| l.trim().to_string()).filter(|n| n.contains('/')), true), note: None },
                None => missing("composer", "composer"),
            });
            let cargo = s.spawn(|| match run("cargo", &["install", "--list"]) {
                Some(t) => Section { id: "cargo".into(), items: items(parse_cargo(&t), true), note: None },
                None => missing("cargo", "cargo"),
            });
            let uv = s.spawn(|| match run("uv", &["tool", "list"]) {
                Some(t) => Section { id: "uv".into(), items: items(parse_uv(&t), true), note: None },
                None => missing("uv", "uv"),
            });
            let rustup = s.spawn(|| match run("rustup", &["toolchain", "list"]) {
                Some(t) => Section { id: "rustup".into(), items: parse_toolchains(&t), note: None },
                None => missing("rustup", "rustup"),
            });
            let mut out = vec![apt.join().unwrap_or_default(), scan_apt_sources()];
            for h in [snap, flatpak, npm, composer, cargo, uv, rustup] {
                out.push(h.join().unwrap_or_default());
            }
            out
        });
        let mut sections = sections;
        sections.push(clones);
        Scan {
            hostname: hostname(),
            scanned_at: SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0),
            node_version: run("node", &["--version"]).map(|v| v.trim().to_string()),
            sections,
        }
}

// ---------------------------------------------------------------------------
// Script generation (pure, tested)
// ---------------------------------------------------------------------------

fn selected<'a>(scan: &'a Scan, id: &str) -> Vec<&'a Item> {
    scan.sections.iter().filter(|s| s.id == id).flat_map(|s| &s.items).filter(|i| i.selected && valid_name(&i.name)).collect()
}

fn names(items: &[&Item]) -> String {
    items.iter().map(|i| format!("  {}", i.name)).collect::<Vec<_>>().join(" \\\n")
}

/// Local file name a keyring is stored under in `apt/keyrings/`.
fn keyring_file(path: &str) -> String {
    path.trim_start_matches('/').replace('/', "__")
}

pub fn render_script(scan: &Scan) -> String {
    let mut s = String::new();
    let push = |s: &mut String, line: &str| { s.push_str(line); s.push('\n'); };
    push(&mut s, "#!/usr/bin/env bash");
    push(&mut s, &format!("# Rebuilds the tools from {} ({}Z UTC). Generated by Zero.", scan.hostname, stamp(scan.scanned_at)));
    push(&mut s, "# Read it before running. Each step is safe to re-run; failures in one package don't stop the rest.");
    push(&mut s, "set -uo pipefail");
    push(&mut s, "cd \"$(dirname \"$0\")\"");
    push(&mut s, "have() { command -v \"$1\" >/dev/null 2>&1; }");
    push(&mut s, "step() { printf '\\n\\033[1;32m==> %s\\033[0m\\n' \"$*\"; }");
    push(&mut s, "failed=()");
    push(&mut s, "try() { \"$@\" || failed+=(\"$*\"); }");

    let sources = selected(scan, "aptSources");
    if !sources.is_empty() {
        push(&mut s, "\nstep 'Third-party apt sources'");
        for src in &sources {
            for key in src.extra.as_deref().unwrap_or("").split_whitespace() {
                push(&mut s, &format!("[ -f {k} ] || try sudo install -D -m 644 apt/keyrings/{f} {k}", k = sh_quote(key), f = keyring_file(key)));
            }
            push(&mut s, &format!("[ -f /etc/apt/sources.list.d/{n} ] || try sudo install -m 644 apt/sources/{n} /etc/apt/sources.list.d/{n}", n = src.name));
        }
    }

    let apt = selected(scan, "apt");
    if !apt.is_empty() {
        push(&mut s, "\nstep 'apt packages'");
        push(&mut s, "APT=(");
        push(&mut s, &names(&apt).replace(" \\", ""));
        push(&mut s, ")");
        push(&mut s, "sudo apt-get update");
        push(&mut s, "sudo apt-get install -y \"${APT[@]}\" || for p in \"${APT[@]}\"; do try sudo apt-get install -y \"$p\"; done");
    }

    let snaps = selected(scan, "snap");
    if !snaps.is_empty() {
        push(&mut s, "\nstep 'Snaps'");
        push(&mut s, "if have snap; then");
        for i in &snaps {
            let classic = if i.extra.as_deref() == Some("classic") { " --classic" } else { "" };
            push(&mut s, &format!("  snap list {n} >/dev/null 2>&1 || try sudo snap install {n}{classic}", n = i.name));
        }
        push(&mut s, "fi");
    }

    let flatpaks = selected(scan, "flatpak");
    if !flatpaks.is_empty() {
        push(&mut s, "\nstep 'Flatpaks'");
        push(&mut s, "if have flatpak; then");
        push(&mut s, "  flatpak remote-add --if-not-exists --user flathub https://dl.flathub.org/repo/flathub.flatpakrepo");
        for i in &flatpaks {
            let origin = i.extra.as_deref().filter(|o| valid_name(o)).unwrap_or("flathub");
            push(&mut s, &format!("  try flatpak install -y --noninteractive {origin} {}", i.name));
        }
        push(&mut s, "fi");
    }

    let toolchains = selected(scan, "rustup");
    let crates = selected(scan, "cargo");
    if !toolchains.is_empty() || !crates.is_empty() {
        push(&mut s, "\nstep 'Rust'");
        push(&mut s, "if ! have rustup && [ ! -x \"$HOME/.cargo/bin/rustup\" ]; then");
        push(&mut s, "  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path");
        push(&mut s, "fi");
        push(&mut s, "export PATH=\"$HOME/.cargo/bin:$PATH\"");
        for t in &toolchains {
            push(&mut s, &format!("try rustup toolchain install {}", t.name));
        }
        if let Some(d) = toolchains.iter().find(|t| t.extra.as_deref() == Some("default")) {
            push(&mut s, &format!("try rustup default {}", d.name));
        }
        for c in &crates {
            push(&mut s, &format!("have {n} || try cargo install --locked {n}", n = c.name));
        }
    }

    let npm = selected(scan, "npm");
    if !npm.is_empty() || scan.node_version.is_some() {
        push(&mut s, "\nstep 'Node'");
        push(&mut s, "export NVM_DIR=\"$HOME/.nvm\"");
        push(&mut s, "[ -s \"$NVM_DIR/nvm.sh\" ] && . \"$NVM_DIR/nvm.sh\"");
        if let Some(v) = scan.node_version.as_deref().filter(|v| valid_name(v)) {
            push(&mut s, &format!("if type nvm >/dev/null 2>&1; then try nvm install {v}; else echo 'Install nvm, then: nvm install {v}'; fi"));
        }
        if !npm.is_empty() {
            push(&mut s, &format!("have npm && try npm install -g{}", npm.iter().map(|i| format!(" {}", i.name)).collect::<String>()));
        }
    }

    let composer = selected(scan, "composer");
    if !composer.is_empty() {
        push(&mut s, "\nstep 'Composer global packages'");
        push(&mut s, &format!("have composer && try composer global require --no-interaction{}", composer.iter().map(|i| format!(" {}", i.name)).collect::<String>()));
    }

    let uv = selected(scan, "uv");
    if !uv.is_empty() {
        push(&mut s, "\nstep 'uv tools'");
        push(&mut s, "have uv || curl -LsSf https://astral.sh/uv/install.sh | sh");
        push(&mut s, "export PATH=\"$HOME/.local/bin:$PATH\"");
        for i in &uv {
            push(&mut s, &format!("try uv tool install {}", i.name));
        }
    }

    let clones = selected(scan, "clones");
    if !clones.is_empty() {
        push(&mut s, "\nstep 'Shell plugins and themes'");
        for c in &clones {
            let mut parts = c.extra.as_deref().unwrap_or("").split_whitespace();
            let (Some(remote), commit) = (parts.next(), parts.next()) else { continue };
            let dest = format!("\"$HOME\"/{}", sh_quote(&c.name));
            let checkout = commit.filter(|c| c.chars().all(|x| x.is_ascii_hexdigit())).map(|c| format!(" && git -C {dest} checkout -q {c}")).unwrap_or_default();
            push(&mut s, &format!("[ -d {dest} ] || try sh -c 'git clone -q \"$1\" \"$2\"' _ {} {dest}{checkout}", sh_quote(remote)));
        }
    }

    push(&mut s, "\nstep 'Dotfiles'");
    push(&mut s, "echo 'Open Zero > Config Backup, choose this backup folder, and restore dotfiles from dotfiles/ (diff, then copy).'");
    push(&mut s, "\nif [ ${#failed[@]} -gt 0 ]; then");
    push(&mut s, "  printf '\\n\\033[1;33mThese steps failed:\\033[0m\\n'; printf '  %s\\n' \"${failed[@]}\"; exit 1");
    push(&mut s, "fi");
    push(&mut s, "step 'Done'");
    s
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

fn out_dir(state: &State<ConfigState>) -> CmdResult<PathBuf> {
    Ok(match backup_root(state)? {
        Some(b) => b.join(OUT_DIR),
        None => data_root(state)?.join(OUT_DIR),
    })
}

#[tauri::command]
pub fn bootstrap_preview(state: State<ConfigState>, scan: Scan) -> CmdResult<Preview> {
    let dir = out_dir(&state)?;
    let script = render_script(&scan);
    Ok(Preview {
        secrets: scan_text(SCRIPT, &script),
        previous: fs::read_to_string(dir.join(SCRIPT)).ok(),
        script,
        out_dir: dir.to_string_lossy().into_owned(),
    })
}

/// Write bootstrap.sh, packages.json and copies of the selected apt sources and keyrings.
#[tauri::command]
pub fn bootstrap_export(state: State<ConfigState>, scan: Scan) -> CmdResult<String> {
    let dir = out_dir(&state)?;
    let script = render_script(&scan);

    let apt_dir = dir.join("apt");
    let _ = fs::remove_dir_all(&apt_dir);
    for src in selected(&scan, "aptSources") {
        let from = Path::new("/etc/apt/sources.list.d").join(&src.name);
        let text = fs::read_to_string(&from).map_err(|e| format!("{}: {e}", from.display()))?;
        atomic_write(&apt_dir.join("sources").join(&src.name), text.as_bytes())?;
        for key in keyrings_in(&text) {
            if let Ok(bytes) = fs::read(&key) {
                atomic_write(&apt_dir.join("keyrings").join(keyring_file(&key)), &bytes)?;
            }
        }
    }

    let script_path = dir.join(SCRIPT);
    atomic_write(&script_path, script.as_bytes())?;
    fs::set_permissions(&script_path, fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    atomic_write(&dir.join(PACKAGES), &serde_json::to_vec_pretty(&scan).map_err(|e| e.to_string())?)?;
    Ok(script_path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    const HISTORY: &str = "\
Start-Date: 2026-01-01  10:00:00
Commandline: apt-get install -y systemd pop-desktop
Install: pop-desktop:amd64 (1.0)
End-Date: 2026-01-01  10:01:00

Start-Date: 2026-02-01  10:00:00
Commandline: apt install -y vim php8.3=8.3.1 redis-server:amd64 ./local.deb
Requested-By: kyle (1000)
Install: vim:amd64 (2:9.1)
End-Date: 2026-02-01  10:01:00

Start-Date: 2026-02-02  10:00:00
Commandline: apt remove nano
Requested-By: kyle (1000)
End-Date: 2026-02-02  10:01:00
";

    /// `cargo test -- --ignored --nocapture live_scan`: what this machine would export.
    #[test]
    #[ignore]
    fn live_scan() {
        let scan = scan_machine(Section::default());
        for sec in &scan.sections {
            let picked: Vec<&str> = sec.items.iter().filter(|i| i.selected).map(|i| i.name.as_str()).collect();
            println!("{:<11} {:>3}/{:<3} {}  {}", sec.id, picked.len(), sec.items.len(), sec.note.as_deref().unwrap_or(""),
                picked.iter().take(12).copied().collect::<Vec<_>>().join(" "));
        }
        let script = render_script(&scan);
        let f = std::env::temp_dir().join("zero-live-bootstrap.sh");
        fs::write(&f, &script).unwrap();
        assert!(Command::new("bash").arg("-n").arg(&f).status().unwrap().success());
        println!("script: {} lines, bash -n ok", script.lines().count());
    }

    #[test]
    fn requested_from_history() {
        let r = requested_packages(HISTORY);
        assert_eq!(r.into_iter().collect::<Vec<_>>(), ["php8.3", "redis-server", "vim"]);
    }

    #[test]
    fn parses_tool_output() {
        let snaps = "Name  Version  Rev  Tracking  Publisher  Notes\ncore22 1 2 latest/stable canonical base\ncode 1.9 3 latest/stable vscode classic\npostman 10 4 latest/stable postman -\n";
        let s = parse_snaps(snaps);
        assert_eq!(s.iter().map(|i| (i.name.as_str(), i.extra.as_deref())).collect::<Vec<_>>(), [("code", Some("classic")), ("postman", None)]);
        assert_eq!(parse_npm(r#"{"dependencies":{"npm":{},"corepack":{},"@vue/cli":{},"pnpm":{}}}"#), ["@vue/cli", "pnpm"]);
        assert_eq!(parse_cargo("ripgrep v14.1.0:\n    rg\ntauri-cli v2.0.0:\n    cargo-tauri\nlocal v0.1.0 (/home/k/x):\n    local\n"), ["ripgrep", "tauri-cli"]);
        assert_eq!(parse_uv("ruff v0.6.0\n- ruff\nhttpie v3.2\n- http\n"), ["ruff", "httpie"]);
        let t = parse_toolchains("stable-x86_64-unknown-linux-gnu (default)\nnightly-x86_64-unknown-linux-gnu\n");
        assert_eq!((t[0].name.as_str(), t[0].extra.as_deref(), t[1].name.as_str()), ("stable", Some("default"), "nightly"));
        assert_eq!(keyrings_in("deb [arch=amd64 signed-by=/usr/share/keyrings/gh.gpg] https://x stable main\nSigned-By: /etc/apt/keyrings/y.asc\n"),
            ["/usr/share/keyrings/gh.gpg", "/etc/apt/keyrings/y.asc"]);
    }

    #[test]
    fn script_is_selected_only_and_quoted() {
        let item = |n: &str, sel: bool, extra: Option<&str>| Item { name: n.into(), selected: sel, extra: extra.map(String::from) };
        let scan = Scan {
            hostname: "pop-os".into(),
            scanned_at: 0,
            node_version: Some("v25.6.1".into()),
            sections: vec![
                Section { id: "apt".into(), items: vec![item("vim", true, None), item("base-files", false, None), item("bad;rm -rf", true, None)], note: None },
                Section { id: "aptSources".into(), items: vec![item("gh.list", true, Some("/usr/share/keyrings/gh.gpg"))], note: None },
                Section { id: "snap".into(), items: vec![item("code", true, Some("classic"))], note: None },
                Section { id: "npm".into(), items: vec![item("pnpm", true, None)], note: None },
                Section { id: "cargo".into(), items: vec![item("ripgrep", true, None)], note: None },
                Section { id: "rustup".into(), items: vec![item("stable", true, Some("default"))], note: None },
                Section { id: "clones".into(), items: vec![item(".oh-my-zsh/custom/themes/p10k", true, Some("https://github.com/romkatv/powerlevel10k.git abc123"))], note: None },
            ],
        };
        let s = render_script(&scan);
        assert!(s.starts_with("#!/usr/bin/env bash\n"));
        assert!(s.contains("  vim\n"));
        assert!(!s.contains("base-files"));
        assert!(!s.contains("bad;rm"));
        assert!(s.contains("try sudo install -D -m 644 apt/keyrings/usr__share__keyrings__gh.gpg '/usr/share/keyrings/gh.gpg'"));
        assert!(s.contains("try sudo snap install code --classic"));
        assert!(s.contains("try npm install -g pnpm"));
        assert!(s.contains("try nvm install v25.6.1"));
        assert!(s.contains("have ripgrep || try cargo install --locked ripgrep"));
        assert!(s.contains("try rustup default stable"));
        assert!(s.contains("git clone -q \"$1\" \"$2\"' _ 'https://github.com/romkatv/powerlevel10k.git' \"$HOME\"/'.oh-my-zsh/custom/themes/p10k' && git -C \"$HOME\"/'.oh-my-zsh/custom/themes/p10k' checkout -q abc123"));
        // Syntax-check with bash when available.
        let f = std::env::temp_dir().join(format!("zero-bootstrap-{}.sh", std::process::id()));
        fs::write(&f, &s).unwrap();
        if let Ok(out) = Command::new("bash").arg("-n").arg(&f).output() {
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        }
        let _ = fs::remove_file(&f);
    }
}
