# Read benchmark: Git CLI vs gitoxide vs libgit2

GitFerry refreshes on every file change: `state` (branch, HEAD, status, refs fingerprint) after each change and
`snapshot` (plus refs, stashes, remotes and a history page) when refs move. With the Git CLI each refresh started
5 to 13 `git` processes, and on Windows every process start costs 25–50 ms before Git does any work.

The agent now serves these reads in-process with [gitoxide](https://github.com/GitoxideLabs/gitoxide) (`gix`),
and falls back to the Git CLI if gitoxide cannot read a repository. Writes (commit, push, stash, rebase…) still
run `git`, so hooks, signing, credentials and filters keep working exactly as before.

## Results

Windows 11, 12 logical cores, Git for Windows 2.43 (`core.fscache=true`). Median of 15 runs, in milliseconds.
gitoxide and libgit2 times include opening the repository, as the agent does for every request.

| repository | files / commits / refs | `state`: git → gitoxide (libgit2) | `snapshot`: git → gitoxide (libgit2) |
|---|---|---:|---:|
| GitFerry | 69 / 47 / 15 | 42.9 → **9.8** (3.8) | 105.3 → **14.0** (10.0) |
| rapidcode/scheduler | 1,060 / 2,943 / 420 | 57.8 → **22.0** (21.1) | 273.3 → **34.7** (62.0) |
| rapidcode/browser-automation | 601 / 1,911 / 206 | 63.8 → **27.4** (15.4) | 230.0 → **35.4** (42.7) |
| rapidcode/tdata_decrypter | 17 / 8,358 / 4 | 49.8 → **5.5** (1.2) | 110.4 → **6.5** (13.2) |
| synthetic, 50k files in 3.2k directories | 50,000 / 5,183 / 283 | 146.6 → **135.9** (210.7) | 368.7 → **115.0** (237.9) |
| synthetic, 50k files in 24k directories | 50,000 / 5,183 / 283 | 341.2 → 566.7 (1293.6) | 462.5 → 583.8 (1348.9) |

gitoxide returned exactly the same data as the Git CLI on every repository above (the tool checks this before timing).

Per-read medians for `rapidcode/scheduler`:

| read | git CLI | gitoxide | libgit2 |
|---|---:|---:|---:|
| HEAD and branch | 50.2 | 2.2 | 0.1 |
| status (`-uall`) | 34.6 | 17.5 | 14.6 |
| refs + ahead/behind + stashes | 89.6 | 13.0 | 21.6 |
| history page (100 commits) | 44.0 | 19.2 | 18.9 |
| history page at offset 2000 | 53.4 | 28.1 | 19.9 |

## Why gitoxide

- **Same output as Git.** Status, refs, ahead/behind, stash list, history order (including Git's tie-breaking between
  commits with equal dates) and `%D` decorations match the CLI; `agent/tests/read_parity.rs` checks this for merges,
  tags, upstreams, stashes, worktrees, conflicts, renames, intent-to-add files, nested repositories and junctions.
- **Pure Rust.** The Linux musl agents keep building with `rust-lld` and no C toolchain. libgit2 needs a C compiler
  per target (it lives only in this benchmark crate).
- **Faster where it matters.** libgit2 wins a few small-repository reads by a millisecond or two, but is 2× slower on
  large working trees, orders history differently from Git, and has no notion of Git's stash-helper hiding.

## Limits

- On a working tree with very many small directories (the 24k-directory case), Git's Windows file-system cache still
  beats gitoxide's status, which enumerates directories once for tracked and once for untracked files.
- Stash helper commits count as reachable from a branch only if the branch history newer than the helper (minus a
  day of clock skew) contains them; the CLI searched all history.
- The agent binary grows from 1.5 MB to 5.8 MB (Windows release), which is the one-time upload size for SSH hosts.
- Each request opens the repository again (about 1 ms, plus about 9 ms to read a 50k-entry index). Keeping a handle
  open would keep pack files and `packed-refs` memory-mapped, which on Windows stops Git from replacing them.

## Running it

```bash
cargo build --release -p gitferry-bench
target/release/gitferry-bench run --iterations 15 <repository>...
target/release/gitferry-bench generate <new-directory> 50000 5000
```

`generate` writes a synthetic repository (branches, tags, upstreams, a stash with untracked files and uncommitted work).
Set `GITFERRY_READS=git` or `GITFERRY_READS=gix` to pin the agent to one implementation.
