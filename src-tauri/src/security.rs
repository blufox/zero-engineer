//! Vulnerability and end-of-life checks for the packages in your repos and your global tools.
//!
//! - Lockfiles are read locally (composer.lock, package-lock.json, poetry.lock, uv.lock,
//!   Pipfile.lock, pinned requirements*.txt); global npm/composer/cargo/uv tools come
//!   from their package managers.
//! - Only `{ecosystem, name, version}` is sent to api.osv.dev; no paths or repo names.
//!   Framework/runtime support dates come from endoflife.date.
//! - Runs only when asked (Refresh, or the once-a-day launch check in the UI).
//! - `<data>/security/last-scan.json` holds the last report (backed up with app data);
//!   `<data>/security-cache/osv.json` caches advisory details by id + modified time.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::State;

use crate::bootstrap::run;
use crate::logs::project_dirs;
use crate::storage::{atomic_write, data_root, ConfigState};

type CmdResult<T> = Result<T, String>;

const OSV: &str = "https://api.osv.dev/v1";
const EOL_API: &str = "https://endoflife.date/api";
const LAST_SCAN: &str = "security/last-scan.json";
const CACHE: &str = "security-cache/osv.json";
/// EOL within this many days counts as "soon".
const SOON_DAYS: i64 = 90;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct Pkg {
    pub ecosystem: String,
    pub name: String,
    pub version: String,
}

/// Where a package version was found.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Location {
    /// Repo path, or None for a global tool.
    pub repo: Option<String>,
    /// "composer.lock", "backend/uv.lock", "npm -g", ...
    pub file: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Affected {
    pub repo: Option<String>,
    pub file: String,
    pub version: String,
    pub fixed: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub id: String,
    pub aliases: Vec<String>,
    /// critical | high | medium | low | unknown
    pub severity: String,
    pub summary: String,
    pub ecosystem: String,
    pub package: String,
    pub url: String,
    pub advisory: Option<String>,
    pub affected: Vec<Affected>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EolItem {
    /// endoflife.date product: laravel, django, php, python, nodejs.
    pub product: String,
    pub cycle: String,
    pub eol: Option<String>,
    /// eol | soon | ok | unknown
    pub status: String,
    pub latest: Option<String>,
    pub used: Vec<Location>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SecurityReport {
    pub scanned_at: u64,
    pub packages: usize,
    pub findings: Vec<Finding>,
    pub eol: Vec<EolItem>,
    pub notes: Vec<String>,
}

type Found = BTreeMap<Pkg, BTreeSet<Location>>;

// ---------------------------------------------------------------------------
// Lockfile parsers (pure)
// ---------------------------------------------------------------------------

fn pkg(eco: &str, name: &str, version: &str) -> Option<Pkg> {
    let version = version.trim().trim_start_matches(['v', '=']);
    if name.is_empty() || version.is_empty() || !version.starts_with(|c: char| c.is_ascii_digit()) {
        return None;
    }
    let name = if eco == "PyPI" { name.to_lowercase().replace(['_', '.'], "-") } else { name.to_string() };
    Some(Pkg { ecosystem: eco.into(), name, version: version.into() })
}

pub fn parse_composer_lock(text: &str) -> Vec<Pkg> {
    let Ok(v) = serde_json::from_str::<Value>(text) else { return vec![] };
    ["packages", "packages-dev"]
        .iter()
        .flat_map(|k| v[k].as_array().cloned().unwrap_or_default())
        .filter_map(|p| pkg("Packagist", p["name"].as_str()?, p["version"].as_str()?))
        .collect()
}

pub fn parse_package_lock(text: &str) -> Vec<Pkg> {
    let Ok(v) = serde_json::from_str::<Value>(text) else { return vec![] };
    let mut out = vec![];
    if let Some(pkgs) = v["packages"].as_object() {
        for (key, p) in pkgs {
            let Some(idx) = key.rfind("node_modules/") else { continue };
            if p["link"].as_bool() == Some(true) {
                continue;
            }
            let name = p["name"].as_str().unwrap_or(&key[idx + "node_modules/".len()..]);
            out.extend(p["version"].as_str().and_then(|ver| pkg("npm", name, ver)));
        }
    } else {
        fn walk(deps: &Value, out: &mut Vec<Pkg>) {
            let Some(map) = deps.as_object() else { return };
            for (name, d) in map {
                out.extend(d["version"].as_str().and_then(|ver| pkg("npm", name, ver)));
                walk(&d["dependencies"], out);
            }
        }
        walk(&v["dependencies"], &mut out);
    }
    out
}

/// `[[package]]` tables in poetry.lock / uv.lock (skips the editable/virtual root of uv).
pub fn parse_toml_lock(text: &str) -> Vec<Pkg> {
    let mut out = vec![];
    let (mut name, mut version, mut local, mut inside) = (None::<String>, None::<String>, false, false);
    let flush = |name: &mut Option<String>, version: &mut Option<String>, local: bool, out: &mut Vec<Pkg>| {
        if let (Some(n), Some(v), false) = (name.take(), version.take(), local) {
            out.extend(pkg("PyPI", &n, &v));
        }
    };
    let val = |l: &str| l.split_once('=').map(|(_, v)| v.trim().trim_matches('"').to_string());
    for line in text.lines() {
        let l = line.trim();
        if l.starts_with('[') {
            if inside {
                flush(&mut name, &mut version, local, &mut out);
            }
            inside = l == "[[package]]";
            local = false;
            continue;
        }
        if !inside {
            continue;
        }
        if l.starts_with("name =") || l.starts_with("name=") {
            name = val(l);
        } else if l.starts_with("version =") || l.starts_with("version=") {
            version = val(l);
        } else if l.starts_with("source =") && (l.contains("editable") || l.contains("virtual") || l.contains("directory")) {
            local = true;
        }
    }
    if inside {
        flush(&mut name, &mut version, local, &mut out);
    }
    out
}

pub fn parse_pipfile_lock(text: &str) -> Vec<Pkg> {
    let Ok(v) = serde_json::from_str::<Value>(text) else { return vec![] };
    ["default", "develop"]
        .iter()
        .filter_map(|k| v[k].as_object())
        .flat_map(|m| m.iter().filter_map(|(n, d)| pkg("PyPI", n, d["version"].as_str()?)).collect::<Vec<_>>())
        .collect()
}

/// `name==1.2.3` pins; returns (pins, number of unpinned requirement lines).
pub fn parse_requirements(text: &str) -> (Vec<Pkg>, usize) {
    let (mut pins, mut unpinned) = (vec![], 0);
    for line in text.lines() {
        let l = line.split('#').next().unwrap_or("").split(';').next().unwrap_or("").trim();
        if l.is_empty() || l.starts_with('-') || l.contains("://") {
            continue;
        }
        match l.split_once("==") {
            Some((name, ver)) => {
                let name = name.split('[').next().unwrap_or(name).trim();
                match pkg("PyPI", name, ver.split(',').next().unwrap_or(ver)) {
                    Some(p) => pins.push(p),
                    None => unpinned += 1,
                }
            }
            None => unpinned += 1,
        }
    }
    (pins, unpinned)
}

// Global tools, with versions.

pub fn parse_npm_global(text: &str) -> Vec<Pkg> {
    let Ok(v) = serde_json::from_str::<Value>(text) else { return vec![] };
    v["dependencies"].as_object().map(|m| m.iter().filter_map(|(n, d)| pkg("npm", n, d["version"].as_str()?)).collect()).unwrap_or_default()
}

pub fn parse_composer_global(text: &str) -> Vec<Pkg> {
    let Ok(v) = serde_json::from_str::<Value>(text) else { return vec![] };
    v["installed"].as_array().map(|a| a.iter().filter_map(|p| pkg("Packagist", p["name"].as_str()?, p["version"].as_str()?)).collect()).unwrap_or_default()
}

/// `cargo install --list`: "name v1.2.3:" (local path installs skipped).
pub fn parse_cargo_versions(text: &str) -> Vec<Pkg> {
    text.lines()
        .filter(|l| !l.starts_with(char::is_whitespace) && !l.contains(" (/"))
        .filter_map(|l| {
            let mut w = l.split_whitespace();
            pkg("crates.io", w.next()?, w.next()?.trim_end_matches(':'))
        })
        .collect()
}

/// `uv tool list`: "name v1.2.3" lines.
pub fn parse_uv_versions(text: &str) -> Vec<Pkg> {
    text.lines()
        .filter(|l| !l.starts_with('-') && !l.starts_with(char::is_whitespace))
        .filter_map(|l| {
            let mut w = l.split_whitespace();
            pkg("PyPI", w.next()?, w.next()?)
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

fn rel(repo: &Path, file: &Path) -> String {
    file.strip_prefix(repo).unwrap_or(file).to_string_lossy().into_owned()
}

fn collect_repo(repo: &Path, found: &mut Found, notes: &mut Vec<String>) {
    let name = repo.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mut add = |pkgs: Vec<Pkg>, file: &Path| {
        let loc = Location { repo: Some(repo.to_string_lossy().into_owned()), file: rel(repo, file) };
        for p in pkgs {
            found.entry(p).or_default().insert(loc.clone());
        }
    };
    for dir in project_dirs(repo) {
        let read = |f: &str| fs::read_to_string(dir.join(f)).ok();
        if let Some(t) = read("composer.lock") {
            add(parse_composer_lock(&t), &dir.join("composer.lock"));
        }
        if let Some(t) = read("package-lock.json") {
            add(parse_package_lock(&t), &dir.join("package-lock.json"));
        }
        let mut py_lock = false;
        for f in ["poetry.lock", "uv.lock"] {
            if let Some(t) = read(f) {
                add(parse_toml_lock(&t), &dir.join(f));
                py_lock = true;
            }
        }
        if let Some(t) = read("Pipfile.lock") {
            add(parse_pipfile_lock(&t), &dir.join("Pipfile.lock"));
            py_lock = true;
        }
        if !py_lock {
            let mut reqs: Vec<PathBuf> = fs::read_dir(&dir)
                .map(|e| e.filter_map(|e| e.ok()).map(|e| e.path()).collect())
                .unwrap_or_default();
            reqs.retain(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("requirements") && n.ends_with(".txt")));
            reqs.sort();
            for f in reqs {
                let (pins, unpinned) = parse_requirements(&fs::read_to_string(&f).unwrap_or_default());
                if unpinned > 0 {
                    notes.push(format!("{name}: {unpinned} unpinned requirement(s) in {} not checked (pin with == or use a lockfile)", rel(repo, &f)));
                }
                add(pins, &f);
            }
        }
        if read("package.json").is_some() && read("package-lock.json").is_none() {
            let other = ["yarn.lock", "pnpm-lock.yaml", "bun.lockb"].iter().find(|f| dir.join(f).exists());
            if let Some(f) = other {
                notes.push(format!("{name}: {} isn't supported yet; npm packages in {} not checked", f, rel(repo, &dir).trim_end_matches('/')));
            }
        }
    }
}

fn collect_global(found: &mut Found, notes: &mut Vec<String>) {
    let tools: [(&str, &[&str], fn(&str) -> Vec<Pkg>); 4] = [
        ("npm", &["ls", "-g", "--depth=0", "--json"], parse_npm_global),
        ("composer", &["global", "show", "--direct", "--format=json", "--no-ansi"], parse_composer_global),
        ("cargo", &["install", "--list"], parse_cargo_versions),
        ("uv", &["tool", "list"], parse_uv_versions),
    ];
    let results: Vec<(&str, Option<String>, fn(&str) -> Vec<Pkg>)> = std::thread::scope(|s| {
        let handles: Vec<_> = tools.iter().map(|(bin, args, f)| (*bin, s.spawn(move || run(bin, args)), *f)).collect();
        handles.into_iter().map(|(b, h, f)| (b, h.join().ok().flatten(), f)).collect()
    });
    for (bin, out, parse) in results {
        match out {
            Some(t) => {
                let loc = Location { repo: None, file: format!("{bin} global") };
                for p in parse(&t) {
                    found.entry(p).or_default().insert(loc.clone());
                }
            }
            None if crate::bootstrap::find_bin(bin).is_some() => notes.push(format!("Could not list global {bin} packages")),
            None => {}
        }
    }
}

// ---------------------------------------------------------------------------
// Versions and dates
// ---------------------------------------------------------------------------

fn version_key(v: &str) -> Vec<u64> {
    v.split(|c: char| !c.is_ascii_alphanumeric()).map(|p| p.parse().unwrap_or(0)).collect()
}

pub fn cmp_versions(a: &str, b: &str) -> std::cmp::Ordering {
    let (a, b) = (version_key(a), version_key(b));
    for i in 0..a.len().max(b.len()) {
        let o = a.get(i).unwrap_or(&0).cmp(b.get(i).unwrap_or(&0));
        if o.is_ne() {
            return o;
        }
    }
    std::cmp::Ordering::Equal
}

/// Days since 1970-01-01 for a civil date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn parse_date(s: &str) -> Option<i64> {
    let mut p = s.get(..10)?.split('-').map(|x| x.parse::<i64>().ok());
    Some(days_from_civil(p.next()??, p.next()??, p.next()??))
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// "eol" | "soon" | "ok" | "unknown" for an endoflife.date `eol` field on `today` (days since epoch).
pub fn eol_status(eol: &Value, today: i64) -> (&'static str, Option<String>) {
    match eol {
        Value::Bool(true) => ("eol", None),
        Value::Bool(false) => ("ok", None),
        Value::String(s) => match parse_date(s) {
            Some(d) if d <= today => ("eol", Some(s.clone())),
            Some(d) if d - today <= SOON_DAYS => ("soon", Some(s.clone())),
            Some(_) => ("ok", Some(s.clone())),
            None => ("unknown", Some(s.clone())),
        },
        _ => ("unknown", None),
    }
}

/// The endoflife.date release cycle a version belongs to.
pub fn cycle_for(product: &str, version: &str) -> Option<String> {
    let parts: Vec<&str> = version.trim().trim_start_matches('v').split(['.', '-', '+']).collect();
    let major = parts.first().filter(|p| p.chars().all(|c| c.is_ascii_digit()) && !p.is_empty())?;
    let minor = parts.get(1).filter(|p| p.chars().all(|c| c.is_ascii_digit()) && !p.is_empty());
    let two = || minor.map(|m| format!("{major}.{m}"));
    match product {
        "nodejs" => Some(major.to_string()),
        "laravel" if *major != "5" => Some(major.to_string()),
        _ => two(),
    }
}

// ---------------------------------------------------------------------------
// OSV
// ---------------------------------------------------------------------------

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(30))
        .user_agent(concat!("zero-dev-hub/", env!("CARGO_PKG_VERSION")))
        .build()
}

fn normalize_severity(s: &str) -> String {
    match s.to_ascii_lowercase().as_str() {
        "critical" => "critical",
        "high" => "high",
        "moderate" | "medium" => "medium",
        "low" => "low",
        _ => "unknown",
    }
    .into()
}

fn severity_of(v: &Value) -> String {
    let direct = v["database_specific"]["severity"].as_str()
        .or_else(|| v["affected"][0]["database_specific"]["severity"].as_str())
        .or_else(|| v["affected"][0]["ecosystem_specific"]["severity"].as_str());
    normalize_severity(direct.unwrap_or(""))
}

/// The smallest `fixed` version above `installed` for this package (or the last one listed).
pub fn fixed_for(v: &Value, eco: &str, name: &str, installed: &str) -> Option<String> {
    let mut fixes: Vec<String> = v["affected"]
        .as_array()?
        .iter()
        .filter(|a| a["package"]["ecosystem"].as_str() == Some(eco) && a["package"]["name"].as_str().is_some_and(|n| same_name(eco, n, name)))
        .flat_map(|a| a["ranges"].as_array().cloned().unwrap_or_default())
        .filter(|r| r["type"].as_str() != Some("GIT"))
        .flat_map(|r| r["events"].as_array().cloned().unwrap_or_default())
        .filter_map(|e| e["fixed"].as_str().map(|f| f.trim_start_matches('v').to_string()))
        .collect();
    fixes.sort_by(|a, b| cmp_versions(a, b));
    fixes.iter().find(|f| cmp_versions(f, installed).is_gt()).or(fixes.last()).cloned()
}

fn same_name(eco: &str, a: &str, b: &str) -> bool {
    if eco == "PyPI" {
        a.to_lowercase().replace(['_', '.'], "-") == b
    } else {
        a.eq_ignore_ascii_case(b)
    }
}

fn advisory_link(v: &Value) -> Option<String> {
    let refs = v["references"].as_array()?;
    refs.iter()
        .find(|r| r["type"].as_str() == Some("ADVISORY"))
        .or_else(|| refs.first())
        .and_then(|r| r["url"].as_str().map(String::from))
}

/// Build findings from vuln details: one per advisory per package, merging aliases
/// (GHSA and PYSEC ids for the same issue) so each problem shows once.
pub fn build_findings(hits: &BTreeMap<Pkg, Vec<String>>, details: &HashMap<String, Value>, found: &Found) -> Vec<Finding> {
    let mut by_pkg: BTreeMap<(String, String), Vec<(String, &Pkg)>> = BTreeMap::new();
    for (p, ids) in hits {
        for id in ids {
            by_pkg.entry((p.ecosystem.clone(), p.name.clone())).or_default().push((id.clone(), p));
        }
    }
    let mut out = vec![];
    for ((eco, name), list) in by_pkg {
        // Groups of ids that are aliases of each other; GHSA first so it becomes the primary.
        let mut ids: Vec<&String> = list.iter().map(|(id, _)| id).collect::<BTreeSet<_>>().into_iter().collect();
        ids.sort_by_key(|id| (!id.starts_with("GHSA-"), (*id).clone()));
        let mut groups: Vec<(String, BTreeSet<String>)> = vec![];
        for id in ids {
            let mut names: BTreeSet<String> = details.get(id).and_then(|v| v["aliases"].as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
            names.insert(id.clone());
            match groups.iter_mut().find(|(_, g)| !g.is_disjoint(&names)) {
                Some((_, g)) => g.extend(names),
                None => groups.push((id.clone(), names)),
            }
        }
        for (primary, names) in groups {
            let Some(v) = details.get(&primary) else { continue };
            let mut affected = vec![];
            for (id, p) in &list {
                if !names.contains(id) || affected.iter().any(|a: &Affected| a.version == p.version) {
                    continue;
                }
                let fixed = fixed_for(v, &eco, &name, &p.version);
                for loc in found.get(*p).into_iter().flatten() {
                    affected.push(Affected { repo: loc.repo.clone(), file: loc.file.clone(), version: p.version.clone(), fixed: fixed.clone() });
                }
            }
            let mut severity = severity_of(v);
            if severity == "unknown" {
                // An alias (often the GHSA) may carry the severity.
                if let Some(s) = names.iter().filter_map(|n| details.get(n)).map(severity_of).find(|s| s != "unknown") {
                    severity = s;
                }
            }
            let summary = v["summary"].as_str().filter(|s| !s.is_empty())
                .or_else(|| v["details"].as_str().and_then(|d| d.lines().find(|l| !l.trim().is_empty())))
                .unwrap_or("No summary").chars().take(240).collect();
            out.push(Finding {
                id: primary.clone(),
                aliases: names.into_iter().filter(|n| *n != primary).collect(),
                severity,
                summary,
                ecosystem: eco.clone(),
                package: name.clone(),
                url: format!("https://osv.dev/vulnerability/{primary}"),
                advisory: advisory_link(v),
                affected,
            });
        }
    }
    let rank = |s: &str| ["critical", "high", "medium", "low", "unknown"].iter().position(|x| *x == s).unwrap_or(9);
    out.sort_by(|a, b| rank(&a.severity).cmp(&rank(&b.severity)).then(a.package.cmp(&b.package)));
    out
}

fn query_osv(pkgs: &[&Pkg], cache: &mut HashMap<String, Value>) -> CmdResult<(BTreeMap<Pkg, Vec<String>>, HashMap<String, Value>)> {
    let ag = agent();
    let mut hits: BTreeMap<Pkg, Vec<String>> = BTreeMap::new();
    let mut modified: HashMap<String, String> = HashMap::new();
    for chunk in pkgs.chunks(1000) {
        let queries: Vec<Value> = chunk.iter().map(|p| json!({ "package": { "ecosystem": p.ecosystem, "name": p.name }, "version": p.version })).collect();
        let resp: Value = ag.post(&format!("{OSV}/querybatch"))
            .send_json(json!({ "queries": queries }))
            .map_err(|e| format!("Could not reach api.osv.dev: {e}"))?
            .into_json()
            .map_err(|e| format!("Bad response from api.osv.dev: {e}"))?;
        for (p, r) in chunk.iter().zip(resp["results"].as_array().cloned().unwrap_or_default()) {
            for v in r["vulns"].as_array().cloned().unwrap_or_default() {
                let Some(id) = v["id"].as_str() else { continue };
                hits.entry((*p).clone()).or_default().push(id.to_string());
                modified.insert(id.to_string(), v["modified"].as_str().unwrap_or("").to_string());
            }
        }
    }
    // Details: from cache when unchanged, else fetched (8 at a time). Aliases are fetched too,
    // so severity can come from the GHSA entry when the primary id lacks it.
    let mut wanted: BTreeSet<String> = modified.keys().cloned().collect();
    let stale = |id: &String, cache: &HashMap<String, Value>| {
        cache.get(id).is_none_or(|v| modified.get(id).is_some_and(|m| !m.is_empty() && v["modified"].as_str() != Some(m)))
    };
    for _round in 0..2 {
        let todo: Vec<String> = wanted.iter().filter(|id| stale(id, cache)).cloned().collect();
        let queue = std::sync::Mutex::new(todo);
        let out = std::sync::Mutex::new(vec![]);
        std::thread::scope(|s| {
            for _ in 0..8 {
                s.spawn(|| loop {
                    let Some(id) = queue.lock().unwrap().pop() else { break };
                    if let Ok(v) = ag.get(&format!("{OSV}/vulns/{id}")).call().map_err(|_| ()).and_then(|r| r.into_json::<Value>().map_err(|_| ())) {
                        out.lock().unwrap().push((id, v));
                    }
                });
            }
        });
        let fetched: Vec<(String, Value)> = out.into_inner().unwrap();
        for (id, v) in fetched {
            cache.insert(id, v);
        }
        // Second round: GHSA aliases of ids that have no severity themselves.
        let more: BTreeSet<String> = wanted.iter()
            .filter_map(|id| cache.get(id))
            .filter(|v| severity_of(v) == "unknown")
            .flat_map(|v| v["aliases"].as_array().cloned().unwrap_or_default())
            .filter_map(|a| a.as_str().filter(|a| a.starts_with("GHSA-")).map(String::from))
            .filter(|a| !wanted.contains(a))
            .collect();
        if more.is_empty() {
            break;
        }
        wanted.extend(more);
    }
    let details = wanted.iter().filter_map(|id| cache.get(id).map(|v| (id.clone(), v.clone()))).collect();
    Ok((hits, details))
}

// ---------------------------------------------------------------------------
// End of life
// ---------------------------------------------------------------------------

fn machine_runtime(product: &str) -> Option<String> {
    let out = match product {
        "php" => run("php", &["-r", "echo PHP_VERSION;"]),
        "python" => run("python3", &["--version"]),
        "nodejs" => run("node", &["--version"]),
        _ => None,
    }?;
    out.split_whitespace().last().map(|s| s.trim_start_matches('v').to_string())
}

fn eol_usages(repos: &[PathBuf], found: &Found) -> BTreeMap<(String, String), BTreeSet<Location>> {
    let mut uses: BTreeMap<(String, String), BTreeSet<Location>> = BTreeMap::new();
    let mut add = |product: &str, version: &str, loc: Location| {
        if let Some(c) = cycle_for(product, version) {
            uses.entry((product.into(), c)).or_default().insert(loc);
        }
    };
    for (p, locs) in found {
        let product = match (p.ecosystem.as_str(), p.name.as_str()) {
            ("Packagist", "laravel/framework") => "laravel",
            ("PyPI", "django") => "django",
            _ => continue,
        };
        for l in locs.iter().filter(|l| l.repo.is_some()) {
            add(product, &p.version, l.clone());
        }
    }
    for repo in repos {
        for dir in project_dirs(repo) {
            for (file, product) in [(".nvmrc", "nodejs"), (".node-version", "nodejs"), (".python-version", "python")] {
                if let Ok(t) = fs::read_to_string(dir.join(file)) {
                    let loc = Location { repo: Some(repo.to_string_lossy().into_owned()), file: rel(repo, &dir.join(file)) };
                    add(product, t.trim(), loc);
                }
            }
        }
    }
    for product in ["php", "python", "nodejs"] {
        if let Some(v) = machine_runtime(product) {
            add(product, &v, Location { repo: None, file: format!("installed {product} {v}") });
        }
    }
    uses
}

fn check_eol(uses: BTreeMap<(String, String), BTreeSet<Location>>, notes: &mut Vec<String>) -> Vec<EolItem> {
    let ag = agent();
    let today = (now_secs() / 86_400) as i64;
    let products: BTreeSet<String> = uses.keys().map(|(p, _)| p.clone()).collect();
    let mut tables: HashMap<String, Vec<Value>> = HashMap::new();
    for p in products {
        match ag.get(&format!("{EOL_API}/{p}.json")).call().map_err(|e| e.to_string()).and_then(|r| r.into_json::<Vec<Value>>().map_err(|e| e.to_string())) {
            Ok(t) => { tables.insert(p, t); }
            Err(e) => notes.push(format!("Could not load {p} support dates from endoflife.date: {e}")),
        }
    }
    let mut out = vec![];
    for ((product, cycle), used) in uses {
        let Some(table) = tables.get(&product) else { continue };
        let row = table.iter().find(|r| r["cycle"].as_str() == Some(cycle.as_str()));
        let (status, eol) = row.map(|r| eol_status(&r["eol"], today)).unwrap_or(("unknown", None));
        out.push(EolItem {
            product,
            cycle,
            eol,
            status: status.into(),
            latest: row.and_then(|r| r["latest"].as_str().map(String::from)),
            used: used.into_iter().collect(),
        });
    }
    let rank = |s: &str| ["eol", "soon", "unknown", "ok"].iter().position(|x| *x == s).unwrap_or(9);
    out.sort_by(|a, b| rank(&a.status).cmp(&rank(&b.status)).then(a.product.cmp(&b.product)));
    out
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

fn scan(repos: Vec<PathBuf>, cache: &mut HashMap<String, Value>) -> CmdResult<SecurityReport> {
    let mut found = Found::new();
    let mut notes = vec![];
    for r in &repos {
        collect_repo(r, &mut found, &mut notes);
    }
    collect_global(&mut found, &mut notes);
    let pkgs: Vec<&Pkg> = found.keys().collect();
    let (hits, details) = query_osv(&pkgs, cache)?;
    let findings = build_findings(&hits, &details, &found);
    let eol = check_eol(eol_usages(&repos, &found), &mut notes);
    Ok(SecurityReport { scanned_at: now_secs(), packages: found.len(), findings, eol, notes })
}

#[tauri::command]
pub async fn security_scan(state: State<'_, ConfigState>, paths: Vec<String>) -> CmdResult<SecurityReport> {
    let root = data_root(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let cache_file = root.join(CACHE);
        let mut cache: HashMap<String, Value> = fs::read(&cache_file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        let report = scan(paths.into_iter().map(PathBuf::from).collect(), &mut cache)?;
        atomic_write(&cache_file, &serde_json::to_vec(&cache).map_err(|e| e.to_string())?)?;
        atomic_write(&root.join(LAST_SCAN), &serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?)?;
        Ok(report)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn security_last(state: State<ConfigState>) -> CmdResult<Option<SecurityReport>> {
    let file = data_root(&state)?.join(LAST_SCAN);
    Ok(fs::read(file).ok().and_then(|b| serde_json::from_slice(&b).ok()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(p: &[Pkg]) -> Vec<String> {
        p.iter().map(|p| format!("{}:{}@{}", p.ecosystem, p.name, p.version)).collect()
    }

    #[test]
    fn composer() {
        let t = r#"{"packages":[{"name":"laravel/framework","version":"v11.31.0"},{"name":"x/dev","version":"dev-main"}],
                    "packages-dev":[{"name":"phpunit/phpunit","version":"10.5.1"}]}"#;
        assert_eq!(names(&parse_composer_lock(t)), ["Packagist:laravel/framework@11.31.0", "Packagist:phpunit/phpunit@10.5.1"]);
    }

    #[test]
    fn npm_v3_and_v1() {
        let v3 = r#"{"lockfileVersion":3,"packages":{"":{"name":"app"},"node_modules/axios":{"version":"1.6.0"},
            "node_modules/a/node_modules/@scope/b":{"version":"2.0.0"},"node_modules/local":{"link":true}}}"#;
        let mut got = names(&parse_package_lock(v3)); got.sort();
        assert_eq!(got, ["npm:@scope/b@2.0.0", "npm:axios@1.6.0"]);
        let v1 = r#"{"dependencies":{"lodash":{"version":"4.17.20","dependencies":{"minimist":{"version":"1.2.0"}}}}}"#;
        assert_eq!(names(&parse_package_lock(v1)), ["npm:lodash@4.17.20", "npm:minimist@1.2.0"]);
    }

    #[test]
    fn toml_locks() {
        let poetry = "[[package]]\nname = \"Django\"\nversion = \"4.2.1\"\n\n[package.dependencies]\nasgiref = \"*\"\n\n[[package]]\nname = \"zope_interface\"\nversion = \"6.0\"\n\n[metadata]\nx = 1\n";
        assert_eq!(names(&parse_toml_lock(poetry)), ["PyPI:django@4.2.1", "PyPI:zope-interface@6.0"]);
        let uv = "version = 1\n[[package]]\nname = \"myapp\"\nversion = \"0.1.0\"\nsource = { editable = \".\" }\n\n[[package]]\nname = \"requests\"\nversion = \"2.31.0\"\nsource = { registry = \"https://pypi.org/simple\" }\n";
        assert_eq!(names(&parse_toml_lock(uv)), ["PyPI:requests@2.31.0"]);
    }

    #[test]
    fn pipfile_and_requirements() {
        let p = r#"{"default":{"django":{"version":"==5.0.1"}},"develop":{"pytest":{"version":"==8.0.0"}}}"#;
        assert_eq!(names(&parse_pipfile_lock(p)), ["PyPI:django@5.0.1", "PyPI:pytest@8.0.0"]);
        let (pins, unpinned) = parse_requirements("# c\nDjango==5.0.1\nrequests[socks]==2.31.0 ; python_version>'3'\ncelery>=5\n-r base.txt\ngit+https://x/y\n");
        assert_eq!(names(&pins), ["PyPI:django@5.0.1", "PyPI:requests@2.31.0"]);
        assert_eq!(unpinned, 1);
    }

    #[test]
    fn global_tools() {
        assert_eq!(names(&parse_cargo_versions("ripgrep v14.1.0:\n    rg\nmytool v0.1.0 (/home/x/t):\n    t\n")), ["crates.io:ripgrep@14.1.0"]);
        assert_eq!(names(&parse_uv_versions("ruff v0.5.0\n- ruff\n")), ["PyPI:ruff@0.5.0"]);
        assert_eq!(names(&parse_npm_global(r#"{"dependencies":{"npm":{"version":"10.2.0"}}}"#)), ["npm:npm@10.2.0"]);
        assert_eq!(names(&parse_composer_global(r#"{"installed":[{"name":"laravel/installer","version":"v5.8.0"}]}"#)), ["Packagist:laravel/installer@5.8.0"]);
    }

    #[test]
    fn versions_and_cycles() {
        assert!(cmp_versions("1.10.0", "1.9.9").is_gt());
        assert!(cmp_versions("2.0", "2.0.0").is_eq());
        assert_eq!(cycle_for("laravel", "11.31.0").as_deref(), Some("11"));
        assert_eq!(cycle_for("laravel", "5.8.38").as_deref(), Some("5.8"));
        assert_eq!(cycle_for("django", "4.2.16").as_deref(), Some("4.2"));
        assert_eq!(cycle_for("nodejs", "v22.1.0").as_deref(), Some("22"));
        assert_eq!(cycle_for("python", "3.12.3").as_deref(), Some("3.12"));
        assert_eq!(cycle_for("nodejs", "lts/*"), None);
    }

    #[test]
    fn eol_classification() {
        let today = days_from_civil(2026, 11, 3);
        assert_eq!(eol_status(&json!("2026-01-01"), today).0, "eol");
        assert_eq!(eol_status(&json!("2027-01-15"), today).0, "soon");
        assert_eq!(eol_status(&json!("2028-04-01"), today).0, "ok");
        assert_eq!(eol_status(&json!(true), today).0, "eol");
        assert_eq!(eol_status(&json!(false), today).0, "ok");
        assert_eq!(days_from_civil(1970, 1, 1), 0);
    }

    #[test]
    fn findings_merge_aliases_and_pick_fix() {
        let django = Pkg { ecosystem: "PyPI".into(), name: "django".into(), version: "4.2.1".into() };
        let mut found = Found::new();
        found.entry(django.clone()).or_default().insert(Location { repo: Some("/w/shop".into()), file: "uv.lock".into() });
        let hits = BTreeMap::from([(django.clone(), vec!["PYSEC-2024-1".to_string(), "GHSA-aaaa".to_string()])]);
        let ghsa = json!({
            "id": "GHSA-aaaa", "summary": "SQL injection in QuerySet", "aliases": ["CVE-2024-1", "PYSEC-2024-1"],
            "database_specific": { "severity": "HIGH" },
            "affected": [{ "package": { "ecosystem": "PyPI", "name": "Django" }, "ranges": [{ "type": "ECOSYSTEM",
                "events": [{ "introduced": "4.0" }, { "fixed": "4.2.15" }, { "introduced": "5.0" }, { "fixed": "5.0.8" }] }] }],
            "references": [{ "type": "WEB", "url": "https://w" }, { "type": "ADVISORY", "url": "https://nvd/x" }]
        });
        let pysec = json!({ "id": "PYSEC-2024-1", "aliases": ["GHSA-aaaa"], "details": "dup" });
        let details = HashMap::from([("GHSA-aaaa".to_string(), ghsa), ("PYSEC-2024-1".to_string(), pysec)]);
        let f = build_findings(&hits, &details, &found);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].id, "GHSA-aaaa");
        assert_eq!(f[0].severity, "high");
        assert_eq!(f[0].advisory.as_deref(), Some("https://nvd/x"));
        assert_eq!(f[0].affected[0].fixed.as_deref(), Some("4.2.15"));
        assert!(f[0].aliases.contains(&"CVE-2024-1".to_string()));
    }

    /// cargo test security_live -- --ignored --nocapture
    #[test]
    #[ignore]
    fn security_live() {
        let root = crate::paths::expand_home("~/Documents/www");
        let repos: Vec<PathBuf> = fs::read_dir(&root).unwrap().filter_map(|e| e.ok()).flat_map(|g| {
            fs::read_dir(g.path()).map(|e| e.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.join(".git").exists()).collect::<Vec<_>>()).unwrap_or_default()
        }).collect();
        let r = scan(repos, &mut HashMap::new()).unwrap();
        println!("{} packages, {} findings, notes: {:#?}", r.packages, r.findings.len(), r.notes);
        for f in r.findings.iter().take(15) {
            println!("{:8} {} {} — {}", f.severity, f.package, f.id, f.summary);
        }
        for e in &r.eol {
            println!("{} {} {} {:?}", e.product, e.cycle, e.status, e.eol);
        }
    }
}
