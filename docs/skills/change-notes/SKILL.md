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

Format: append one JSON object per line. Never edit or rewrite existing lines:
{"id":"<short-kebab-slug>","file":"<repo-relative path, forward slashes>","quote":"<distinctive code copied verbatim from ONE line of the new code>","note":"<why, not what; 1 sentence, max 25 words>"}

- quote: part of a single line you added or changed, unique in the file (never `}`, `return;`, `throw error;`). For a pure deletion, quote a deleted line.
- Write notes after the code is final, so quotes match the finished code.
- Before editing a file, grep the notes file for it. If you change code covered by a note, append a line with the same id and updated fields, or {"id":"<id>","deleted":true} if it no longer applies.
