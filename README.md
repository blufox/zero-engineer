# Zero

A personal developer hub for Linux, built with Tauri 2, React 19, TypeScript and Tailwind 4.
It runs entirely offline. Your content stays on your machine as plain JSON.

- Plan and progress log: [.docs/plan.md](.docs/plan.md)
- Content sources and verification: [.docs/verification.md](.docs/verification.md)

## Features
| Section | What it does |
|---|---|
| **Dev Tools** | JSON, Base64, JWT, UUID, Unix time, Regex, Cron, Hash |
| **Cheat Sheets** | Vim, Git, tmux, Laravel Artisan and Django, each checked against the official docs. You can edit, import and export them |
| **Snippets & Notes** | Code snippets, Markdown notes and TILs in a CodeMirror editor (Vim mode, `:w` saves) |
| **Repositories** | Every git repo under your scan roots, with branch, changes, ahead/behind, stack and open in Vim |
| **Running Servers** | artisan serve, runserver, vite and queue workers, plus Apache/MySQL/Postgres/Redis status, with a Stop button |
| **Glossary** | 149 entries: design patterns (PHP/Python/Dart), smells, refactorings, architecture and principles |
| **Config Backup** | Copies dotfiles into `configs/`, records plugin clones as URL+commit, and scans for secrets before export |

## Getting started
Prerequisites: Node.js 20.19+ or 22.12+ (required by Vite 8), a stable Rust toolchain (edition 2024), and the Tauri system libraries:

```sh
sudo apt install -y libwebkit2gtk-4.1-dev libxdo-dev libayatana-appindicator3-dev librsvg2-dev
```

Then:

```sh
npm install
npm run app
```

## Commands
| Command | What it does |
|---|---|
| `npm run app` | Runs in development mode with hot reload |
| `npm run build` | Type-checks and builds the frontend only |
| `npm run app:build` | Builds the `.deb` into `src-tauri/target/release/bundle/deb/` |
| `npm run app:install` | Builds the `.deb` and installs it (uses `sudo`), so **Zero** appears in your app launcher |
| `cd src-tauri && cargo test --lib` | Runs the Rust tests (live checks: `cargo test -- --ignored --nocapture`) |
| `cd scripts/glossary && python3 patterns.py` | Regenerates the built-in glossary JSON |

## Keyboard
`Ctrl+K` search everything · `/` search in page · `j`/`k` move · `e` edit · `Ctrl+N` new snippet · `Ctrl+S` / `:w` save

## Project layout
```
src/                 React frontend
  app/               shell, layout, command palette, onboarding
  modules/           one folder per section (tools, cheatsheets, snippets, repos, …)
  seed/              built-in cheat sheet and glossary JSON
src-tauri/           Rust backend (storage, repos, servers, config backup)
scripts/glossary/    Python generators for the glossary seed data
.docs/               plan and verification notes
```

## Data
All content is plain JSON in a data folder you choose on first run (e.g. `~/zero-data`).
The folder's location is stored in `~/.config/dev.vivico.zero/app.json`.
Zero never runs git in the data folder, so committing and pushing it is up to you. Settings → App can also save a `.tar.gz` snapshot.

## Security & privacy
- **No accounts, API keys or network services.** The app needs no credentials, and the repo has no `.env`.
- **Tool inputs stay in memory.** Values typed into Dev Tools (JWT secrets, HMAC keys and so on) are never written to disk.
- **Markdown is sanitized.** Notes are rendered with DOMPurify, and links open in your system browser.
- **Config Backup scans for secrets.** It flags private keys, cloud tokens and `*_TOKEN` / `*_SECRET` / `*_PASSWORD` / `*_API_KEY` assignments. Export stays blocked until you skip or acknowledge each flagged file. Before you push a backup repo, keep real secrets in an untracked file such as `~/.secrets` that your shell sources.
- **Repository remotes are cleaned.** Credentials embedded in remote URLs (`https://user:token@host`) are stripped before they are displayed.
- `.gitignore` excludes `.env*`, key/certificate files, build output and caches. If you ever add a secret, put it in `.env.local` (ignored) and commit a `.env.example` instead.
