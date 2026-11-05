# Development and releases

[Back to GitFerry](../README.md)

## Run locally

Requirements: Rust, Node.js, pnpm, Git, and the [Tauri 2 platform prerequisites](https://v2.tauri.app/start/prerequisites/).

```powershell
cd app
pnpm install
pnpm tauri dev
```

Open a local folder, or enter an SSH host and absolute repository path in the Open dialog. SSH connections use the system OpenSSH client and your existing SSH configuration. The remote host must be Linux or macOS (x64 or arm64) and provide `sh`, `head`, and Git. On macOS, enable Remote Login and install the Xcode Command Line Tools or Homebrew Git. The matching agent is uploaded to `~/.cache/gitferry` when its content hash is not present.

## Test and build

From the repository root:

```powershell
cargo test -p gitferry-agent
cd app
pnpm exec tsc --noEmit
pnpm test:unit
pnpm test:ui
pnpm tauri build
```

`pnpm test:ui` uses headless Chrome and disposable Git repositories. It clicks through staging, commits, fetch/pull/push, branches, merge/rebase conflicts, tags, stash, diffs, themes, and layouts without opening a desktop window. Set `CHROME_PATH` if Chrome is installed elsewhere. Optionally set `GITFERRY_REAL_REPO` to inspect a large local repository in read-only mode.

The worktree RPC regression test can use an older Git installation: set `GITFERRY_TEST_GIT_BIN_DIR` to its executable directory, then run `cargo test -p gitferry-agent --test worktrees rpc_snapshots`. This changes Git only for the child test process; it covers relative metadata paths and the legacy worktree listing used by older macOS Git.

Set `CARGO_TARGET_DIR` to a roomy drive before building if the system drive has limited space. The Windows installer can be built with `pnpm tauri build --bundles nsis --ci`.

### Regenerate README screenshots

The showcase uses the same headless browser and real agent RPC as the UI tests. It creates fictional Harbor repositories and local remote refs; it never opens your desktop repositories. Its branch comparison, change notes, MCP explanation, and staging controls are real rendered UI.

Build the agent first, then run from `app/`:

```powershell
$env:GITFERRY_README_SHOWCASE = '1'
pnpm test:ui
Remove-Item Env:GITFERRY_README_SHOWCASE
```

The output prints the screenshot folder. Inspect its four PNG files before copying them to `docs/images/`. Test repositories are removed when the harness exits. Set `GITFERRY_AGENT_PATH` when running the harness directly with an agent built outside the default target directory.

## GitHub releases

Dependency review for native file links (2026-11-05): the Rust audit identified a build-time environment leak in `libz-sys`; its lockfile entry is patched to 1.1.31. The existing pnpm audit also reports advisories in Seroval's SSR/deserialization code and development tooling (`vite`, `source-map-js`, and Puppeteer's `zod`). The native opening path and shipped browser entry points do not call those affected SSR/deserialization or development-server APIs. Those broader dependency updates are deferred to a separate maintenance change; review again by 2026-11-19. This is a reachability assessment, not a clean dependency audit.

The SSH agent binaries are bundled in `app/src-tauri/resources/`. Pushes and pull requests run frontend checks and agent tests on Linux.

Run the Build GitFerry workflow manually for the full Windows, macOS, and Linux desktop matrix, or select its `agents_only` input to rebuild only the SSH agents.

The Test Windows file-link installer workflow reruns the native smoke test without recompiling. It selects an existing installer only when its application sources match the checked-out revision; build that revision first if no matching installer is available. Normal builds and releases also run the installed-app tests.

Pushing a `vX.Y.Z` tag matching the versions in `app/package.json` and `app/src-tauri/tauri.conf.json` runs [release.yml](../.github/workflows/release.yml). It builds Windows x64 (NSIS), macOS Apple Silicon and Intel (DMG), and Linux x64 (Debian package and AppImage). The release starts as a draft and is published only after all builds succeed.

The macOS bundles use ad-hoc signing and are not notarized; Windows installers are not certificate signed.

## Current limits

Interactive rebase planning supports linear history only. Syntax colors cover common source and configuration formats. A filesystem watcher that cannot be established falls back to an 8-second status check while the window is focused.

See [PLAN.md](../PLAN.md) for the roadmap.
