// AI agents explain their changes in .gitferry/notes.jsonl, one JSON object per line: { id, file, quote, note }.
// A later line with the same id replaces the note ("deleted": true removes it). Notes attach to the hunk that
// contains the quoted code, so they follow the code when lines shift.
export const notesFile = ".gitferry/notes.jsonl";

export type Note = { id: string; file: string; quote: string; note: string };
export type NoteRow = { line: string; kind: string; hunkIndex: number };

const normalizePath = (file: string) => file.replace(/\\/g, "/").replace(/^\.\//, "");

export function parseNotes(text: string): Note[] {
  const latest = new Map<string, Note | null>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || typeof entry !== "object") continue;
    const { id, file, quote, note, deleted } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !id) continue;
    if (deleted === true) { latest.set(id, null); continue; }
    if (typeof file !== "string" || typeof quote !== "string" || !quote.trim() || typeof note !== "string" || !note.trim()) continue;
    latest.set(id, { id, file: normalizePath(file), quote: quote.trim(), note: note.trim() });
  }
  return [...latest.values()].filter((note): note is Note => note !== null);
}

// The row's code without its diff prefix; files shown as raw content (new untracked files) have no hunks or prefixes.
export const rowCode = (row: NoteRow) => row.hunkIndex < 0 ? row.line : row.line.slice(1);

// Maps a row index to the notes shown above that row: the line containing the note's quote.
// A quote found on an added line wins over a deleted line, which wins over unchanged context.
// Notes whose quote is no longer in the diff are dropped: they usually describe code that was already committed.
export function matchNotes(notes: Note[], file: string, rows: NoteRow[]): Map<number, Note[]> {
  const matched = new Map<number, Note[]>();
  const fileNotes = notes.filter(note => note.file === normalizePath(file));
  if (!fileNotes.length) return matched;
  const raw = !rows.some(row => row.kind === "hunk");
  for (const note of fileNotes) {
    let best = { rank: 3, row: -1 };
    rows.forEach((row, index) => {
      if (best.rank === 0 || row.kind === "hunk" || (!raw && row.hunkIndex < 0)) return;
      const rank = raw || row.kind === "added" ? 0 : row.kind === "deleted" ? 1 : row.line.startsWith(" ") ? 2 : 3;
      if (rank < best.rank && rowCode(row).includes(note.quote)) best = { rank, row: index };
    });
    if (best.rank < 3) matched.set(best.row, [...matched.get(best.row) ?? [], note]);
  }
  return matched;
}
