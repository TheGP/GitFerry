---
name: gitferry-mcp
description: Use GitFerry MCP to inspect repository tabs and branches, investigate Git changes, and show changed or unchanged code with exact line highlights and explanations in the desktop app.
---

# GitFerry MCP

Use the configured `gitferry` MCP server's tools to investigate and navigate the running GitFerry app. Discover their actual client tool names and schemas; the names below omit client namespace prefixes. The app must be running with MCP enabled. If this chat has not loaded the server, use the authenticated helper below. This skill covers navigation and investigation; requests to write GitFerry change notes use the separate change-notes skill.

## Choose the repository and branch

- For a request about the current view or selection, call `get_view` to read the active repository, checked-out branch, browsed commit, file, text selection, and line/hunk selection.
- Call `list_repositories` to locate the matching open tab. It returns each tab's `tabId`, canonical `path`, checked-out `branch`, `head`, and active flag. Recent paths are separate and have no verified branch until opened. Tabs represent repository/worktree paths, so two tabs with the same repository name can have different branches.
- Pass the exact matching `tabId` as `repository`. Prefer the user's named repository and branch; use the active view when the request refers to it. Resolve ambiguity from these results before asking the user.
- `open_repository` activates an existing tab or opens an absolute local path or `ssh://host/absolute/path`. Its optional `branch` is an expected checked-out branch: a mismatch fails. Choose the correct worktree path instead of checking out a branch to make a tab match.
- `list_branches` reads local and remote refs. `show_branch` requires `repository` and `branch` and selects that branch's tip commit for browsing. It does not change the checked-out branch. Preserve this distinction in explanations.

## Investigate the change

Choose tools according to the available evidence:

| Goal | Tool and arguments |
| --- | --- |
| Find messages, authors, or changed paths | `search_commits(repository, query, offset)`; queries support `author:name` and `path:file` |
| Find introductions/removals of literal code | `find_changes(repository, query, offset)`; Git pickaxe `-S`, not regex |
| Inspect a candidate and its changed files | `get_commit(repository, commit)` |
| Read the exact file diff and numbered rows | `get_diff(repository, commit, file, parent?)` |
| Trace a file through renames | `file_history(repository, file, revision?, offset)` |
| Read line attribution | `blame(repository, file, revision?, startLine)`; startLine is 1-based, up to 300 lines per call |

Use returned full commit SHAs and file paths. For paged search/history results, follow `hasMore` with the next `offset` when the investigation needs more results. `find_changes` finds changes in occurrence counts; an edit that preserves the count may require file history and diff inspection. Search matches and blame attribution are evidence, not proof that a commit caused the reported problem. Explain the causal code change and any remaining uncertainty.

For a merge, inspect `get_commit`'s parents and pass the appropriate parent SHA to both `get_diff` and `reveal_change`. The default is the first parent. For uncommitted changes, `get_diff` and `reveal_change` accept `working`, `staged`, or `untracked` as `commit`.

## Show the evidence in GitFerry

For explanations of existing code, use `reveal_file`; the file does not need to have a diff. Open the repository first, read its refs with `list_branches`, and use `blame` at the resolved full commit SHA to verify the requested code and line numbers. Then call:

```json
{"repository":"C:/work/my-repo","branch":"topic","file":"src/example.ts","startLine":42,"endLine":44,"quote":"retry","comment":"These checks can finish before the post has loaded."}
```

Unlike `reveal_change`'s checked-out branch check, `reveal_file.branch` selects a local or remote branch to browse without checkout. Alternatively, pass `revision` as a full commit SHA, `HEAD` (default), or `working`; do not combine it with `branch`. Prefer the verified full SHA when refs could move during the investigation. The file opens read-only in the side editor, including unchanged code. Lines are 1-based; `quote` must occur in the highlighted range. `comment` is a plain-text, temporary explanation beside the code, not a repository edit. Require `confirmed: true`, and report the returned resolved `revision`, file, and line range. `get_view.editor` reads back the displayed revision and annotation. **Clear AI highlights** removes the annotation.

When the user asks to show the culprit changes, complete the investigation with `reveal_change`:

1. Read `get_diff` for the exact repository, commit, file, and optional parent to be shown. Use its `rows` to identify the evidence; line numbers refer to file lines, not diff row indexes.
2. Call `reveal_change` with that same target. Include the expected checked-out `branch` when the request names a branch. Highlight the smallest useful code range or hunk.
3. Require a successful response with `confirmed: true` before saying the app selected the commit or highlighted the lines. `get_view` can read back the current selection when needed.

Highlight objects:

```json
{"kind":"lines","side":"new","startLine":42,"endLine":44,"quote":"retry"}
```

```json
{"kind":"hunk","hunkIndex":0,"quote":"retry"}
```

These are examples: replace numbers and quotes with values from the actual diff. Lines are 1-based on the `old` or `new` side; deleted code uses `old`. Hunk indexes are 0-based. The optional `quote` must be a verbatim substring of a single highlighted code line, without the diff prefix. Multiple highlights in one file are supported.

Call shape:

```json
{"repository":"C:/work/my-repo","branch":"topic","commit":"<returned full SHA>","file":"src/example.ts","highlights":[{"kind":"lines","side":"new","startLine":42,"endLine":44,"quote":"retry"}]}
```

AI highlights are gold emphasis, separate from staging selections. The user can remove them with **Clear AI highlights**. Report the selected repository, commit, file, line side/range, and why that code matters. For evidence in several files, reveal the main culprit first and provide the other locations in the explanation; each reveal changes the active file.

## Handle incomplete results

- If native tools are unavailable or the chat reports `unknown MCP server 'gitferry'`, use [scripts/call.py](scripts/call.py) with Python 3.11+ from this installed skill's directory. The helper reads only the saved GitFerry connection, keeps authentication inside the process, and calls the same MCP tools over loopback HTTP. Do not print tokens or put them in commands, messages, or argument files. This fallback does not require restarting Codex or claiming that native tools loaded.

  ```text
  python <installed skill directory>/scripts/call.py tools/list
  python <installed skill directory>/scripts/call.py list_repositories
  python <installed skill directory>/scripts/call.py open_repository --arguments-file <JSON file>
  ```

  Use `--arguments-file` for paths and highlight requests to avoid shell quoting mistakes. Its JSON contains tool arguments only, such as `{"repository":"C:/work/my-repo","branch":"topic"}`. `--client codex` or `--client claude` selects a saved client connection; the default tries Codex first. Read the returned schemas and results as you would native MCP responses, including `isError` and `confirmed`. The same user authorization and repository/branch checks apply. When the user asks to open multiple repositories, continue through the authorized list; do not stop merely because native tool registration is stale.

- For native Codex tool discovery, verify `codex mcp list` contains enabled `gitferry`, then use the app's **Settings > MCP servers > Restart** or restart Codex. A skill being visible does not mean the chat has loaded its MCP server. If the authenticated helper also fails, report the actual connection/authentication error and continue any independent source investigation; do not claim UI navigation succeeded.
- SSH sign-in questions appear in GitFerry. A timeout can require answering that prompt and retrying after the tab is ready. An old SSH agent may report that it needs rebuilding for `find_changes`.
- A branch mismatch, missing range, quote mismatch, or changed view requires rereading the relevant state/diff before retrying. Exact highlights cannot be confirmed on truncated diffs; report the limitation instead of inventing coordinates.
- Navigation does not authorize checkout, staging, commits, resets, or file edits. Continue separately with such actions only when the user's request authorizes them.
