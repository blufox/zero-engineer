//! Running servers: TCP listeners from /proc/net/tcp{,6}, mapped to processes via
//! /proc/<pid>/fd, classified by command line (artisan serve, runserver, vite, ...),
//! and linked to the repo they run from. System services come from systemctl.
//!
//! Processes owned by other users (apache2, mysqld) can't be inspected without root,
//! so their ports are matched to services by well-known port numbers instead.

use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::paths::expand_home;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Listener {
    pub port: u16,
    /// Bind addresses, e.g. ["127.0.0.1", "::1"].
    pub addresses: Vec<String>,
    pub pid: Option<u32>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub pid: u32,
    pub name: String,
    pub cmdline: String,
    pub cwd: Option<String>,
    /// Seconds since the process started.
    pub uptime_secs: u64,
    pub memory_kb: u64,
    /// Detected framework/tool, e.g. "Laravel", "Django", "Vite".
    pub kind: Option<String>,
    /// Short role label, e.g. "artisan serve", "queue:work".
    pub role: Option<String>,
    /// Repo root the process runs from, if inside a git repo.
    pub project_path: Option<String>,
    pub project_name: Option<String>,
    pub ports: Vec<Listener>,
    /// Owned by the current user (so we can stop it).
    pub owned: bool,
    /// What "Stop" should signal. Usually `pid`; for `artisan serve` it's the parent
    /// artisan process, which would otherwise just restart its php -S child.
    pub stop_pid: u32,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ServiceInfo {
    pub unit: String,
    pub label: String,
    pub description: String,
    pub active: String,
    pub sub: String,
    pub ports: Vec<Listener>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServersSnapshot {
    /// Recognised dev servers that listen on a port.
    pub dev_servers: Vec<ProcessInfo>,
    /// Recognised dev processes without a port (queue workers, celery, schedulers).
    pub workers: Vec<ProcessInfo>,
    pub services: Vec<ServiceInfo>,
    /// Everything else that listens: other apps, system daemons, unknown owners.
    pub other: Vec<ProcessInfo>,
    /// Listening ports whose process we can't see and didn't match a service.
    pub unattributed: Vec<Listener>,
}

/// Service units we care about (prefix match) with a friendly label and usual ports.
const SERVICES: &[(&str, &str, &[u16])] = &[
    ("apache2", "Apache", &[80, 443]),
    ("httpd", "Apache", &[80, 443]),
    ("nginx", "Nginx", &[80, 443]),
    ("mysql", "MySQL", &[3306, 33060]),
    ("mariadb", "MariaDB", &[3306]),
    ("postgresql@", "PostgreSQL", &[5432]),
    ("redis-server", "Redis", &[6379]),
    ("redis", "Redis", &[6379]),
    ("memcached", "Memcached", &[11211]),
    ("mongod", "MongoDB", &[27017]),
    ("php", "PHP-FPM", &[9000]),
    ("rabbitmq-server", "RabbitMQ", &[5672, 15672]),
    ("elasticsearch", "Elasticsearch", &[9200]),
    ("meilisearch", "Meilisearch", &[7700]),
    ("mailpit", "Mailpit", &[1025, 8025]),
];

// ---------------------------------------------------------------------------
// /proc parsing
// ---------------------------------------------------------------------------

/// Parse one /proc/net/tcp{,6} file → (inode, port, address) for LISTEN sockets.
fn parse_proc_net(text: &str, v6: bool) -> Vec<(u64, u16, String)> {
    text.lines()
        .skip(1)
        .filter_map(|line| {
            let f: Vec<&str> = line.split_whitespace().collect();
            if f.len() < 10 || f[3] != "0A" {
                return None; // 0A = TCP_LISTEN
            }
            let (addr_hex, port_hex) = f[1].split_once(':')?;
            let port = u16::from_str_radix(port_hex, 16).ok()?;
            let inode = f[9].parse().ok()?;
            Some((inode, port, decode_addr(addr_hex, v6)))
        })
        .collect()
}

/// Kernel prints addresses as little-endian 32-bit words in hex.
fn decode_addr(hex: &str, v6: bool) -> String {
    let bytes: Vec<u8> = (0..hex.len())
        .step_by(2)
        .filter_map(|i| u8::from_str_radix(&hex[i..i + 2], 16).ok())
        .collect();
    let mut ordered = Vec::with_capacity(bytes.len());
    for word in bytes.chunks(4) {
        ordered.extend(word.iter().rev());
    }
    if !v6 && ordered.len() == 4 {
        return format!("{}.{}.{}.{}", ordered[0], ordered[1], ordered[2], ordered[3]);
    }
    if ordered.len() == 16 {
        let mut a = [0u8; 16];
        a.copy_from_slice(&ordered);
        return std::net::Ipv6Addr::from(a).to_string();
    }
    hex.to_string()
}

fn listening_sockets() -> Vec<(u64, u16, String)> {
    let mut out = vec![];
    for (file, v6) in [("/proc/net/tcp", false), ("/proc/net/tcp6", true)] {
        if let Ok(t) = fs::read_to_string(file) {
            out.extend(parse_proc_net(&t, v6));
        }
    }
    out
}

fn pids() -> Vec<u32> {
    fs::read_dir("/proc")
        .map(|d| d.filter_map(|e| e.ok()?.file_name().to_str()?.parse().ok()).collect())
        .unwrap_or_default()
}

/// socket inode → pid, for every process whose fds we can read (our own).
fn socket_owners(pids: &[u32]) -> HashMap<u64, u32> {
    let mut map = HashMap::new();
    for &pid in pids {
        let Ok(fds) = fs::read_dir(format!("/proc/{pid}/fd")) else { continue };
        for fd in fds.filter_map(|e| e.ok()) {
            if let Ok(target) = fs::read_link(fd.path()) {
                let t = target.to_string_lossy();
                if let Some(inode) = t.strip_prefix("socket:[").and_then(|s| s.strip_suffix(']')) {
                    if let Ok(i) = inode.parse() {
                        map.insert(i, pid);
                    }
                }
            }
        }
    }
    map
}

fn my_uid() -> Option<u32> {
    proc_uid("self")
}

fn proc_uid(pid: &str) -> Option<u32> {
    fs::read_to_string(format!("/proc/{pid}/status"))
        .ok()?
        .lines()
        .find_map(|l| l.strip_prefix("Uid:"))?
        .split_whitespace()
        .next()?
        .parse()
        .ok()
}

fn cmdline(pid: u32) -> Vec<String> {
    fs::read(format!("/proc/{pid}/cmdline"))
        .map(|b| {
            b.split(|c| *c == 0)
                .filter(|s| !s.is_empty())
                .map(|s| String::from_utf8_lossy(s).into_owned())
                .collect()
        })
        .unwrap_or_default()
}

fn uptime_secs(pid: u32) -> u64 {
    // Field 22 of /proc/<pid>/stat is start time in clock ticks since boot (USER_HZ = 100 on Linux).
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).unwrap_or_default();
    let after_comm = stat.rsplit_once(')').map(|(_, r)| r).unwrap_or("");
    let start_ticks: u64 = after_comm.split_whitespace().nth(19).and_then(|v| v.parse().ok()).unwrap_or(0);
    let sys_uptime: f64 = fs::read_to_string("/proc/uptime")
        .ok()
        .and_then(|u| u.split_whitespace().next()?.parse().ok())
        .unwrap_or(0.0);
    (sys_uptime - start_ticks as f64 / 100.0).max(0.0) as u64
}

fn memory_kb(pid: u32) -> u64 {
    fs::read_to_string(format!("/proc/{pid}/status"))
        .ok()
        .and_then(|s| {
            s.lines()
                .find_map(|l| l.strip_prefix("VmRSS:"))
                .and_then(|v| v.split_whitespace().next()?.parse().ok())
        })
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/// Recognise dev tooling from the command line. Returns (kind, role).
///
/// Only the program and its first couple of arguments are inspected (the
/// interpreter + script, or `python -m module`), so a shell or editor whose
/// arguments merely *mention* "celery" or "manage.py" isn't misclassified.
pub fn classify(args: &[String], cwd: Option<&Path>) -> Option<(String, String)> {
    let base = |a: &str| a.rsplit('/').next().unwrap_or(a).to_string();
    let bin = args.first().map(|a| base(a)).unwrap_or_default();
    let head: Vec<String> = args.iter().take(3).map(|a| base(a)).collect();
    let head_is = |n: &str| head.iter().any(|h| h == n);
    let module = args.iter().position(|a| a == "-m").and_then(|i| args.get(i + 1)).map(String::as_str);
    let after = |n: &str| args.iter().position(|a| base(a) == n).and_then(|i| args.get(i + 1)).cloned().unwrap_or_default();
    let r = |k: &str, role: &str| Some((k.to_string(), role.trim().to_string()));
    let is_php = bin.starts_with("php");
    let is_py = bin.starts_with("python") || head_is("python") || head_is("python3");

    if is_php && head_is("artisan") {
        return r("Laravel", &format!("artisan {}", after("artisan")));
    }
    if is_php && args.iter().any(|a| a == "-S") {
        // `artisan serve` runs its server as a `php -S ... Illuminate/Foundation/resources/server.php` child.
        if args.iter().any(|a| a.contains("Illuminate/Foundation") || a.ends_with("/server.php")) {
            return r("Laravel", "artisan serve");
        }
        return r("PHP", "php -S");
    }
    if is_py && head_is("manage.py") {
        return r("Django", &format!("manage.py {}", after("manage.py")));
    }
    let py_kind = if cwd.is_some_and(|c| c.join("manage.py").exists()) { "Django" } else { "Python" };
    for server in ["gunicorn", "uvicorn", "daphne", "hypercorn"] {
        if bin == server || (is_py && (head_is(server) || module == Some(server))) {
            return r(py_kind, server);
        }
    }
    if bin == "celery" || (is_py && (head_is("celery") || module == Some("celery"))) {
        let sub = ["worker", "beat", "flower"].into_iter().find(|s| args.iter().any(|a| a == s)).unwrap_or("worker");
        return r(py_kind, &format!("celery {sub}"));
    }
    if bin == "flask" || (is_py && module == Some("flask")) {
        return r("Flask", "flask run");
    }
    if bin == "puma" || bin == "rails" || ((bin == "ruby" || bin == "bundle") && (head_is("rails") || head_is("puma"))) {
        return r("Rails", "rails server");
    }
    if bin == "sidekiq" || ((bin == "ruby" || bin == "bundle") && head_is("sidekiq")) {
        return r("Rails", "sidekiq");
    }
    if bin.starts_with("node") || bin == "bun" || bin == "deno" {
        for (needle, kind, role) in [
            ("vite", "Vite", "vite"), ("next", "Next.js", "next dev"), ("nuxt", "Nuxt", "nuxt dev"),
            ("astro", "Astro", "astro dev"), ("webpack", "Webpack", "webpack serve"),
            ("nodemon", "Node", "nodemon"), ("ts-node", "Node", "ts-node"), ("tsx", "Node", "tsx"),
        ] {
            if head_is(needle) || args.iter().take(3).any(|a| a.contains(&format!("node_modules/{needle}/"))) {
                return r(kind, role);
            }
        }
        return r("Node", "node");
    }
    if bin == "flutter" || head.iter().any(|h| h.starts_with("flutter_tools")) {
        return r("Flutter", "flutter run");
    }
    if bin == "mailpit" || bin == "MailHog" {
        return r("Mail", "mail catcher");
    }
    None
}

/// Walk up from `dir` to the nearest folder containing .git.
fn repo_root(dir: &Path) -> Option<PathBuf> {
    dir.ancestors().find(|d| d.join(".git").exists()).map(Path::to_path_buf)
}

fn process_info(pid: u32, uid: Option<u32>, roots: &[PathBuf]) -> Option<ProcessInfo> {
    let args = cmdline(pid);
    if args.is_empty() {
        return None; // kernel thread or already gone
    }
    let cwd = fs::read_link(format!("/proc/{pid}/cwd")).ok();
    let name = fs::read_to_string(format!("/proc/{pid}/comm")).unwrap_or_default().trim().to_string();
    let classified = classify(&args, cwd.as_deref());
    // Only link to a project when the process runs somewhere inside the workspace.
    let project = cwd
        .as_deref()
        .filter(|c| roots.iter().any(|r| c.starts_with(r)))
        .and_then(repo_root);
    Some(ProcessInfo {
        pid,
        name,
        cmdline: args.join(" "),
        cwd: cwd.map(|c| c.to_string_lossy().into_owned()),
        uptime_secs: uptime_secs(pid),
        memory_kb: memory_kb(pid),
        kind: classified.as_ref().map(|c| c.0.clone()),
        role: classified.map(|c| c.1),
        project_name: project.as_ref().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().into_owned()),
        project_path: project.map(|p| p.to_string_lossy().into_owned()),
        ports: vec![],
        owned: uid.is_some() && proc_uid(&pid.to_string()) == uid,
        stop_pid: parent_pid(pid)
            .filter(|pp| cmdline(*pp).iter().any(|a| a == "serve") && cmdline(*pp).iter().any(|a| a.ends_with("artisan")))
            .unwrap_or(pid),
    })
}

fn systemd_services() -> Vec<(String, String, String, String)> {
    let Ok(out) = Command::new("systemctl")
        .args(["list-units", "--type=service", "--all", "--no-legend", "--plain", "--no-pager"])
        .output()
    else {
        return vec![];
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| {
            let mut f = l.split_whitespace();
            let unit = f.next()?.trim_end_matches(".service").to_string();
            let load = f.next()?;
            let active = f.next()?.to_string();
            let sub = f.next()?.to_string();
            let desc = f.collect::<Vec<_>>().join(" ");
            (load == "loaded").then_some((unit, active, sub, desc))
        })
        .collect()
}

fn service_label(unit: &str) -> Option<(&'static str, &'static [u16])> {
    SERVICES.iter().find(|(prefix, _, _)| {
        if *prefix == "php" { unit.starts_with("php") && unit.ends_with("-fpm") } else { unit.starts_with(prefix) }
    }).map(|(_, label, ports)| (*label, *ports))
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_servers(roots: Vec<String>) -> Result<ServersSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let roots: Vec<PathBuf> = roots.iter().map(|r| expand_home(r.trim())).collect();
        let uid = my_uid();
        let all_pids = pids();
        let owners = socket_owners(&all_pids);

        // Group listeners by (pid, port), merging v4/v6 addresses.
        let mut by_key: BTreeMap<(Option<u32>, u16), Vec<String>> = BTreeMap::new();
        for (inode, port, addr) in listening_sockets() {
            let addrs = by_key.entry((owners.get(&inode).copied(), port)).or_default();
            if !addrs.contains(&addr) { addrs.push(addr); }
        }

        let mut procs: BTreeMap<u32, ProcessInfo> = BTreeMap::new();
        let mut unowned: Vec<Listener> = vec![];
        for ((pid, port), addresses) in by_key {
            let listener = Listener { port, addresses, pid };
            match pid {
                Some(pid) => {
                    if !procs.contains_key(&pid) {
                        match process_info(pid, uid, &roots) {
                            Some(info) => { procs.insert(pid, info); }
                            None => { unowned.push(listener); continue; } // exited meanwhile
                        }
                    }
                    procs.get_mut(&pid).expect("inserted above").ports.push(listener);
                }
                None => unowned.push(listener),
            }
        }

        // Non-listening dev processes owned by us (workers, schedulers).
        let mut workers = vec![];
        let self_pid = std::process::id();
        for &pid in &all_pids {
            if procs.contains_key(&pid) || pid == self_pid {
                continue;
            }
            if uid.is_none() || proc_uid(&pid.to_string()) != uid {
                continue;
            }
            let args = cmdline(pid);
            let joined = args.join(" ");
            let looks_like_worker = ["queue:work", "queue:listen", "schedule:work", "horizon", "reverb:start", "celery", "sidekiq", "pail"]
                .iter()
                .any(|k| joined.contains(k));
            // Require a positive classification so shells/editors that merely mention
            // "queue:work" in their arguments don't show up.
            if looks_like_worker
                && let Some(info) = process_info(pid, uid, &roots).filter(|i| i.kind.is_some())
                // The `artisan serve` parent has no port of its own; its child is listed instead.
                && is_not_serve_parent(&info)
            {
                workers.push(info);
            }
        }

        // Services: match unowned ports to service units by well-known port.
        let mut services = vec![];
        let units = systemd_services();
        for (unit, active, sub, desc) in &units {
            let Some((label, ports)) = service_label(unit) else { continue };
            // Skip umbrella units like postgresql.service when a real cluster unit exists.
            if sub == "exited" && units.iter().any(|(u, ..)| u != unit && u.starts_with(unit.as_str())) {
                continue;
            }
            let mine: Vec<Listener> = unowned.iter().filter(|l| ports.contains(&l.port)).cloned().collect();
            unowned.retain(|l| !ports.contains(&l.port) || active != "active");
            services.push(ServiceInfo {
                unit: unit.clone(),
                label: label.to_string(),
                description: desc.clone(),
                active: active.clone(),
                sub: sub.clone(),
                ports: if active == "active" { mine } else { vec![] },
            });
        }
        services.sort_by(|a, b| (a.active != "active").cmp(&(b.active != "active")).then(a.label.cmp(&b.label)));

        let (mut dev_servers, mut other): (Vec<_>, Vec<_>) =
            procs.into_values().partition(|p| p.kind.is_some() && p.owned);
        let sort = |v: &mut Vec<ProcessInfo>| v.sort_by_key(|p| p.ports.first().map(|l| l.port).unwrap_or(u16::MAX));
        sort(&mut dev_servers);
        sort(&mut other);
        unowned.sort_by_key(|l| l.port);

        Ok(ServersSnapshot { dev_servers, workers, services, other, unattributed: unowned })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Send SIGTERM (or SIGKILL with `force`) to a process we own.
#[tauri::command]
pub fn stop_process(pid: u32, force: bool) -> Result<(), String> {
    let me = std::process::id();
    if pid == me || pid <= 1 {
        return Err("Refusing to stop this process".into());
    }
    // Don't let the app kill its own ancestors (e.g. `tauri dev` / the terminal running it).
    let mut cur = me;
    while let Some(parent) = parent_pid(cur) {
        if parent == pid {
            return Err("That process is running Zero itself".into());
        }
        if parent <= 1 { break; }
        cur = parent;
    }
    if proc_uid(&pid.to_string()) != my_uid() {
        return Err("That process belongs to another user (use systemctl / sudo)".into());
    }
    let sig = if force { "-KILL" } else { "-TERM" };
    let out = Command::new("kill").args([sig, &pid.to_string()]).output().map_err(|e| e.to_string())?;
    if out.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&out.stderr).trim().to_string()) }
}

#[tauri::command]
pub fn process_alive(pid: u32) -> bool {
    Path::new(&format!("/proc/{pid}")).exists()
}

fn is_not_serve_parent(info: &ProcessInfo) -> bool {
    info.role.as_deref() != Some("artisan serve")
}

fn parent_pid(pid: u32) -> Option<u32> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    stat.rsplit_once(')')?.1.split_whitespace().nth(1)?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a(s: &str) -> Vec<String> { s.split(' ').map(String::from).collect() }

    #[test]
    fn classifies_common_dev_servers() {
        let c = |s: &str| classify(&a(s), None).map(|(k, r)| format!("{k}|{r}"));
        assert_eq!(c("php artisan serve --port=8001").unwrap(), "Laravel|artisan serve");
        assert_eq!(c("/usr/bin/php8.4 artisan queue:work --tries=3").unwrap(), "Laravel|artisan queue:work");
        assert_eq!(c("python3 manage.py runserver 0.0.0.0:8000").unwrap(), "Django|manage.py runserver");
        assert_eq!(c("/home/u/venv/bin/python /home/u/venv/bin/gunicorn app.wsgi").unwrap(), "Python|gunicorn");
        assert_eq!(c("node /w/app/node_modules/.bin/vite").unwrap(), "Vite|vite");
        assert_eq!(c("php -S localhost:8080 -t public").unwrap(), "PHP|php -S");
        assert_eq!(c("/usr/bin/php8.4 -S 127.0.0.1:8000 /w/app/vendor/laravel/framework/src/Illuminate/Foundation/resources/server.php").unwrap(),
            "Laravel|artisan serve");
        assert_eq!(c("celery -A mysite worker -l info").unwrap(), "Python|celery worker");
        // ServeCommand (Laravel 13) prefers a project-root server.php over the vendored one.
        assert_eq!(c("/usr/bin/php8.4 -S 127.0.0.1:8000 /w/app/server.php").unwrap(), "Laravel|artisan serve");
        assert_eq!(c("python -m uvicorn app:app --reload").unwrap(), "Python|uvicorn");
        assert_eq!(c("celery -A mysite beat -l INFO").unwrap(), "Python|celery beat");
        assert_eq!(c("node /w/app/node_modules/vite/bin/vite.js --port 5173").unwrap(), "Vite|vite");
        assert!(c("/usr/bin/steam").is_none());
        // A shell whose script text mentions these words must not be classified.
        assert!(c("/usr/bin/zsh -c echo celery manage.py artisan queue:work").is_none());
    }

    #[test]
    fn parses_proc_net_tcp() {
        let v4 = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n   0: 0100007F:0CEA 00000000:0000 0A 00000000:00000000 00:00000000 00000000   125        0 31337 1 0000000000000000 100 0 0 10 0\n   1: 0100007F:0CEB 0100007F:1234 01 00000000:00000000 00:00000000 00000000   125        0 31338 1\n";
        let r = parse_proc_net(v4, false);
        assert_eq!(r, vec![(31337, 3306, "127.0.0.1".to_string())]);
        let v6 = "  sl  local_address rem_address st\n   0: 00000000000000000000000001000000:1538 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 0 42 1\n";
        assert_eq!(parse_proc_net(v6, true), vec![(42, 5432, "::1".to_string())]);
    }
}

#[cfg(test)]
mod live {
    /// Print what's running right now: `cargo test live_snapshot -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_snapshot() {
        let s = tauri::async_runtime::block_on(super::list_servers(vec!["~/Documents/www".into()])).unwrap();
        for p in &s.dev_servers {
            println!("DEV  :{:?} {:?} {:?} pid={} project={:?} up={}s mem={}KB",
                p.ports.iter().map(|l| l.port).collect::<Vec<_>>(), p.kind, p.role, p.pid, p.project_name, p.uptime_secs, p.memory_kb);
        }
        for p in &s.workers { println!("WORK {:?} {:?} {:?}", p.kind, p.role, p.project_name); }
        for v in &s.services { println!("SVC  {} ({}) {} {} ports={:?}", v.label, v.unit, v.active, v.sub, v.ports.iter().map(|l| l.port).collect::<Vec<_>>()); }
        for p in &s.other { println!("OTH  {} {:?} owned={}", p.name, p.ports.iter().map(|l| l.port).collect::<Vec<_>>(), p.owned); }
        println!("UNATTRIBUTED {:?}", s.unattributed.iter().map(|l| (l.port, l.addresses.clone())).collect::<Vec<_>>());
    }
}
