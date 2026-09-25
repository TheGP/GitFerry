# GitFerry

GitFerry is a desktop Git client for local working trees and Git repositories on SSH hosts. It uses Tauri 2, SolidJS, and a small Rust agent that runs Git beside the repository.

## Run locally

Requirements: Rust, Node.js, pnpm, Git, and the [Tauri 2 platform prerequisites](https://v2.tauri.app/start/prerequisites/).

```powershell
cd app
pnpm install
pnpm tauri dev
```

Open a local folder, or enter an SSH host and absolute repository path in the Open dialog. SSH connections use the system OpenSSH client and your existing SSH configuration. The remote host must be Linux x64 or arm64 and provide `sh`, `head`, and Git. The appropriate static agent is uploaded to `~/.cache/gitferry` when its content hash is not present.

## Available now

- Repository tabs, recent repositories, branches/remotes/tags/stashes/submodules sidebar, paged commit history and graph, commit details, working-tree status, and diffs.
- File and hunk staging/unstaging, commit/amend, fetch, fast-forward pull, push, branch switching/creation/safe deletion, and stash.
- Commit search by message; prefix with `author:` or `path:` to search those fields.
- Resizable panes with side or bottom details layout, draggable repository tabs, folder drop, and a command palette with Ctrl+P.
- Larger repository labels and a saved theme picker in the top bar: Antigravity Dark, VS Code Dark, Sublime Merge, and Claude Code.
- Quick status polling while focused and a full refresh on focus or Ctrl+R. Ctrl+O opens a repository.

## Build and test

```powershell
cargo test -p gitferry-agent
cd app
pnpm exec tsc --noEmit
pnpm tauri build
```

On a machine with limited free space on the system drive, set `CARGO_TARGET_DIR` to a roomy drive before building. This workspace's Windows release build was verified with `CARGO_TARGET_DIR=D:\GitFerry-build`.
The Windows installer can be built with `pnpm tauri build --bundles nsis --ci`.

The Linux agent binaries are bundled in `app/src-tauri/resources/`. GitHub Actions rebuilds x64 and arm64 agents before compiling the Windows, macOS, and Linux desktop apps. See [PLAN.md](PLAN.md) for the full roadmap.
An arm64 macOS desktop build and all seven agent repository tests passed on a test Mac. The `.app` launched successfully; its temporary build, app bundle, and caches were removed afterward.
The SSH smoke test against the isolated `warmer` repository covered snapshot, diff, stage, commit, search, and push; the pushed bare remote ref was verified against the working repository's HEAD.

## GitHub releases

Pushing a `vX.Y.Z` tag matching the versions in `app/package.json` and `app/src-tauri/tauri.conf.json` runs `.github/workflows/release.yml`. It builds Windows x64 (NSIS), macOS Apple Silicon and Intel (DMG), and Linux x64 (Debian package and AppImage). The release starts as a draft and is published only after all builds succeed. For example, after updating the versions, run `git tag v0.1.1` and `git push origin v0.1.1`.

The macOS bundles use ad-hoc signing and are not notarized; Windows installers are not certificate signed. Operating systems may show an approval warning when installing downloaded builds.

Known gaps against [PLAN.md](PLAN.md): changes are polled rather than pushed by a filesystem watcher; Git command progress is shown after completion; a light theme and diff syntax highlighting are still pending. Conflict resolution, blame, file history, rebase, and agent forwarding are later work in the plan.
