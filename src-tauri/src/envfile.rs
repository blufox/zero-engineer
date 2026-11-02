//! Minimal `.env` parser shared by the drift checker, DB detection and log detection.
//!
//! Handles `KEY=value`, `export KEY=value`, single/double quotes, inline `#` comments on
//! unquoted values, and blank/comment lines. Values never leave the Rust side except
//! where a caller explicitly needs them internally (e.g. a DB password for `mysqldump`).

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

/// Parse `.env` text into ordered `(key, value)` pairs. Later duplicates win in [`to_map`].
pub fn parse(text: &str) -> Vec<(String, String)> {
    text.lines()
        .filter_map(|raw| {
            let line = raw.trim();
            if line.is_empty() || line.starts_with('#') {
                return None;
            }
            let line = line.strip_prefix("export ").unwrap_or(line).trim_start();
            let (key, value) = line.split_once('=')?;
            let key = key.trim();
            if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.') {
                return None;
            }
            Some((key.to_string(), unquote(value.trim())))
        })
        .collect()
}

fn unquote(v: &str) -> String {
    for q in ['"', '\''] {
        if let Some(rest) = v.strip_prefix(q) {
            // Closing quote may be followed by a comment.
            return match rest.find(q) {
                Some(end) => rest[..end].to_string(),
                None => rest.to_string(),
            };
        }
    }
    // Unquoted: ` #` starts a comment.
    match v.find(" #") {
        Some(i) => v[..i].trim_end().to_string(),
        None => v.to_string(),
    }
}

pub fn to_map(pairs: Vec<(String, String)>) -> BTreeMap<String, String> {
    pairs.into_iter().collect()
}

/// Read and parse a `.env`-style file; `None` if it doesn't exist or can't be read.
pub fn read(path: &Path) -> Option<BTreeMap<String, String>> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > 1024 * 1024 {
        return None;
    }
    fs::read_to_string(path).ok().map(|t| to_map(parse(&t)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_common_forms() {
        let text = r#"
# comment
APP_NAME=Laravel
export DB_HOST=127.0.0.1
DB_PASSWORD="se cret" # trailing
QUOTED='single'
EMPTY=
INLINE=value # note
URL=http://x/#anchor
bad line
1BAD KEY=x
"#;
        let m = to_map(parse(text));
        assert_eq!(m["APP_NAME"], "Laravel");
        assert_eq!(m["DB_HOST"], "127.0.0.1");
        assert_eq!(m["DB_PASSWORD"], "se cret");
        assert_eq!(m["QUOTED"], "single");
        assert_eq!(m["EMPTY"], "");
        assert_eq!(m["INLINE"], "value");
        assert_eq!(m["URL"], "http://x/#anchor");
        assert_eq!(m.len(), 7);
    }
}
