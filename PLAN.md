# GitFerry — Sublime Merge–like Git GUI for SSH repos

## Context
Want Sublime Merge UX for both local git folders and repos on remote hosts via SSH (`root@warmer` + path, key auth already set up). Must be fast and run on Win/Mac/Linux. Greenfield project, unrelated to rapidcode code.

## Decisions (confirmed)
- Name: **GitFerry**
- Tauri 2 + Rust core, SolidJS UI
- Remote agent over system `ssh`, auto-uploaded
- Project at `C:\Users\gp\apps\GitFerry`
- Build in 2 phases: read-only first, then write ops
- Dark mode default

## Architecture

**Desktop app: Tauri 2 (Rust backend + web UI)**
- Small binary (~10MB), native webview, runs on all 3 OS.
- Rust does all git/SSH/parsing; UI only renders.
- Commit graph drawn on `<canvas>`, virtualized lists → smooth with 100k+ commits. Graph lane layout computed in Rust (app side, incremental per page), UI just draws.
- Risk: Linux webview (WebKitGTK) slower than Win/Mac → keep DOM small, test early on Linux.
- Why not Electron: heavier, slower start. Why not native Rust GUI (egui/iced/gpui): slower to build diff/text UI, weaker text rendering.

**Transport: system `ssh` + remote agent (VS Code Remote approach)**
- Spawn system OpenSSH (`ssh root@warmer`) → uses `~/.ssh/config`, keys, agent automatically. `warmer` alias just works.
  - Windows: use `C:\Windows\System32\OpenSSH\ssh.exe` (works with Windows ssh-agent service), not Git Bash's ssh.
  - Flags: `-T -o BatchMode=yes -o ServerAliveInterval=15` → never hangs on hidden prompts; errors (unknown host key, locked key) shown in UI with fix hint.
- One SSH connection per tab. Windows OpenSSH has no ControlMaster, so each new `ssh` = ~200-500ms handshake → must reuse one.
- Bootstrap in same single connection: small `sh` script runs `uname -sm`, checks `~/.cache/gitferry/agent-<hash>`; if missing → reads binary from stdin, `chmod 700`, then `exec` agent. JSON-RPC over stdin/stdout after that.
- Agent builds: static musl linux x64 + arm64 (cover almost all servers). Other OS/arch → clear "unsupported" error (no half-working fallback in MVP).
- Agent runs `git` CLI on remote with porcelain/`-z` formats (full git compat, hooks, config), streams results, paginates log.
  - `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C` → no hanging prompts, stable parsing.
  - Big outputs capped (diff > N lines/binary → "show anyway" button).
- Watcher: watch `.git` (HEAD, index, refs) + worktree, debounce ~300ms, then re-run `git status`. Skip ignored dirs (node_modules etc). If inotify limit hit → fall back to refresh on window focus + every few sec. Always refresh on window focus (like Sublime Merge).
- Fetch/pull/push on remote repo run on the server → use server's git creds. Option per connection: SSH agent forwarding (`-A`) so your local keys work there too.
- Local repos: same agent code runs in-process (no SSH), uses local `git` + `notify` crate watcher (Win/Mac/Linux) → one code path, same features.

**Why agent:** 1 connection, batched calls, live refresh, nothing to install manually. Cost: build linux binaries in CI.

**Why fast:** git runs where data is; only small JSON crosses network; everything paginated/lazy (diffs loaded on selection, big files truncated).

**UI:** SolidJS + TypeScript + Vite (fine-grained reactivity, faster than React for big lists).
- Layout = Sublime Merge clone:
  - **Top tab bar**: one tab per repo (`warmer:/srv/app`, local repos), `+` opens connect dialog, drag to reorder, tabs restored on start. Each tab = own agent connection.
  - **Toolbar**: current branch dropdown, search box (`author:` / `path:` / text filters), right side Fetch / Pull / Push / Stash buttons (added in phases as features land).
  - **Left sidebar** (collapsible): Branches, Remotes, Tags, Stashes, Submodules with ahead/behind counts.
  - **Center**: commit list with graph lanes left, then message, author, date. Top row = "Working Directory" with change count.
  - **Right pane**: commit selected → header (hash, author, date, parents) + files list with expandable inline diffs. Working Directory selected → commit message box + Untracked / Unstaged / Staged sections, Stage/Discard per file and per hunk.
  - Resizable splitters; alt layout (details below list) toggle.
- Diff view: custom virtualized DOM view + Shiki highlight in a Web Worker, only visible lines (no Monaco — too heavy).
- Tabs, recent repos, window layout saved in app config dir.
- Keyboard-first: Ctrl+P command palette, arrows/enter nav.
- Dark mode default (Sublime Merge–style dark palette, dark diff/highlight theme); light theme optional toggle. Colors as CSS vars.

## Phases
**Step 0:** ✅ folder created, `git init`, plan saved.

**Phase 1 — read-only (local first, then remote)**
1. Repo scaffold (`app/`, `agent/`, `proto/`), Tauri + Solid boots, dark theme.
2. Agent core (in-process) for local repos: log, refs, show commit, diff, status.
3. Repo tabs + open dialog: Local (folder picker / drag-drop) or Remote (`root@warmer` + path), shared recent list.
4. Log + graph (paginated), refs sidebar, commit details + diff.
5. Working-tree status view + watcher auto-refresh.
6. SSH transport: spawn `ssh`, bootstrap/upload agent, JSON-RPC over stdio → remote tabs get same features.

Local first = fast feedback loop, no server needed to build UI. Remote just swaps transport.

**Phase 2 — write ops**
7. Stage/unstage file & hunk, discard, commit, amend.
8. Fetch/pull/push (progress streamed), checkout/create/delete branch, stash.
9. Search box (message/author/path).

**Later:** line staging, conflict resolver, blame, file history, rebase, agent forwarding UI.

## Project layout
`C:\Users\gp\apps\GitFerry`, own git repo.
```
GitFerry/
  app/        Tauri shell (Rust) + ui/ (Solid + Vite)
  agent/      Rust agent binary (remote + local)
  proto/      shared RPC types (serde)
```
CI: GitHub Actions matrix builds app for Win/Mac/Linux + agent for linux-musl x64/arm64.
Local dev on Windows: agent linux build via `cargo zigbuild` (need to install zig) or build on warmer directly. App bundles agent binaries as Tauri resources.

Toolchain present: cargo 1.97, node 24, pnpm 8, git 2.43, OpenSSH 9.5. Missing: zig, `x86_64-unknown-linux-musl` target, Tauri CLI.

## Verification
- Agent unit tests on fixture repos (merge commits, renames, binary files, unicode paths, empty repo, detached HEAD).
- `cargo tauri dev`, open a local repo, then `root@warmer:/some/repo`.
- Check: log of large repo scrolls smoothly; edit a file on remote → UI updates within ~1s; stage/commit/push round-trips.
- Test on Windows first, then Mac/Linux builds from CI.
