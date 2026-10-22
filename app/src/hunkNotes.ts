// Latest entry wins by id; deleted entries remove a note. Legacy quote-only notes remain supported.
export const notesFile = ".gitferry/notes.jsonl";
export type Note = { id: string; file: string; quote: string; note: string; target?: string; side?: "old" | "new"; startLine?: number; before?: string; after?: string };
export type NoteEntry = Note | { id: string; deleted: true };
export type NoteRow = { line: string; kind: string; hunkIndex: number; oldNumber?: number | null; newNumber?: number | null };
const normalizePath = (file: string) => file.replace(/\\/g, "/").replace(/^\.\//, "");
export const isCommitTarget = (target: string) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(target);
export const isNoteTarget = (target: unknown): target is string => typeof target === "string" && (
  ["working", "staged", "untracked"].includes(target) || isCommitTarget(target)
  || target.split("..").length === 2 && target.split("..").every(isCommitTarget));
export const noteMatchesTarget = (note: Note, target?: string) => note.target
  ? note.target.toLowerCase() === target?.toLowerCase()
  : !target || ["working", "staged", "untracked"].includes(target) || target.includes("..");

export function validateNote(entry: unknown): NoteEntry {
  if (!entry || typeof entry !== "object") throw new Error("Expected a note object");
  const { id, file, quote, note, deleted, target, side, startLine, before, after } = entry as Record<string, unknown>;
  if (typeof id !== "string" || !id.trim() || id.length > 200 || id.includes("\0")) throw new Error("Invalid note id");
  if (deleted === true) return { id, deleted: true };
  if (typeof file !== "string" || !file.trim() || file.length > 4096 || file.includes("\0")) throw new Error("Invalid note file");
  if (typeof quote !== "string" || !quote.trim() || quote.length > 4096 || /[\r\n\0]/.test(quote)) throw new Error("Quote must be one nonempty code line");
  if (typeof note !== "string" || !note.trim() || note.length > 16000 || note.includes("\0")) throw new Error("Invalid note text");
  if (target != null && !isNoteTarget(target)) throw new Error("Invalid note target; use working, staged, untracked, a full commit SHA or baseSHA..headSHA");
  if (side != null && side !== "old" && side !== "new") throw new Error("Invalid note side");
  if (startLine != null && (!Number.isSafeInteger(startLine) || Number(startLine) < 1)) throw new Error("Invalid note line");
  for (const context of [before, after]) if (context != null && (typeof context !== "string" || context.length > 4096 || /[\r\n\0]/.test(context))) throw new Error("Context must be one code line");
  return { id, file: normalizePath(file), quote: quote.trim(), note: note.trim(),
    ...(typeof target === "string" ? { target: target.toLowerCase() } : {}), ...(side != null ? { side } : {}),
    ...(startLine != null ? { startLine: Number(startLine) } : {}), ...(before != null ? { before: String(before) } : {}), ...(after != null ? { after: String(after) } : {}) };
}

export function parseNotesResult(text: string): { notes: Note[]; errors: string[] } {
  const latest = new Map<string, Note | null>(), errors: string[] = [];
  text.replace(/^\uFEFF/, "").split("\n").forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const entry = validateNote(JSON.parse(line));
      latest.set(entry.id, "deleted" in entry ? null : entry);
    } catch (cause) { errors.push(`Notes line ${index + 1}: ${cause instanceof Error ? cause.message : String(cause)}`); }
  });
  return { notes: [...latest.values()].filter((note): note is Note => note !== null), errors };
}
export const parseNotes = (text: string): Note[] => parseNotesResult(text).notes;
export const rowCode = (row: NoteRow) => row.hunkIndex < 0 ? row.line : row.line.slice(1);

// UI and MCP share this matcher. Never guess among equally ranked occurrences.
export function resolveNote(note: Note, rows: NoteRow[], strictLine = false): { row: number; error?: string } {
  const raw = !rows.some(row => row.kind === "hunk");
  const candidates = rows.flatMap((row, index) => {
    if (row.kind === "hunk" || (!raw && row.hunkIndex < 0) || !rowCode(row).includes(note.quote)) return [];
    if (note.side === "old" && row.kind === "added" || note.side === "new" && row.kind === "deleted") return [];
    if (note.before != null && (!rows[index - 1] || rows[index - 1].kind === "hunk" || rowCode(rows[index - 1]) !== note.before)) return [];
    if (note.after != null && (!rows[index + 1] || rows[index + 1].kind === "hunk" || rowCode(rows[index + 1]) !== note.after)) return [];
    const line = raw ? index + 1 : note.side === "old" || row.kind === "deleted" ? row.oldNumber : row.newNumber;
    const rank = raw || row.kind === "added" ? 0 : row.kind === "deleted" ? 1 : row.line.startsWith(" ") ? 2 : 3;
    return rank < 3 ? [{ row: index, line, rank }] : [];
  });
  if (note.startLine != null) {
    const exact = candidates.filter(candidate => candidate.line === note.startLine);
    if (exact.length === 1) return { row: exact[0].row };
    if (strictLine) return { row: -1, error: `Note ${note.id}: quote/context does not uniquely match line ${note.startLine}` };
  }
  const bestRank = Math.min(...candidates.map(candidate => candidate.rank));
  const best = candidates.filter(candidate => candidate.rank === bestRank);
  return best.length === 1 ? { row: best[0].row } : { row: -1, ...(best.length > 1 ? { error: `Note ${note.id}: ambiguous quote; specify side, startLine or context` } : {}) };
}

export function matchNotesResult(notes: Note[], file: string, rows: NoteRow[], target?: string) {
  const matched = new Map<number, Note[]>(), errors: string[] = [];
  for (const note of notes.filter(note => note.file === normalizePath(file) && (target === undefined || noteMatchesTarget(note, target)))) {
    const result = resolveNote(note, rows);
    if (result.error) errors.push(result.error);
    if (result.row >= 0) matched.set(result.row, [...matched.get(result.row) ?? [], note]);
  }
  return { matched, errors };
}
export const matchNotes = (notes: Note[], file: string, rows: NoteRow[]) => matchNotesResult(notes, file, rows).matched;
