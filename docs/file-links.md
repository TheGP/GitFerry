# Open files from Remote Codex and other apps

Installed GitFerry handles this URL on macOS and Windows:

```text
gitferry://open?file=<URL-encoded absolute path>&line=77&column=1
```

`file` is required. `line` and `column` are optional positive, **1-based** integers and default to 1. Columns count Unicode code points, including tabs as one character; they are not visual cells or UTF-16 offsets. A column immediately after the last character is valid. CRLF and CR line endings are normalized for navigation. Out-of-range positions produce an error instead of jumping somewhere else.

Encode each query value exactly once using `URLSearchParams` or `encodeURIComponent`. Spaces, Unicode, `#`, `%`, `&`, and literal `+` characters are supported. A literal plus must be `%2B`; an unescaped `+` in a query means a space. Do not concatenate an unescaped path into the URL or double-encode it. Duplicate or unknown parameters, invalid UTF-8/percent encoding, fragments, and control characters are rejected.

## Remote Codex integration

Generate an ordinary clickable link. No MCP server, configuration, token, annotation, or localhost endpoint is involved:

```javascript
function gitferryLink(absolutePath, line = 1, column = 1, repository) {
  const query = new URLSearchParams({
    file: absolutePath,
    line: String(line),
    column: String(column),
  });
  if (repository !== undefined) query.set("repository", repository);
  return `gitferry://open?${query}`;
}

gitferryLink("/Users/eugene/Projects/My Repo/src/example.ts", 77, 1);
gitferryLink("C:\\Projects\\My Repo\\src\\example.ts", 77, 1);
```

GitFerry opens or activates the correct repository/worktree tab and displays the **working file** in its normal editable side editor. Unchanged, modified, and untracked text files work without a diff or commit. The caret moves to the requested position, the line scrolls into view, and a brief highlight identifies it. Repeated clicks navigate again and renew the highlight. A closed application launches first; requests received during startup wait for the UI.

Opening a link never checks out a branch, stages a file, saves edits, or executes file contents. Saving requires a separate explicit editor action. The existing text editor's UTF-8, regular-file, and 1 MiB limits apply. Missing files and files outside a Git working tree produce clear errors.

Unsaved edits in the same working file stay loaded when navigating to a new position. If another file has unsaved edits, or a modal operation is underway, incoming links remain queued. A status banner explains that saving or cancelling those edits, or finishing the operation, resumes navigation. No link automatically discards or saves an editor buffer.

## Local and SSH paths

A bare absolute `file` path always refers to **this computer**, regardless of the active repository tab. GitFerry resolves symlinks and discovers the nearest Git working tree from the file's real location. Nested repositories and linked worktrees are kept separate. An optional `repository` parameter names the exact checkout root; a mismatch is an error.

For a remote file, specify its SSH location explicitly in either of these forms:

```javascript
// An absolute remote file plus an explicit SSH repository:
gitferryLink("/srv/My Repo/src/example.ts", 77, 1,
  "ssh://user@host/srv/My Repo");

// An SSH file URL; discover its nearest repository on that host:
gitferryLink("ssh://user@host/srv/My Repo/src/example.ts", 77, 1);
```

Encode the complete `file` and `repository` values with the same query builder. Within these values, use the real path, including spaces and literal `%` characters; do not separately percent-encode the inner SSH path. SSH hosts use GitFerry's existing `ssh://[user@]host/absolute/path` format, including SSH configuration aliases. Use an SSH config alias for custom ports. If both values are SSH URLs, their hosts must match. An SSH file cannot be paired with a local repository, and a local-looking path becomes remote only when `repository` explicitly supplies the SSH host. Existing SSH credentials and host-key prompts still apply.

## Installation and validation

The macOS application bundle declares the `gitferry` URL scheme; install the app in `/Applications`. The Windows installer registers the scheme, and GitFerry also registers it for the current user when launched. On either platform, single-instance handling delivers subsequent clicks to the running window.

Examples for testing a generated URL:

```sh
# macOS
open 'gitferry://open?file=%2FUsers%2Feugene%2FProjects%2FMy%20Repo%2Fsrc%2Fexample.ts&line=77&column=1'
```

```powershell
# Windows
Start-Process 'gitferry://open?file=C%3A%5CProjects%5CMy%20Repo%5Csrc%5Cexample.ts&line=77&column=1'
```

CI runs URL/parser and repository-discovery tests, a real-agent browser suite for caret/highlight and unsaved-buffer behavior, and `scripts/test_native_file_links.py` against installed macOS and Windows bundles. The native smoke test uses the OS handler with MCP disabled and covers cold start/restart, warm and repeated clicks, encoded/Unicode paths, clean/modified/untracked files, nested repositories/worktrees, invalid targets, and unchanged repository files, branches, and index. It is guarded to run only in disposable GitHub Actions profiles because it installs the app and resets its settings. The native pending queue accepts up to 128 requests and 64 KiB per URL; overflow is reported explicitly.
