# AI navigation and change notes

[Back to GitFerry](../README.md)

## MCP: AI navigation

In Settings, enable **MCP for AI navigation**, then **Copy MCP configuration** into your AI client's MCP configuration. The app must stay running. The server listens on `127.0.0.1` (default port `39847`); choose a different port for another GitFerry instance. Its bearer token is saved in the OS credential store and is not included in repository files or saved UI settings. The endpoint requires that token and rejects browser Origins.

The server exposes `get_view`, `list_repositories`, `open_repository`, `close_repository`, `reorder_repositories`, `list_branches`, `show_branch`, `search_commits`, `find_changes`, `get_commit`, `get_diff`, `file_history`, `blame`, `reveal_change`, `reveal_file`, `write_notes`, and `reveal_note`. Local and SSH repositories use the same Git services as the app; SSH sign-in questions appear in GitFerry.

`list_repositories` returns each open tab's canonical path as `tabId`, its checked-out `branch`, `head`, active flag, and selected commit. Recent paths appear separately because their current branch is unknown until opened. Pass the matching tab's path as `repository`. `open_repository` reuses existing tabs; its optional `branch` checks the checked-out branch and reports a mismatch rather than changing it. `show_branch` browses a branch's tip without checkout.

`close_repository({"repository":"<tabId>"})` closes a tab without deleting files; unsaved editor changes must be saved or cancelled first. Repeating the command after the tab has closed returns `closed: false`. `reorder_repositories({"repositories":["<tabId B>","<tabId A>"]})` sets the left-to-right order: include every open tab exactly once using the IDs from `list_repositories`. Reordering preserves the active tab and its selections. Both commands save the session and return `confirmed: true` when complete.

For example, after reading a commit diff, an AI can navigate to the evidence with:

```json
{"repository":"C:/work/my-repo","branch":"topic","commit":"<full commit SHA>","file":"src/example.ts","highlights":[{"kind":"lines","side":"new","startLine":42,"endLine":44,"quote":"retry"}]}
```

That is the argument object for `reveal_change`. Line numbers are 1-based and refer to the old or new side of that exact diff. A hunk selection uses `{"kind":"hunk","hunkIndex":0}` (0-based). Multiple ranges in one file are supported. For a merge, supply a `parent` SHA; otherwise the first parent is used. The tool confirms success after the view renders, and fails for missing ranges, mismatched quotes, or truncated diffs. Gold emphasis is separate from staging selections; clear it with **Clear AI highlights**. Working, staged, and untracked targets are also supported. Highlights remain when navigating between files and appear in their expanded Summary cards. Revealing a file replaces that file's highlights; an empty list clears them. Emphasis is hidden if the diff changes. Highlights are temporary, with the last 100 file targets retained until the app closes.

Ask your AI: **“Stage your changes and highlight the staged lines in GitFerry.”** After staging through its usual Git tools with your authorization, it should read `get_diff` with `commit: "staged"`, then call `reveal_change` for each file using the staged diff's line numbers or hunk indexes:

```json
{"repository":"C:/work/my-repo","commit":"staged","file":"src/example.ts","highlights":[{"kind":"lines","side":"new","startLine":42,"endLine":44,"quote":"retry"}]}
```

Use `{"kind":"hunk","hunkIndex":0}` to highlight a whole staged hunk. The index can differ from the working file, so the AI must reread the staged diff after staging. Open **Summary** to review highlights across files together; each revealed file is expanded there. Highlighting does not stage or unstage anything.

To explain existing code, use `reveal_file` even if the file has no changes:

```json
{"repository":"C:/work/my-repo","branch":"topic","file":"src/example.ts","startLine":42,"endLine":44,"quote":"retry","comment":"These checks can finish before the post has loaded."}
```

`branch` selects the file version to browse, without checkout. Alternatively, use `revision` with a full commit SHA, `HEAD` (the default), or `working`; do not supply both `branch` and `revision`. Open the repository first with `open_repository`. The side editor displays the file read-only, scrolls to the 1-based line range, highlights it in gold, and shows the optional explanation. Missing lines, mismatched quotes, binary files, and truncated snapshots fail before replacing the editor. Explanations are temporary UI annotations; they do not modify repository files. Clear them with **Clear AI highlights**. `get_view.editor` reports the file revision and annotation separately from the main diff.

For exact, non-adjacent lines in the same file, use `ranges` in one `reveal_file` call. Each range can have its own `quote` and `comment`; a top-level `comment` explains the whole file. Click a range's line label in the editor to jump to it:

```json
{"repository":"C:/work/my-repo","revision":"staged","file":"src/example.ts","ranges":[{"startLine":12,"endLine":14,"quote":"retry","comment":"Retry only while the request is active."},{"startLine":42,"quote":"abort","comment":"Stop when cancelled."}]}
```

`revision: "staged"` reads the full file from Git's index, including unchanged context, rather than newer working edits. `working` reads the disk file; `untracked` does the same but requires an untracked file. These target names match `reveal_change` and `get_diff` (which use the `commit` parameter for diffs). The response and `get_view.editor.revision` identify `staged` consistently. Committed versions still resolve to full SHAs. Up to 100 ranges are supported; overlaps highlight each line once, without filling the gaps. Do not combine `ranges` with the legacy top-level `startLine`, `endLine`, or `quote`. Existing single-range requests still work. All ranges are verified before replacing the editor. Older SSH agents must be updated for staged file snapshots; they fail explicitly rather than showing working content.

`find_changes` searches literal code introductions/removals using Git `-S`. Rebuild the bundled SSH agents from this source before using code search remotely; an older agent reports that it needs rebuilding. `get_view` includes the active diff's staging selection, text selection, and AI highlights. MCP tools read Git data and navigate; they do not expose commit, checkout, stage, reset, or file-edit actions.

The [GitFerry MCP skill](skills/gitferry-mcp/SKILL.md) teaches agents to choose the correct repository/worktree branch, investigate changes, and reveal verified lines or hunks. Install its folder as `~/.agents/skills/gitferry-mcp` for Codex or `~/.claude/skills/gitferry-mcp` for Claude Code. Invoke it with `$gitferry-mcp` in Codex or `/gitferry-mcp` in Claude Code, or let the agent select it when your request matches. If an existing chat has not loaded native MCP tools, its Python 3.11+ helper calls the same authenticated local server using the saved client configuration without printing tokens. This skill is separate from the change-notes skill below.

## AI change notes

Linked worktrees share a repository tab. The second row shows branch names (detached checkouts show their short commit ID). Hover to see the folder path, and drag tabs to reorder them. Select a checkout in this row; GitFerry remembers the last choice across repository switches and restarts. MCP continues addressing individual checkouts by their canonical paths. `reorder_repositories` requires every open checkout; first occurrences determine repository-group order, while the worktree row keeps its own saved drag order.

`write_notes` validates and saves authorized notes through MCP. Pass `repository` and 1–100 `notes` entries with `id`, `file`, `quote`, `note`, and `target`: `working`, `staged`, `untracked`, a full commit SHA, or `baseSHA..headSHA`. For an open comparison, use `get_view.comparison.target` or `target: "compare"`. The alias is resolved to exact merge-base/head SHAs before saving, so the note cannot silently appear to review a later branch tip. `get_diff` and `reveal_change` also accept these comparison targets as `commit`.

Optional `side`, `startLine`, `before` and `after` disambiguate repeated lines. The response reports every matched file, target, side and line, plus visibility states. `validateOnly: true` checks without writing; same-id entries update notes and `{id,deleted:true}` removes them. Saving appends LF records, checks for concurrent updates, and uses atomic replacement. It never edits source or stages files.

After saving, call `reveal_note({"repository":"<tabId>","id":"retry-abort"})`. It opens the saved comparison/commit or working target without checkout, expands the file in Summary, scrolls to the note, and confirms `note.matched`, `note.rendered`, and `note.visible`. Use `view: "diff"` for an anchor outside normal hunk context. Recheck with `get_view({"noteIds":["retry-abort"]})`: it separates saved, matched, rendered, and visible states, reports hidden reasons and missing IDs, and surfaces `notesError`. Visibility means inside the app viewport, including scroll clipping; `appFocused` reports focus, not whether another window covers GitFerry.

`reveal_file` comments are temporary annotations in the **side editor**, never saved Summary notes. Its response explicitly reports `placement.surface`, `persistent: false`, `shownInSummary: false`, and per-comment rendered/visible states; `get_view.editor.annotationPlacement` reads them back. Use `write_notes` followed by `reveal_note` for a persistent review explanation.

Notes accept LF and CRLF, including mixed endings. Read/parse errors are displayed; a failed refresh retains loaded notes. Ambiguous quotes produce an error rather than attaching to the first occurrence. Legacy quote-only entries remain supported.

SSH hosts need an updated bundled agent for validated note writing and worktree discovery. Older agents retain their existing note reader; mixed-ending files still report an error until the agent is updated. Releases bundle agents for Linux and macOS on x64 and ARM64.

AI coding agents can explain why they changed something, and GitFerry shows each explanation directly above the code it describes in working-tree, staged, committed, and branch-comparison diffs.

Notes live in `.gitferry/notes.jsonl` at the repository root, one JSON object per line:

```json
{"id":"retry-abort","file":"src/sync/remoteSync.ts","quote":"if (signal?.aborted || attempt === retryDelays.length) throw error;","note":"Stop retrying once the user cancels; otherwise a closed tab keeps hitting the host."}
```

- `quote` is verbatim code from one line of the change, so a note follows its code when lines shift. An added line wins over a deleted one, which wins over context. Notes whose quote is no longer in the diff are hidden.
- A later line with the same `id` replaces the note; `{"id":"...","deleted":true}` removes it.
- GitFerry rereads the file every few seconds while focused. Keep `.gitferry/` out of commits, for example in `.git/info/exclude` or your global Git ignore file.

The agent writes notes only when asked. [docs/skills/change-notes/SKILL.md](skills/change-notes/SKILL.md) is the prompt used with Claude Code: copy it to `~/.claude/skills/change-notes/SKILL.md` and run `/change-notes` after a task. For Codex, copy it to `~/.codex/skills/change-notes/SKILL.md` and invoke `$change-notes`.
