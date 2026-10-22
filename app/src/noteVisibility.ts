import { noteMatchesTarget, resolveNote, type Note, type NoteRow } from "./hunkNotes.ts";

export type NoteView = { file: string; target: string; rows: NoteRow[]; element: HTMLElement };

/** Visibility inside the app viewport, including scroll clipping; not OS-level window occlusion. */
export function inAppViewport(element: HTMLElement | null): boolean {
  if (!element?.isConnected || !element.getClientRects().length) return false;
  const rect = element.getBoundingClientRect();
  let left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right);
  let top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
  for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0) return false;
    const clip = parent.getBoundingClientRect();
    if (parent !== element && /auto|scroll|hidden|clip/.test(style.overflowX)) { left = Math.max(left, clip.left); right = Math.min(right, clip.right); }
    if (parent !== element && /auto|scroll|hidden|clip/.test(style.overflowY)) { top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom); }
  }
  return right > left && bottom > top;
}

export function noteVisibility(note: Note, views: NoteView[], options: { targets: string[]; surface: "summary" | "file_diff" | "other"; dialogOpen: boolean }) {
  const view = views.find(view => view.file === note.file && noteMatchesTarget(note, view.target));
  const match = view ? resolveNote(note, view.rows) : null;
  const element = view && match && match.row >= 0 ? [...view.element.querySelectorAll<HTMLElement>(".hunk-note[data-note-id]")].find(element => element.dataset.noteId === note.id && element.querySelector(".hunk-note-text")?.textContent === note.note) ?? null : null;
  const rendered = Boolean(element), visible = !options.dialogOpen && inAppViewport(element);
  let reason: string | null = null;
  if (!visible) reason = options.dialogOpen ? "dialog_open" : !options.targets.some(target => noteMatchesTarget(note, target)) ? "different_target"
    : !view ? "file_closed_collapsed_or_not_loaded" : match?.row === -1 ? match.error ? "ambiguous_anchor" : "anchor_not_in_diff"
      : !rendered ? "notes_not_rendered" : "outside_viewport";
  return { id: note.id, file: note.file, target: note.target ?? null, saved: true,
    matched: match ? match.row >= 0 : null, rendered, visible, reason, surface: rendered ? options.surface : null,
    side: note.side ?? null, line: note.startLine ?? null };
}
