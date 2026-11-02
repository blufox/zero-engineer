//! Launching external programs: editor-in-terminal, terminal, file manager.

use crate::paths::expand_home;
use std::path::Path;
use std::process::{Command, Stdio};

/// Build the argv to open `terminal` in `cwd`, optionally running `run` inside it.
/// Each terminal emulator has its own flags for this.
fn terminal_argv(terminal: &str, cwd: &str, run: Option<Vec<String>>) -> Vec<String> {
    let mut parts: Vec<String> = terminal.split_whitespace().map(String::from).collect();
    let bin = Path::new(parts.first().map(String::as_str).unwrap_or("gnome-terminal"))
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
    match bin.as_str() {
        "gnome-terminal" | "kgx" | "ptyxis" | "tilix" | "xfce4-terminal" | "mate-terminal" => {
            parts.push(format!("--working-directory={cwd}"));
            if let Some(cmd) = run {
                parts.push("--".into());
                parts.extend(cmd);
            }
        }
        "kitty" => {
            parts.extend(["-d".into(), cwd.into()]);
            if let Some(cmd) = run { parts.extend(cmd); }
        }
        "alacritty" => {
            parts.extend(["--working-directory".into(), cwd.into()]);
            if let Some(cmd) = run { parts.push("-e".into()); parts.extend(cmd); }
        }
        "wezterm" => {
            parts.extend(["start".into(), "--cwd".into(), cwd.into()]);
            if let Some(cmd) = run { parts.push("--".into()); parts.extend(cmd); }
        }
        "konsole" => {
            parts.extend(["--workdir".into(), cwd.into()]);
            if let Some(cmd) = run { parts.push("-e".into()); parts.extend(cmd); }
        }
        _ => {
            // Best effort for xterm-likes; cwd is also set on the process below.
            if let Some(cmd) = run { parts.push("-e".into()); parts.extend(cmd); }
        }
    }
    parts
}

fn spawn_detached(argv: &[String], cwd: &str) -> Result<(), String> {
    let (bin, args) = argv.split_first().ok_or("Empty command")?;
    let mut child = Command::new(bin)
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Could not start {bin}: {e}"))?;
    // Reap the child when it exits so it doesn't linger as a zombie.
    std::thread::spawn(move || { let _ = child.wait(); });
    Ok(())
}

fn existing_dir(path: &str) -> Result<String, String> {
    let p = expand_home(path);
    let dir = if p.is_dir() { p } else { p.parent().map(|x| x.to_path_buf()).ok_or("Invalid path")? };
    if !dir.is_dir() {
        return Err(format!("{} does not exist", dir.display()));
    }
    Ok(dir.to_string_lossy().into_owned())
}

/// Open `path` in the configured editor (e.g. vim) inside the configured terminal.
#[tauri::command]
pub fn open_in_editor(path: String, editor: String, terminal: String) -> Result<(), String> {
    let cwd = existing_dir(&path)?;
    let mut run: Vec<String> = editor.split_whitespace().map(String::from).collect();
    if run.is_empty() { run.push("vim".into()); }
    run.push(expand_home(&path).to_string_lossy().into_owned());
    spawn_detached(&terminal_argv(&terminal, &cwd, Some(run)), &cwd)
}

#[tauri::command]
pub fn open_terminal(path: String, terminal: String) -> Result<(), String> {
    let cwd = existing_dir(&path)?;
    spawn_detached(&terminal_argv(&terminal, &cwd, None), &cwd)
}

#[tauri::command]
pub fn open_folder(path: String) -> Result<(), String> {
    let cwd = existing_dir(&path)?;
    spawn_detached(&["xdg-open".into(), cwd.clone()], &cwd)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gnome_terminal_with_vim() {
        let argv = terminal_argv("gnome-terminal", "/w", Some(vec!["vim".into(), "/w".into()]));
        assert_eq!(argv, ["gnome-terminal", "--working-directory=/w", "--", "vim", "/w"]);
    }

    #[test]
    fn archive_excludes_git_and_temp_files() {
        let base = std::env::temp_dir().join(format!("zero-arch-{}", std::process::id()));
        let data = base.join("zero-data");
        std::fs::create_dir_all(data.join(".git")).unwrap();
        std::fs::create_dir_all(data.join("snippets")).unwrap();
        std::fs::write(data.join(".git/HEAD"), "ref").unwrap();
        std::fs::write(data.join("settings.json"), "{}").unwrap();
        std::fs::write(data.join("snippets/a.json"), "{}").unwrap();
        std::fs::write(data.join("configs.zero-tmp"), "x").unwrap();
        let dest = base.join("out.tar.gz");
        let size = tauri::async_runtime::block_on(archive_data(data.to_string_lossy().into(), dest.to_string_lossy().into())).unwrap();
        assert!(size > 0);
        let list = String::from_utf8(Command::new("tar").arg("-tzf").arg(&dest).output().unwrap().stdout).unwrap();
        assert!(list.contains("zero-data/settings.json") && list.contains("zero-data/snippets/a.json"), "{list}");
        assert!(!list.contains(".git") && !list.contains("zero-tmp"), "{list}");
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn alacritty_and_kitty() {
        assert_eq!(terminal_argv("alacritty", "/w", Some(vec!["vim".into()])),
            ["alacritty", "--working-directory", "/w", "-e", "vim"]);
        assert_eq!(terminal_argv("kitty", "/w", None), ["kitty", "-d", "/w"]);
    }
}

// ---------------------------------------------------------------------------
// Start at login (XDG autostart) and data archives
// ---------------------------------------------------------------------------

fn autostart_file() -> std::path::PathBuf {
    expand_home("~/.config/autostart/zero.desktop")
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutostartStatus {
    pub enabled: bool,
    /// The executable the entry launches (or would launch).
    pub exe: String,
    /// False when running a dev build (target/debug), where autostart makes little sense.
    pub installed: bool,
}

#[tauri::command]
pub fn autostart_status() -> Result<AutostartStatus, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    Ok(AutostartStatus {
        enabled: autostart_file().exists(),
        installed: !exe.components().any(|c| c.as_os_str() == "target"),
        exe: exe.to_string_lossy().into_owned(),
    })
}

/// Create or remove ~/.config/autostart/zero.desktop (freedesktop autostart spec).
#[tauri::command]
pub fn set_autostart(enabled: bool) -> Result<AutostartStatus, String> {
    let file = autostart_file();
    if enabled {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let entry = format!(
            "[Desktop Entry]\nType=Application\nName=Zero\nComment=Personal developer hub\nExec={}\nIcon=zero\nTerminal=false\nX-GNOME-Autostart-enabled=true\n",
            exe.display()
        );
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::write(&file, entry).map_err(|e| e.to_string())?;
    } else if file.exists() {
        std::fs::remove_file(&file).map_err(|e| e.to_string())?;
    }
    autostart_status()
}

/// Write a .tar.gz of the data folder to `dest` (a path chosen in a save dialog).
/// `.git` is left out: the git repo is already its own backup.
#[tauri::command]
pub async fn archive_data(data_dir: String, dest: String) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = expand_home(&data_dir);
        let parent = dir.parent().ok_or("Invalid data folder")?;
        let name = dir.file_name().ok_or("Invalid data folder")?;
        let out = Command::new("tar")
            .arg("-czf").arg(&dest)
            .arg("--exclude=.git").arg("--exclude=*.zero-tmp").arg("--exclude=*.json.tmp")
            .arg("-C").arg(parent).arg(name)
            .output()
            .map_err(|e| format!("Could not run tar: {e}"))?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        std::fs::metadata(&dest).map(|m| m.len()).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
