//! Small path helpers shared across modules.

use std::path::PathBuf;

/// Expand a leading `~` / `~/` to $HOME.
pub fn expand_home(p: &str) -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    if p == "~" {
        PathBuf::from(home)
    } else if let Some(rest) = p.strip_prefix("~/") {
        PathBuf::from(home).join(rest)
    } else {
        PathBuf::from(p)
    }
}
