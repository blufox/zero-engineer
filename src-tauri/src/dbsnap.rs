//! Local database snapshots: dump a project's MySQL/MariaDB, PostgreSQL or SQLite database
//! before a risky migration and restore it with one click.
//!
//! - The connection is detected from the project (Laravel `.env`; Django `.env`
//!   `DATABASE_URL`/`DB_*`/`POSTGRES_*` or the `DATABASES` dict in settings), or taken
//!   from a manual entry in `<data>/db-connections/<slug>.json` (never holds a password).
//! - Only local servers: hosts other than localhost / 127.0.0.1 / ::1 / a socket are refused.
//! - Passwords go to the client tools through `MYSQL_PWD` / `PGPASSWORD`, never argv,
//!   and are never sent to the frontend.
//! - Dumps live in `<backup>/db-snapshots/<slug>/` (or `<data>/db-snapshots/`), with an
//!   `index.json`. A `.gitignore` keeps them out of git unless the user opts in.

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

use crate::envfile;
use crate::logs::{project_dirs, py_string, resolve_filename_expr, PY_VALUE};
use crate::repos::git;
use crate::storage::{atomic_write, backup_root, data_root, ConfigState};

const SNAP_DIR: &str = "db-snapshots";
const CONN_DIR: &str = "db-connections";
const INDEX: &str = "index.json";
const GITIGNORE: &str = "# Written by Zero: database dumps hold real data and can be large.\n*\n!.gitignore\n";

type CmdResult<T> = Result<T, String>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DbConfig {
    /// "mysql", "pgsql" or "sqlite".
    pub driver: String,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: Option<u16>,
    /// Database name, or the file path for sqlite.
    pub database: String,
    #[serde(default)]
    pub user: String,
    /// Never serialized: see [`DbInfo`] for what the frontend sees.
    #[serde(skip)]
    pub password: Option<String>,
    #[serde(default)]
    pub socket: Option<String>,
}

/// What the frontend sees: no password.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DbInfo {
    pub driver: String,
    pub host: String,
    pub port: Option<u16>,
    pub database: String,
    pub user: String,
    pub has_password: bool,
    /// Where the settings came from, e.g. ".env", "DATABASE_URL", "settings.py", "manual".
    pub source: String,
    /// Folder of the Laravel/Django project inside the repo.
    pub project_dir: String,
    pub local: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub file: String,
    pub label: String,
    /// Seconds since epoch.
    pub created: u64,
    pub size: u64,
    pub driver: String,
    pub database: String,
    pub branch: Option<String>,
    /// Newest migration at snapshot time.
    pub migration: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoDb {
    pub repo: String,
    pub slug: String,
    pub db: Option<DbInfo>,
    pub error: Option<String>,
    pub snapshots: Vec<Snapshot>,
    pub total_size: u64,
}

#[derive(Debug, Deserialize)]
pub struct RepoRef {
    pub path: String,
    pub slug: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbTools {
    pub mysqldump: bool,
    pub mysql: bool,
    pub pg_dump: bool,
    pub pg_restore: bool,
    pub gzip: bool,
    pub snapshots_dir: String,
}

struct Detected {
    cfg: DbConfig,
    source: String,
    project_dir: PathBuf,
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

fn normalize_driver(d: &str) -> Option<&'static str> {
    let d = d.to_ascii_lowercase();
    if d.contains("mysql") || d.contains("mariadb") {
        Some("mysql")
    } else if d.contains("pgsql") || d.contains("postgres") {
        Some("pgsql")
    } else if d.contains("sqlite") {
        Some("sqlite")
    } else {
        None
    }
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `postgres://user:pass@host:5432/name?x=y`, `mysql://...`, `sqlite:///abs/path.db`.
pub fn parse_database_url(url: &str, base: &Path) -> Option<DbConfig> {
    let (scheme, rest) = url.split_once("://")?;
    let driver = normalize_driver(scheme)?;
    let rest = rest.split(['?', '#']).next().unwrap_or("");
    if driver == "sqlite" {
        // Like dj-database-url: sqlite:///rel.db is relative, sqlite:////abs.db is absolute.
        let p = rest.strip_prefix('/').unwrap_or(rest);
        let path = if p.starts_with('/') { PathBuf::from(p) } else { base.join(p) };
        return Some(DbConfig { driver: driver.into(), database: path.to_string_lossy().into_owned(), ..Default::default() });
    }
    let (auth, hostpart) = match rest.rsplit_once('@') {
        Some((a, h)) => (Some(a), h),
        None => (None, rest),
    };
    let (hostport, database) = hostpart.split_once('/').unwrap_or((hostpart, ""));
    let (host, port) = match hostport.rsplit_once(':') {
        Some((h, p)) if !h.ends_with(']') || h.starts_with('[') => (h, p.parse().ok()),
        _ => (hostport, None),
    };
    let (user, password) = match auth {
        Some(a) => match a.split_once(':') {
            Some((u, p)) => (percent_decode(u), Some(percent_decode(p))),
            None => (percent_decode(a), None),
        },
        None => (String::new(), None),
    };
    Some(DbConfig {
        driver: driver.into(),
        host: host.trim_matches(['[', ']']).to_string(),
        port,
        database: percent_decode(database),
        user,
        password: password.filter(|p| !p.is_empty()),
        socket: None,
    })
}

fn laravel_config(dir: &Path, env: &BTreeMap<String, String>) -> Option<DbConfig> {
    let get = |k: &str| env.get(k).cloned().filter(|v| !v.is_empty());
    let driver = normalize_driver(&get("DB_CONNECTION").unwrap_or_else(|| "mysql".into()))?;
    if driver == "sqlite" {
        let db = get("DB_DATABASE").unwrap_or_else(|| "database/database.sqlite".into());
        let path = if db.starts_with('/') { PathBuf::from(db) } else { dir.join(db) };
        return Some(DbConfig { driver: driver.into(), database: path.to_string_lossy().into_owned(), ..Default::default() });
    }
    Some(DbConfig {
        driver: driver.into(),
        host: get("DB_HOST").unwrap_or_else(|| "127.0.0.1".into()),
        port: get("DB_PORT").and_then(|p| p.parse().ok()),
        database: get("DB_DATABASE")?,
        user: get("DB_USERNAME").unwrap_or_default(),
        password: get("DB_PASSWORD"),
        socket: get("DB_SOCKET"),
    })
}

fn django_env_config(dir: &Path, env: &BTreeMap<String, String>) -> Option<(DbConfig, &'static str)> {
    let get = |k: &str| env.get(k).cloned().filter(|v| !v.is_empty());
    if let Some(url) = get("DATABASE_URL") {
        return parse_database_url(&url, dir).map(|c| (c, "DATABASE_URL"));
    }
    if let Some(db) = get("POSTGRES_DB") {
        return Some((DbConfig {
            driver: "pgsql".into(),
            host: get("POSTGRES_HOST").unwrap_or_else(|| "localhost".into()),
            port: get("POSTGRES_PORT").and_then(|p| p.parse().ok()),
            database: db,
            user: get("POSTGRES_USER").unwrap_or_default(),
            password: get("POSTGRES_PASSWORD"),
            socket: None,
        }, ".env"));
    }
    let name = get("DB_NAME").or_else(|| get("DB_DATABASE"))?;
    let driver = normalize_driver(&get("DB_ENGINE").or_else(|| get("DB_CONNECTION")).unwrap_or_else(|| "postgres".into()))?;
    Some((DbConfig {
        driver: driver.into(),
        host: get("DB_HOST").unwrap_or_else(|| "localhost".into()),
        port: get("DB_PORT").and_then(|p| p.parse().ok()),
        database: name,
        user: get("DB_USER").or_else(|| get("DB_USERNAME")).unwrap_or_default(),
        password: get("DB_PASSWORD"),
        socket: None,
    }, ".env"))
}

fn db_key_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(&format!(r#"['"](ENGINE|NAME|USER|PASSWORD|HOST|PORT)['"]\s*:\s*{PY_VALUE}"#)).unwrap())
}

fn django_url_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    // dj_database_url.config(default="postgres://...") / .parse("...")
    RE.get_or_init(|| Regex::new(r#"dj_database_url\.(?:config|parse)\([^)]*?['"]((?:postgres|postgresql|pgsql|mysql|sqlite)[^'"]*)['"]"#).unwrap())
}

/// The `default` entry of `DATABASES = {...}` in Django settings, from literals and env lookups.
fn django_settings_config(dir: &Path, env: &BTreeMap<String, String>) -> Option<DbConfig> {
    let mut files = vec![];
    collect_settings(dir, 0, &mut files);
    files.sort();
    for f in files {
        let Ok(text) = fs::read_to_string(&f) else { continue };
        let Some(start) = text.find("DATABASES") else { continue };
        let block: String = text[start..].chars().take(2000).collect();
        if let Some(c) = django_url_re().captures(&block) {
            if let Some(cfg) = parse_database_url(&c[1], dir) {
                return Some(cfg);
            }
        }
        let mut cfg = DbConfig::default();
        for c in db_key_re().captures_iter(&block) {
            let (key, expr) = (&c[1], &c[2]);
            match key {
                "ENGINE" => {
                    if cfg.driver.is_empty() {
                        cfg.driver = py_string(expr, env).and_then(|e| normalize_driver(&e)).unwrap_or_default().into();
                    }
                }
                "NAME" if cfg.database.is_empty() => {
                    cfg.database = if cfg.driver == "sqlite" {
                        resolve_filename_expr(expr, dir, env).map(|p| p.to_string_lossy().into_owned()).unwrap_or_default()
                    } else {
                        py_string(expr, env).unwrap_or_default()
                    };
                }
                "USER" if cfg.user.is_empty() => cfg.user = py_string(expr, env).unwrap_or_default(),
                "PASSWORD" if cfg.password.is_none() => cfg.password = py_string(expr, env).filter(|p| !p.is_empty()),
                "HOST" if cfg.host.is_empty() => cfg.host = py_string(expr, env).unwrap_or_default(),
                "PORT" if cfg.port.is_none() => {
                    cfg.port = py_string(expr, env).or_else(|| Some(expr.trim().trim_end_matches(',').to_string())).and_then(|p| p.parse().ok())
                }
                _ => {}
            }
        }
        if !cfg.driver.is_empty() && !cfg.database.is_empty() {
            return Some(cfg);
        }
    }
    None
}

fn collect_settings(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for e in entries.filter_map(|e| e.ok()) {
        let p = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        if e.file_type().is_ok_and(|t| t.is_dir()) {
            if depth < 3 && !name.starts_with('.') && !["node_modules", "venv", ".venv", "env", "static", "media", "migrations"].contains(&name.as_str()) {
                collect_settings(&p, depth + 1, out);
            }
        } else if name.ends_with(".py") && (name.starts_with("settings") || p.parent().is_some_and(|d| d.ends_with("settings"))) {
            out.push(p);
        }
    }
}

fn detect(repo: &Path) -> Option<Detected> {
    for dir in project_dirs(repo) {
        let env = envfile::read(&dir.join(".env")).unwrap_or_default();
        if dir.join("artisan").is_file() {
            if let Some(cfg) = laravel_config(&dir, &env) {
                return Some(Detected { cfg, source: ".env".into(), project_dir: dir });
            }
        }
        if dir.join("manage.py").is_file() {
            if let Some((cfg, source)) = django_env_config(&dir, &env) {
                return Some(Detected { cfg, source: source.into(), project_dir: dir });
            }
            if let Some(cfg) = django_settings_config(&dir, &env) {
                return Some(Detected { cfg, source: "settings.py".into(), project_dir: dir });
            }
        }
    }
    None
}

pub fn is_local(cfg: &DbConfig) -> bool {
    cfg.driver == "sqlite"
        || cfg.socket.is_some()
        || matches!(cfg.host.as_str(), "" | "localhost" | "127.0.0.1" | "::1" | "0.0.0.0")
        || cfg.host.starts_with('/')
}

fn info(d: &Detected) -> DbInfo {
    DbInfo {
        driver: d.cfg.driver.clone(),
        host: d.cfg.host.clone(),
        port: d.cfg.port,
        database: d.cfg.database.clone(),
        user: d.cfg.user.clone(),
        has_password: d.cfg.password.is_some(),
        source: d.source.clone(),
        project_dir: d.project_dir.to_string_lossy().into_owned(),
        local: is_local(&d.cfg),
    }
}

/// Manual connection (if saved) wins over detection; the detected password is kept
/// when the manual entry points at the same database.
fn resolve_config(repo: &Path, slug: &str, data: Option<&Path>) -> Option<Detected> {
    let detected = detect(repo);
    let manual: Option<DbConfig> = data
        .and_then(|d| fs::read_to_string(d.join(CONN_DIR).join(format!("{slug}.json"))).ok())
        .and_then(|t| serde_json::from_str(&t).ok());
    match (manual, detected) {
        (Some(mut m), d) => {
            if let Some(d) = &d {
                if d.cfg.database == m.database && d.cfg.user == m.user {
                    m.password = d.cfg.password.clone();
                }
            }
            let project_dir = d.map(|d| d.project_dir).unwrap_or_else(|| repo.to_path_buf());
            Some(Detected { cfg: m, source: "manual".into(), project_dir })
        }
        (None, d) => d,
    }
}

// ---------------------------------------------------------------------------
// Snapshot files
// ---------------------------------------------------------------------------

fn valid_slug(slug: &str) -> CmdResult<()> {
    let ok = !slug.is_empty() && slug.len() <= 120 && slug.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok { Ok(()) } else { Err(format!("Invalid repo id: {slug}")) }
}

fn valid_file(file: &str) -> CmdResult<()> {
    let ok = !file.is_empty() && !file.contains('/') && !file.starts_with('.') && file != INDEX;
    if ok { Ok(()) } else { Err(format!("Invalid snapshot name: {file}")) }
}

fn snapshots_root(state: &State<ConfigState>) -> CmdResult<PathBuf> {
    let base = match backup_root(state)? {
        Some(b) => b,
        None => data_root(state)?,
    };
    Ok(base.join(SNAP_DIR))
}

/// Keep dumps out of git by default; remove our `.gitignore` when the user opts in.
fn ensure_gitignore(root: &Path, commit: bool) -> CmdResult<()> {
    let gi = root.join(".gitignore");
    if commit {
        if fs::read_to_string(&gi).is_ok_and(|t| t == GITIGNORE) {
            fs::remove_file(&gi).map_err(|e| e.to_string())?;
        }
    } else if !gi.exists() {
        fs::create_dir_all(root).map_err(|e| e.to_string())?;
        fs::write(&gi, GITIGNORE).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn read_index(dir: &Path) -> Vec<Snapshot> {
    let mut list: Vec<Snapshot> = fs::read_to_string(dir.join(INDEX))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    // Drop entries whose file was deleted by hand.
    list.retain(|s| dir.join(&s.file).is_file());
    list.sort_by(|a, b| b.created.cmp(&a.created));
    list
}

fn write_index(dir: &Path, list: &[Snapshot]) -> CmdResult<()> {
    atomic_write(&dir.join(INDEX), &serde_json::to_vec_pretty(list).map_err(|e| e.to_string())?)
}

/// UTC `YYYYMMDD-HHMMSS` from epoch seconds (no date crate needed).
pub fn stamp(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // Howard Hinnant's civil-from-days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}{m:02}{d:02}-{:02}{:02}{:02}", rem / 3600, rem % 3600 / 60, rem % 60)
}

fn slugify(s: &str) -> String {
    let out: String = s
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    out.chars().take(40).collect()
}

pub fn snapshot_name(secs: u64, cfg: &DbConfig, label: &str) -> String {
    let db = if cfg.driver == "sqlite" {
        Path::new(&cfg.database).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "sqlite".into())
    } else {
        cfg.database.clone()
    };
    let ext = match cfg.driver.as_str() {
        "mysql" => "sql.gz",
        "pgsql" => "dump",
        _ => "sqlite",
    };
    let label = slugify(label);
    let label = if label.is_empty() { "manual".to_string() } else { label };
    format!("{}Z__{}__{}.{ext}", stamp(secs), slugify(&db), label)
}

fn newest_migration(project: &Path) -> Option<String> {
    // Laravel: timestamped names, so the max name is the newest.
    if let Ok(entries) = fs::read_dir(project.join("database/migrations")) {
        let mut names: Vec<String> = entries.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.ends_with(".php")).collect();
        names.sort();
        if let Some(n) = names.pop() {
            return Some(n.trim_end_matches(".php").to_string());
        }
    }
    // Django: newest file by mtime across <app>/migrations/0*.py.
    let mut best: Option<(SystemTime, String)> = None;
    for app in fs::read_dir(project).ok()?.filter_map(|e| e.ok()) {
        let Ok(migs) = fs::read_dir(app.path().join("migrations")) else { continue };
        for m in migs.filter_map(|e| e.ok()) {
            let name = m.file_name().to_string_lossy().into_owned();
            if !name.ends_with(".py") || !name.starts_with(|c: char| c.is_ascii_digit()) {
                continue;
            }
            if let Ok(t) = m.metadata().and_then(|md| md.modified()) {
                if best.as_ref().is_none_or(|(bt, _)| t > *bt) {
                    best = Some((t, format!("{}.{}", app.file_name().to_string_lossy(), name.trim_end_matches(".py"))));
                }
            }
        }
    }
    best.map(|(_, n)| n)
}

// ---------------------------------------------------------------------------
// Running the client tools
// ---------------------------------------------------------------------------

fn has_tool(bin: &str) -> bool {
    Command::new("sh").args(["-c", &format!("command -v {bin}")]).stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|s| s.success())
}

fn mysql_args(cfg: &DbConfig) -> Vec<String> {
    let mut a = vec![];
    if let Some(s) = &cfg.socket {
        a.push(format!("--socket={s}"));
    } else if !cfg.host.is_empty() {
        a.push(format!("--host={}", cfg.host));
        if let Some(p) = cfg.port { a.push(format!("--port={p}")); }
    }
    if !cfg.user.is_empty() { a.push(format!("--user={}", cfg.user)); }
    a
}

fn pg_args(cfg: &DbConfig) -> Vec<String> {
    let mut a = vec![];
    let host = cfg.socket.clone().unwrap_or_else(|| cfg.host.clone());
    if !host.is_empty() { a.push(format!("--host={host}")); }
    if let Some(p) = cfg.port { a.push(format!("--port={p}")); }
    if !cfg.user.is_empty() { a.push(format!("--username={}", cfg.user)); }
    a.push("--no-password".into());
    a
}

fn with_password(cmd: &mut Command, cfg: &DbConfig) {
    if let Some(pw) = &cfg.password {
        match cfg.driver.as_str() {
            "mysql" => { cmd.env("MYSQL_PWD", pw); }
            "pgsql" => { cmd.env("PGPASSWORD", pw); }
            _ => {}
        }
    }
}

fn stderr_of(child: &mut std::process::Child) -> std::thread::JoinHandle<String> {
    let mut err = child.stderr.take();
    std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(e) = err.as_mut() { let _ = e.read_to_string(&mut s); }
        s
    })
}

fn tool_error(tool: &str, stderr: &str) -> String {
    let msg = stderr.trim();
    if msg.is_empty() { format!("{tool} failed") } else { format!("{tool}: {msg}") }
}

/// Run `producer | consumer` without a shell. Returns (producer stderr, consumer stderr) on failure.
fn pipe(mut producer: Command, mut consumer: Command, names: (&str, &str)) -> CmdResult<()> {
    let mut p = producer.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| format!("Could not start {}: {e}", names.0))?;
    let p_err = stderr_of(&mut p);
    let out = p.stdout.take().ok_or("no stdout")?;
    let mut c = consumer.stdin(Stdio::from(out)).stderr(Stdio::piped()).spawn().map_err(|e| format!("Could not start {}: {e}", names.1))?;
    let c_err = stderr_of(&mut c);
    let ps = p.wait().map_err(|e| e.to_string())?;
    let cs = c.wait().map_err(|e| e.to_string())?;
    let (pe, ce) = (p_err.join().unwrap_or_default(), c_err.join().unwrap_or_default());
    if !ps.success() { return Err(tool_error(names.0, &pe)); }
    if !cs.success() { return Err(tool_error(names.1, &ce)); }
    Ok(())
}

fn dump(cfg: &DbConfig, dest: &Path) -> CmdResult<()> {
    match cfg.driver.as_str() {
        "mysql" => {
            let mut dumpc = Command::new("mysqldump");
            dumpc.args(mysql_args(cfg))
                .args(["--single-transaction", "--routines", "--triggers", "--no-tablespaces", "--databases"])
                .arg(&cfg.database);
            with_password(&mut dumpc, cfg);
            let file = File::create(dest).map_err(|e| e.to_string())?;
            let mut gz = Command::new("gzip");
            gz.arg("-c").stdout(Stdio::from(file));
            pipe(dumpc, gz, ("mysqldump", "gzip"))
        }
        "pgsql" => {
            let mut c = Command::new("pg_dump");
            c.args(pg_args(cfg)).args(["--format=custom", "--file"]).arg(dest).arg(format!("--dbname={}", cfg.database));
            with_password(&mut c, cfg);
            let out = c.output().map_err(|e| format!("Could not start pg_dump: {e}"))?;
            if out.status.success() { Ok(()) } else { Err(tool_error("pg_dump", &String::from_utf8_lossy(&out.stderr))) }
        }
        "sqlite" => {
            let src = Path::new(&cfg.database);
            if !src.is_file() {
                return Err(format!("{} does not exist", src.display()));
            }
            if PathBuf::from(format!("{}-wal", cfg.database)).exists() {
                return Err("The database has an open write-ahead log (-wal). Stop the dev server and try again.".into());
            }
            fs::copy(src, dest).map(|_| ()).map_err(|e| e.to_string())
        }
        d => Err(format!("Unsupported driver: {d}")),
    }
}

fn restore(cfg: &DbConfig, file: &Path) -> CmdResult<()> {
    match cfg.driver.as_str() {
        "mysql" => {
            let mut gz = Command::new("gzip");
            gz.arg("-dc").arg(file);
            let mut m = Command::new("mysql");
            // The dump has `CREATE DATABASE`/`USE` (from --databases), so no db argument.
            m.args(mysql_args(cfg)).stdout(Stdio::null());
            with_password(&mut m, cfg);
            pipe(gz, m, ("gzip", "mysql"))
        }
        "pgsql" => {
            let mut c = Command::new("pg_restore");
            c.args(pg_args(cfg))
                .args(["--clean", "--if-exists", "--no-owner", "--no-privileges", "--single-transaction"])
                .arg(format!("--dbname={}", cfg.database))
                .arg(file);
            with_password(&mut c, cfg);
            let out = c.output().map_err(|e| format!("Could not start pg_restore: {e}"))?;
            if out.status.success() { Ok(()) } else { Err(tool_error("pg_restore", &String::from_utf8_lossy(&out.stderr))) }
        }
        "sqlite" => {
            let dest = Path::new(&cfg.database);
            let tmp = dest.with_extension("zero-restore.tmp");
            fs::copy(file, &tmp).map_err(|e| e.to_string())?;
            fs::rename(&tmp, dest).map_err(|e| e.to_string())
        }
        d => Err(format!("Unsupported driver: {d}")),
    }
}

fn take_snapshot(repo: &Path, dir: &Path, d: &Detected, label: &str) -> CmdResult<Snapshot> {
    if !is_local(&d.cfg) {
        return Err(format!("Refusing to dump {}: only local databases (localhost, 127.0.0.1, sockets) are supported.", d.cfg.host));
    }
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|t| t.as_secs()).unwrap_or(0);
    let file = snapshot_name(now, &d.cfg, label);
    let dest = dir.join(&file);
    let partial = dir.join(format!(".{file}.partial"));
    if let Err(e) = dump(&d.cfg, &partial) {
        let _ = fs::remove_file(&partial);
        return Err(e);
    }
    fs::rename(&partial, &dest).map_err(|e| e.to_string())?;
    let snap = Snapshot {
        size: fs::metadata(&dest).map(|m| m.len()).unwrap_or(0),
        file,
        label: if label.trim().is_empty() { "manual".into() } else { label.trim().chars().take(80).collect() },
        created: now,
        driver: d.cfg.driver.clone(),
        database: d.cfg.database.clone(),
        branch: git(repo, &["rev-parse", "--abbrev-ref", "HEAD"]).ok().map(|b| b.trim().to_string()),
        migration: newest_migration(&d.project_dir),
    };
    let mut list = read_index(dir);
    list.insert(0, snap.clone());
    write_index(dir, &list)?;
    Ok(snap)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

fn blocking<T: Send + 'static>(f: impl FnOnce() -> CmdResult<T> + Send + 'static) -> impl std::future::Future<Output = CmdResult<T>> {
    async move { tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())? }
}

#[tauri::command]
pub async fn db_tools(state: State<'_, ConfigState>) -> CmdResult<DbTools> {
    let dir = snapshots_root(&state)?;
    blocking(move || Ok(DbTools {
        mysqldump: has_tool("mysqldump"),
        mysql: has_tool("mysql"),
        pg_dump: has_tool("pg_dump"),
        pg_restore: has_tool("pg_restore"),
        gzip: has_tool("gzip"),
        snapshots_dir: dir.to_string_lossy().into_owned(),
    })).await
}

#[tauri::command]
pub async fn db_list(state: State<'_, ConfigState>, repos: Vec<RepoRef>) -> CmdResult<Vec<RepoDb>> {
    let root = snapshots_root(&state)?;
    let data = data_root(&state).ok();
    blocking(move || {
        let mut out = vec![];
        for r in repos {
            valid_slug(&r.slug)?;
            let d = resolve_config(Path::new(&r.path), &r.slug, data.as_deref());
            let snapshots = read_index(&root.join(&r.slug));
            if d.is_none() && snapshots.is_empty() {
                continue;
            }
            out.push(RepoDb {
                total_size: snapshots.iter().map(|s| s.size).sum(),
                db: d.as_ref().map(info),
                error: None,
                repo: r.path,
                slug: r.slug,
                snapshots,
            });
        }
        Ok(out)
    }).await
}

#[tauri::command]
pub async fn db_snapshot(
    state: State<'_, ConfigState>,
    repo: String,
    slug: String,
    label: String,
    password: Option<String>,
    commit: bool,
) -> CmdResult<Snapshot> {
    valid_slug(&slug)?;
    let root = snapshots_root(&state)?;
    let data = data_root(&state).ok();
    blocking(move || {
        let repo = PathBuf::from(repo);
        let mut d = resolve_config(&repo, &slug, data.as_deref()).ok_or("No database found for this project")?;
        if password.as_ref().is_some_and(|p| !p.is_empty()) { d.cfg.password = password; }
        ensure_gitignore(&root, commit)?;
        take_snapshot(&repo, &root.join(&slug), &d, &label)
    }).await
}

/// Restore `file`, after taking an automatic "pre-restore" snapshot. Returns that snapshot.
#[tauri::command]
pub async fn db_restore(
    state: State<'_, ConfigState>,
    repo: String,
    slug: String,
    file: String,
    password: Option<String>,
    commit: bool,
) -> CmdResult<Snapshot> {
    valid_slug(&slug)?;
    valid_file(&file)?;
    let root = snapshots_root(&state)?;
    let data = data_root(&state).ok();
    blocking(move || {
        let repo = PathBuf::from(repo);
        let dir = root.join(&slug);
        let snap = read_index(&dir).into_iter().find(|s| s.file == file).ok_or("Snapshot not found")?;
        let mut d = resolve_config(&repo, &slug, data.as_deref()).ok_or("No database found for this project")?;
        if password.as_ref().is_some_and(|p| !p.is_empty()) { d.cfg.password = password; }
        if d.cfg.driver != snap.driver {
            return Err(format!("This is a {} snapshot but the project now uses {}", snap.driver, d.cfg.driver));
        }
        ensure_gitignore(&root, commit)?;
        let pre = take_snapshot(&repo, &dir, &d, "pre-restore")?;
        restore(&d.cfg, &dir.join(&snap.file)).map_err(|e| format!("{e}\n\nYour database before the restore was saved as \"{}\".", pre.file))?;
        Ok(pre)
    }).await
}

#[tauri::command]
pub fn db_delete(state: State<ConfigState>, slug: String, file: String) -> CmdResult<()> {
    valid_slug(&slug)?;
    valid_file(&file)?;
    let dir = snapshots_root(&state)?.join(&slug);
    let mut list = read_index(&dir);
    list.retain(|s| s.file != file);
    let path = dir.join(&file);
    if path.is_file() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    write_index(&dir, &list)
}

/// Keep the newest `keep` snapshots; returns how many were removed.
#[tauri::command]
pub fn db_prune(state: State<ConfigState>, slug: String, keep: usize) -> CmdResult<usize> {
    valid_slug(&slug)?;
    let dir = snapshots_root(&state)?.join(&slug);
    let list = read_index(&dir);
    let (kept, removed) = list.split_at(keep.min(list.len()));
    for s in removed {
        let _ = fs::remove_file(dir.join(&s.file));
    }
    write_index(&dir, kept)?;
    Ok(removed.len())
}

#[tauri::command]
pub fn db_clear(state: State<ConfigState>, slug: String) -> CmdResult<usize> {
    db_prune(state, slug, 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("zero-db-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn parses_database_urls() {
        let base = Path::new("/p");
        let c = parse_database_url("postgres://shop:p%40ss@127.0.0.1:5433/shop_dev?sslmode=disable", base).unwrap();
        assert_eq!((c.driver.as_str(), c.host.as_str(), c.port, c.database.as_str(), c.user.as_str()), ("pgsql", "127.0.0.1", Some(5433), "shop_dev", "shop"));
        assert_eq!(c.password.as_deref(), Some("p@ss"));
        let m = parse_database_url("mysql://root@localhost/app", base).unwrap();
        assert_eq!((m.driver.as_str(), m.port, m.password), ("mysql", None, None));
        assert_eq!(parse_database_url("sqlite:////abs/db.sqlite3", base).unwrap().database, "/abs/db.sqlite3");
        assert_eq!(parse_database_url("sqlite:///db.sqlite3", base).unwrap().database, "/p/db.sqlite3");
        assert!(parse_database_url("redis://x", base).is_none());
    }

    #[test]
    fn detects_laravel_env() {
        let d = tmp("laravel");
        fs::write(d.join("artisan"), "").unwrap();
        fs::write(d.join(".env"), "DB_CONNECTION=mysql\nDB_HOST=127.0.0.1\nDB_PORT=3306\nDB_DATABASE=shop\nDB_USERNAME=root\nDB_PASSWORD=secret\n").unwrap();
        let det = detect(&d).unwrap();
        assert_eq!(det.cfg.database, "shop");
        assert_eq!(det.cfg.password.as_deref(), Some("secret"));
        let i = info(&det);
        assert!(i.has_password && i.local);
        // The password never appears in what the frontend gets.
        assert!(!serde_json::to_string(&i).unwrap().contains("secret"));
        assert!(!serde_json::to_string(&det.cfg).unwrap().contains("secret"));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn detects_django_settings_and_subfolder() {
        let d = tmp("django");
        let api = d.join("backend");
        fs::create_dir_all(api.join("core")).unwrap();
        fs::write(api.join("manage.py"), "").unwrap();
        fs::write(api.join(".env"), "PGPASS=topsecret\n").unwrap();
        fs::write(api.join("core/settings.py"), r#"
DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": os.getenv("DB_NAME", "shop"),
        "USER": "shop",
        "PASSWORD": os.getenv("PGPASS"),
        "HOST": "localhost",
        "PORT": 5432,
    }
}
"#).unwrap();
        let det = detect(&d).unwrap();
        assert_eq!(det.source, "settings.py");
        assert_eq!(det.project_dir, api);
        assert_eq!((det.cfg.driver.as_str(), det.cfg.database.as_str(), det.cfg.port), ("pgsql", "shop", Some(5432)));
        assert_eq!(det.cfg.password.as_deref(), Some("topsecret"));
        fs::write(api.join("core/settings.py"), "DATABASES = {'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': BASE_DIR / 'db.sqlite3'}}").unwrap();
        assert_eq!(detect(&d).unwrap().cfg.database, api.join("db.sqlite3").to_string_lossy());
        let _ = fs::remove_dir_all(&d);
    }

    /// `cargo test -- --ignored --nocapture live_detect`: what's detected in ~/Documents/www.
    #[test]
    #[ignore]
    fn live_detect() {
        let root = crate::paths::expand_home("~/Documents/www");
        for group in fs::read_dir(&root).unwrap().filter_map(|e| e.ok()) {
            for repo in fs::read_dir(group.path()).into_iter().flatten().filter_map(|e| e.ok()) {
                if let Some(d) = detect(&repo.path()) {
                    let i = info(&d);
                    println!("{:<40} {:<7} {:<10} {:<24} pw={} local={} ({})", repo.path().strip_prefix(&root).unwrap().display(),
                        i.driver, i.host, i.database.rsplit('/').next().unwrap(), i.has_password, i.local, i.source);
                }
            }
        }
    }

    /// Run a statement with the cfg's client (`mysql -e` / `psql -c`), on `database` if given.
    fn sql(cfg: &DbConfig, database: Option<&str>, q: &str) -> Result<String, String> {
        let mut c = if cfg.driver == "mysql" {
            let mut c = Command::new("mysql");
            c.args(mysql_args(cfg)).args(["-N", "-B", "-e", q]);
            if let Some(d) = database { c.arg(d); }
            c
        } else {
            let mut c = Command::new("psql");
            c.args(pg_args(cfg)).args(["-tA", "-v", "ON_ERROR_STOP=1", "-c", q]);
            c.arg(format!("--dbname={}", database.unwrap_or("postgres")));
            c
        };
        with_password(&mut c, cfg);
        let out = c.output().map_err(|e| e.to_string())?;
        if out.status.success() { Ok(String::from_utf8_lossy(&out.stdout).trim().to_string()) } else { Err(String::from_utf8_lossy(&out.stderr).into_owned()) }
    }

    /// Round trip on a throwaway `zero_test` database, using the local credentials of the
    /// project in $ZERO_TEST_PROJECT. The project's own database is never touched.
    /// `ZERO_TEST_PROJECT=~/www/app cargo test -- --ignored --nocapture live_round_trip`
    #[test]
    #[ignore]
    fn live_round_trip() {
        let project = PathBuf::from(std::env::var("ZERO_TEST_PROJECT").expect("set ZERO_TEST_PROJECT"));
        let mut d = detect(&project).expect("no database detected");
        assert!(is_local(&d.cfg));
        d.cfg.database = "zero_test".into();
        let cfg = d.cfg.clone();
        let _ = sql(&cfg, None, "DROP DATABASE IF EXISTS zero_test");
        sql(&cfg, None, "CREATE DATABASE zero_test").expect("create db");
        sql(&cfg, Some("zero_test"), "CREATE TABLE orders (id INT PRIMARY KEY, total INT)").unwrap();
        sql(&cfg, Some("zero_test"), "INSERT INTO orders VALUES (1, 100), (2, 250)").unwrap();

        let tmpd = tmp("live");
        let dir = tmpd.join("snaps");
        let snap = take_snapshot(&project, &dir, &d, "before drop").expect("snapshot");
        println!("{} snapshot: {} ({} bytes)", cfg.driver, snap.file, snap.size);
        assert!(snap.size > 0);

        sql(&cfg, Some("zero_test"), "DROP TABLE orders").unwrap();
        restore(&d.cfg, &dir.join(&snap.file)).expect("restore");
        let sum = sql(&cfg, Some("zero_test"), "SELECT SUM(total) FROM orders").unwrap();
        println!("after restore SUM(total) = {sum}");
        assert_eq!(sum, "350");

        sql(&cfg, None, "DROP DATABASE zero_test").unwrap();
        let _ = fs::remove_dir_all(&tmpd);
    }

    #[test]
    fn local_guard() {
        let mk = |h: &str| DbConfig { driver: "mysql".into(), host: h.into(), ..Default::default() };
        assert!(is_local(&mk("127.0.0.1")) && is_local(&mk("localhost")) && is_local(&mk("")));
        assert!(!is_local(&mk("db")) && !is_local(&mk("prod.example.com")) && !is_local(&mk("10.0.0.5")));
    }

    #[test]
    fn names_and_stamps() {
        assert_eq!(stamp(0), "19700101-000000");
        assert_eq!(stamp(1_793_658_600), "20261102-223000");
        assert_eq!(stamp(951_782_400), "20000229-000000");
        let cfg = DbConfig { driver: "mysql".into(), database: "shop_dev".into(), ..Default::default() };
        assert_eq!(snapshot_name(0, &cfg, "Before add_orders!"), "19700101-000000Z__shop-dev__before-add-orders.sql.gz");
        let sq = DbConfig { driver: "sqlite".into(), database: "/p/db.sqlite3".into(), ..Default::default() };
        assert_eq!(snapshot_name(0, &sq, ""), "19700101-000000Z__db__manual.sqlite");
        assert!(valid_file("a.sql.gz").is_ok() && valid_file("../x").is_err() && valid_file(INDEX).is_err());
        assert!(valid_slug("fs-zero").is_ok() && valid_slug("../x").is_err());
    }

    #[test]
    fn sqlite_round_trip_and_prune() {
        let d = tmp("sqlite");
        let repo = d.join("repo");
        fs::create_dir_all(&repo).unwrap();
        let db = repo.join("db.sqlite3");
        fs::write(&db, "v1").unwrap();
        let det = Detected {
            cfg: DbConfig { driver: "sqlite".into(), database: db.to_string_lossy().into_owned(), ..Default::default() },
            source: "test".into(),
            project_dir: repo.clone(),
        };
        let dir = d.join("snaps/repo");
        let s1 = take_snapshot(&repo, &dir, &det, "first").unwrap();
        fs::write(&db, "v2").unwrap();
        restore(&det.cfg, &dir.join(&s1.file)).unwrap();
        assert_eq!(fs::read_to_string(&db).unwrap(), "v1");
        assert_eq!(read_index(&dir).len(), 1);
        fs::write(repo.join("db.sqlite3-wal"), "").unwrap();
        assert!(take_snapshot(&repo, &dir, &det, "x").unwrap_err().contains("write-ahead"));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn gitignore_toggle() {
        let d = tmp("gi");
        ensure_gitignore(&d, false).unwrap();
        assert_eq!(fs::read_to_string(d.join(".gitignore")).unwrap(), GITIGNORE);
        ensure_gitignore(&d, true).unwrap();
        assert!(!d.join(".gitignore").exists());
        // A user-written .gitignore is never removed.
        fs::write(d.join(".gitignore"), "custom\n").unwrap();
        ensure_gitignore(&d, true).unwrap();
        assert!(d.join(".gitignore").exists());
        let _ = fs::remove_dir_all(&d);
    }
}
