---
name: change-notes
description: Write GitFerry change notes (.gitferry/notes.jsonl) explaining important code changes. Use ONLY when the user explicitly invokes /change-notes or asks for change notes.
disable-model-invocation: true
---

Explain the important changes of this task in `.gitferry/notes.jsonl` at the repo root (create it if missing). The GitFerry app shows each note next to the diff hunk it describes. Never put these notes in source files.

Write a note ONLY where a reviewer would likely ask "why?":
- behavior change, or a bug fix's root cause
- non-obvious design decision or tradeoff
- workaround, or handling of ordering/race/edge cases
- security or data-integrity implication
- code that looks wrong or unnecessary but is intentional

Do NOT note: renames, formatting, imports, types, simple refactors, tests, obvious code, or anything the code already makes clear. Many changes need no note; a typical task gets 0–3. When unsure, skip.

## Write and verify with MCP

Prefer GitFerry's `write_notes` MCP tool when the repository is open. Read `list_repositories` and `get_diff` first; use the exact checkout's canonical `tabId`, file and diff target. Never switch a branch just to attach a note.

```json
{"repository":"C:/work/my-repo","notes":[{"id":"first-scroll-loop","file":"src/view.ts","target":"staged","side":"new","startLine":42,"quote":"await scrollToNext();","note":"Wait for the viewport update before reading the next batch."}]}
```

- `target` is `working`, `staged`, `untracked`, a full commit SHA, or `baseSHA..headSHA`. For the open comparison, use `get_view.comparison.target` or `target: "compare"`; the tool saves exact merge-base/head SHAs so later branch changes do not inherit the review. Use index line numbers for staged notes. Deletions use `side: "old"`.
- Use separate notes for separate logical changed blocks. Anchor each to its actual behavior, not an import or an unrelated test.
- Repeated quotes need `startLine` and `side`, or exact `before`/`after` adjacent code lines. Ambiguous or missing anchors fail the whole batch.
- `validateOnly: true` checks without writing. Require `confirmed: true` and `written: true` when saving; inspect every returned file/target/side/line.
- After saving, call `reveal_note(repository, id)` for each note. It opens the saved target in Summary, expands the file, scrolls to the note, and returns `note.matched`, `rendered` and `visible`. Require all three plus `confirmed: true`. For an anchor outside ordinary hunk context, use `view: "diff"`.
- Recheck `get_view(noteIds: [id])` before claiming current visibility; it distinguishes saved, matched, rendered and visible, with hidden reasons and `notesError`. Visibility is inside the app viewport; `appFocused` reports focus. A saved note may be collapsed, outside the viewport or in a different comparison.
- `reveal_file` comments are temporary side-editor annotations, never saved Summary notes. Do not substitute them or manual JSONL writes when a saved comparison note is requested. If the running app lacks the tool/schema, report that it needs updating.
- The tool appends records, normalizes notes to LF, and refuses concurrent updates or malformed existing records. Same id updates a note; `{"id":"first-scroll-loop","deleted":true}` removes it.

Fallback if MCP is unavailable: use a UTF-8 writer that preserves existing records and writes LF (avoid PowerShell `Add-Content`/`Out-File` defaults). Validate every JSONL record and quote location, then verify the visible result. Never treat a read error as an empty file. Do not include `.gitferry/` in commits.

Format: append one JSON object per line. Preserve existing records:
{"id":"<short-kebab-slug>","file":"<repo-relative path, forward slashes>","quote":"<distinctive code copied verbatim from ONE line of the new code>","note":"<why, not what; 1 sentence, max 25 words>"}

- quote: part of a single line you added or changed, unique in the file (never `}`, `return;`, `throw error;`). For a pure deletion, quote a deleted line.
- Write notes after the code is final, so quotes match the finished code.
- Before editing a file, grep the notes file for it. If you change code covered by a note, append a line with the same id and updated fields, or {"id":"<id>","deleted":true} if it no longer applies.
