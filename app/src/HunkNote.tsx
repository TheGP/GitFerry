import { invoke, isTauri } from "@tauri-apps/api/core";
import { createMemo, createSignal, For, onCleanup, Show, type Accessor } from "solid-js";
import { matchNotesResult, parseNotesResult, rowCode, type Note, type NoteRow } from "./hunkNotes";
import "./hunkNotes.css";

// The repo watcher reloads diffs only when their text changes, so a notes-only change needs its own poll.
// Every open diff of a repository shares one poll.
const shared = new Map<string, { notes: Accessor<Note[]>; error: Accessor<string>; load: (force?: boolean) => Promise<void>; users: number; timer: number }>();
export function refreshHunkNotes(path: string) { return shared.get(path)?.load(true) ?? Promise.resolve(); }

function acquire(repoPath: string) {
  let entry = shared.get(repoPath);
  if (!entry) {
    const [notes, setNotes] = createSignal<Note[]>([]);
    const [error, setError] = createSignal("");
    let text: string | null = null;
    let pending: Promise<void> | null = null;
    const load = (force = false): Promise<void> => {
      if (pending) return force ? pending.then(() => load(true)) : pending;
      if (!force && text !== null && !document.hasFocus()) return Promise.resolve();
      pending = invoke<{ content: string }>("repo_read_notes", { path: repoPath })
        .then(result => {
          const parsed = parseNotesResult(result.content);
          if (result.content !== text) { text = result.content; setNotes(parsed.notes); }
          setError([...parsed.errors.slice(0, 3), ...(parsed.errors.length > 3 ? [`${parsed.errors.length - 3} more invalid note entries`] : [])].join("\n"));
        })
        .catch(cause => { setError(`Could not load change notes: ${String(cause)}`); })
        .finally(() => { pending = null; });
      return pending;
    };
    load();
    entry = { notes, error, load, users: 0, timer: window.setInterval(load, 3000) };
    shared.set(repoPath, entry);
  }
  entry.users++;
  return entry;
}

function release(repoPath: string) {
  const entry = shared.get(repoPath);
  if (entry && --entry.users === 0) { window.clearInterval(entry.timer); shared.delete(repoPath); }
}

export function createHunkNotes(repoPath: () => string, file: () => string, rows: () => NoteRow[], enabled: () => boolean, target: () => string) {
  const source = createMemo(() => {
    if (!enabled() || !isTauri()) return null;
    const path = repoPath();
    const entry = acquire(path);
    onCleanup(() => release(path));
    return entry;
  });
  return createMemo(() => {
    const result = matchNotesResult(source()?.notes() ?? [], file(), rows(), target());
    return { ...result, error: [source()?.error(), ...result.errors].filter(Boolean).join("\n") };
  });
}

// Shown right above the quoted line and starting at the row's left edge like diff lines do; an empty line-number
// column plus the line's own indentation keep the text aligned with its code.
export function HunkNotes(props: { notes: Note[] | undefined; row: NoteRow }) {
  const indent = () => /^\s*/.exec(rowCode(props.row))?.[0] ?? "";
  return <Show when={props.notes?.length}><div class="hunk-notes"><For each={props.notes}>{note => <div class="hunk-note" data-note-id={note.id} title={`Saved note · ${note.id} · Anchored at: ${note.quote}`}><span class="line-number" /><span class="hunk-note-indent">{indent()}</span><span class="hunk-note-text">{note.note}</span></div>}</For></div></Show>;
}
