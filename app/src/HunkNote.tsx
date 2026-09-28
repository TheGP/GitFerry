import { invoke, isTauri } from "@tauri-apps/api/core";
import { createMemo, createSignal, For, onCleanup, Show, type Accessor } from "solid-js";
import { matchNotes, notesFile, parseNotes, rowCode, type Note, type NoteRow } from "./hunkNotes";
import "./hunkNotes.css";

// The repo watcher reloads diffs only when their text changes, so a notes-only change needs its own poll.
// Every open diff of a repository shares one poll.
const shared = new Map<string, { notes: Accessor<Note[]>; users: number; timer: number }>();

function acquire(repoPath: string) {
  let entry = shared.get(repoPath);
  if (!entry) {
    const [notes, setNotes] = createSignal<Note[]>([]);
    let text: string | null = null;
    const load = () => {
      if (text !== null && !document.hasFocus()) return;
      void invoke<{ content: string }>("repo_read_file", { path: repoPath, file: notesFile })
        .then(result => result.content, () => "")
        .then(next => { if (next !== text) { text = next; setNotes(parseNotes(next)); } });
    };
    load();
    entry = { notes, users: 0, timer: window.setInterval(load, 3000) };
    shared.set(repoPath, entry);
  }
  entry.users++;
  return entry;
}

function release(repoPath: string) {
  const entry = shared.get(repoPath);
  if (entry && --entry.users === 0) { window.clearInterval(entry.timer); shared.delete(repoPath); }
}

export function createHunkNotes(repoPath: () => string, file: () => string, rows: () => NoteRow[], enabled: () => boolean) {
  const notes = createMemo<Accessor<Note[]>>(() => {
    if (!enabled() || !isTauri()) return () => [];
    const path = repoPath();
    const entry = acquire(path);
    onCleanup(() => release(path));
    return entry.notes;
  });
  return createMemo(() => matchNotes(notes()(), file(), rows()));
}

// Shown right above the quoted line and starting at the row's left edge like diff lines do; an empty line-number
// column plus the line's own indentation keep the text aligned with its code.
export function HunkNotes(props: { notes: Note[] | undefined; row: NoteRow }) {
  const indent = () => /^\s*/.exec(rowCode(props.row))?.[0] ?? "";
  return <Show when={props.notes?.length}><div class="hunk-notes"><For each={props.notes}>{note => <div class="hunk-note" title={`Anchored at: ${note.quote}`}><span class="line-number" /><span class="hunk-note-indent">{indent()}</span><span class="hunk-note-text">{note.note}</span></div>}</For></div></Show>;
}
