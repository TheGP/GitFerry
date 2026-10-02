# AI navigation and change notes

[Back to GitFerry](../README.md)

## MCP: AI navigation

In Settings, enable **MCP for AI navigation**, then **Copy MCP configuration** into your AI client's MCP configuration. The app must stay running. The server listens on `127.0.0.1` (default port `39847`); choose a different port for another GitFerry instance. Its bearer token is saved in the OS credential store and is not included in repository files or saved UI settings. The endpoint requires that token and rejects browser Origins.

The server exposes `get_view`, `list_repositories`, `open_repository`, `list_branches`, `show_branch`, `search_commits`, `find_changes`, `get_commit`, `get_diff`, `file_history`, `blame`, `reveal_change`, and `reveal_file`. Local and SSH repositories use the same Git services as the app; SSH sign-in questions appear in GitFerry.

`list_repositories` returns each open tab's canonical path as `tabId`, its checked-out `branch`, `head`, active flag, and selected commit. Recent paths appear separately because their current branch is unknown until opened. Pass the matching tab's path as `repository`. `open_repository` reuses existing tabs; its optional `branch` checks the checked-out branch and reports a mismatch rather than changing it. `show_branch` browses a branch's tip without checkout.

For example, after reading a commit diff, an AI can navigate to the evidence with:

```json
{"repository":"C:/work/my-repo","branch":"topic","commit":"<full commit SHA>","file":"src/example.ts","highlights":[{"kind":"lines","side":"new","startLine":42,"endLine":44,"quote":"retry"}]}
```

That is the argument object for `reveal_change`. Line numbers are 1-based and refer to the old or new side of that exact diff. A hunk selection uses `{"kind":"hunk","hunkIndex":0}` (0-based). Multiple ranges in one file are supported. For a merge, supply a `parent` SHA; otherwise the first parent is used. The tool confirms success after the view renders, and fails for missing ranges, mismatched quotes, or truncated diffs. Gold emphasis is separate from staging selections; clear it with **Clear AI highlights**. Working, staged, and untracked targets are also supported. Emphasis disappears if the diff changes.

To explain existing code, use `reveal_file` even if the file has no changes:

```json
{"repository":"C:/work/my-repo","branch":"topic","file":"src/example.ts","startLine":42,"endLine":44,"quote":"retry","comment":"These checks can finish before the post has loaded."}
```

`branch` selects the file version to browse, without checkout. Alternatively, use `revision` with a full commit SHA, `HEAD` (the default), or `working`; do not supply both `branch` and `revision`. Open the repository first with `open_repository`. The side editor displays the file read-only, scrolls to the 1-based line range, highlights it in gold, and shows the optional explanation. Missing lines, mismatched quotes, binary files, and truncated snapshots fail before replacing the editor. Explanations are temporary UI annotations; they do not modify repository files. Clear them with **Clear AI highlights**. `get_view.editor` reports the file revision and annotation separately from the main diff.

`find_changes` searches literal code introductions/removals using Git `-S`. Rebuild the bundled SSH agents from this source before using code search remotely; an older agent reports that it needs rebuilding. `get_view` includes the active diff's staging selection, text selection, and AI highlights. MCP tools read Git data and navigate; they do not expose commit, checkout, stage, reset, or file-edit actions.

The [GitFerry MCP skill](skills/gitferry-mcp/SKILL.md) teaches agents to choose the correct repository/worktree branch, investigate changes, and reveal verified lines or hunks. Install its folder as `~/.agents/skills/gitferry-mcp` for Codex or `~/.claude/skills/gitferry-mcp` for Claude Code. Invoke it with `$gitferry-mcp` in Codex or `/gitferry-mcp` in Claude Code, or let the agent select it when your request matches. If an existing chat has not loaded native MCP tools, its Python 3.11+ helper calls the same authenticated local server using the saved client configuration without printing tokens. This skill is separate from the change-notes skill below.

## AI change notes

AI coding agents can explain why they changed something, and GitFerry shows each explanation directly above the code it describes in working-tree, staged, and branch-comparison diffs.

Notes live in `.gitferry/notes.jsonl` at the repository root, one JSON object per line:

```json
{"id":"retry-abort","file":"src/sync/remoteSync.ts","quote":"if (signal?.aborted || attempt === retryDelays.length) throw error;","note":"Stop retrying once the user cancels; otherwise a closed tab keeps hitting the host."}
```

- `quote` is verbatim code from one line of the change, so a note follows its code when lines shift. An added line wins over a deleted one, which wins over context. Notes whose quote is no longer in the diff are hidden.
- A later line with the same `id` replaces the note; `{"id":"...","deleted":true}` removes it.
- GitFerry rereads the file every few seconds while focused. Keep `.gitferry/` out of commits, for example in `.git/info/exclude` or your global Git ignore file.

The agent writes notes only when asked. [docs/skills/change-notes/SKILL.md](skills/change-notes/SKILL.md) is the prompt used with Claude Code: copy it to `~/.claude/skills/change-notes/SKILL.md` and run `/change-notes` after a task. For Codex, copy it to `~/.codex/skills/change-notes/SKILL.md` and invoke `$change-notes`.
