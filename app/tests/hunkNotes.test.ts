import { test } from "node:test";
import assert from "node:assert/strict";
import { matchNotes, parseNotes, parseNotesResult, resolveNote, validateNote, matchNotesResult, type NoteRow } from "../src/hunkNotes.ts";

const hunk = (index: number): NoteRow => ({ line: "@@ -1 +1 @@", kind: "hunk", hunkIndex: index });
const added = (index: number, code: string): NoteRow => ({ line: `+${code}`, kind: "added", hunkIndex: index });
const deleted = (index: number, code: string): NoteRow => ({ line: `-${code}`, kind: "deleted", hunkIndex: index });
const context = (index: number, code: string): NoteRow => ({ line: ` ${code}`, kind: "", hunkIndex: index });
const texts = (map: Map<number, { note: string }[]>, key: number) => map.get(key)?.map(note => note.note);

test("the last entry for an id wins and deleted removes it", () => {
  const notes = parseNotes([
    '{"id":"a","file":"src/a.ts","quote":"x","note":"first"}',
    'not json',
    '{"id":"b","file":"src/b.ts","quote":"y","note":"gone"}',
    '{"id":"a","file":"src/a.ts","quote":"x2","note":"second"}',
    '{"id":"b","deleted":true}',
    '{"id":"c","file":"src/c.ts","quote":"  ","note":"no quote"}',
  ].join("\n"));
  assert.deepEqual(notes, [{ id: "a", file: "src/a.ts", quote: "x2", note: "second" }]);
});

test("attaches a note to the row containing its quote, wherever the code moved", () => {
  const notes = parseNotes('{"id":"a","file":".\\\\src\\\\a.ts","quote":"  startWorker(args);","note":"why"}');
  const rows = [hunk(0), added(0, "const other = 1;"), hunk(1), context(1, "if (ready) {"), added(1, "    startWorker(args);"), context(1, "}")];
  const matched = matchNotes(notes, "src/a.ts", rows);
  assert.deepEqual([...matched.keys()], [4]);
  assert.deepEqual(texts(matched, 4), ["why"]);
});

test("prefers a changed line over the same text in unchanged context", () => {
  const notes = parseNotes('{"id":"a","file":"a.ts","quote":"throw error;","note":"why"}');
  const rows = [hunk(0), context(0, "throw error;"), hunk(1), deleted(1, "return;"), added(1, "throw error;")];
  assert.deepEqual([...matchNotes(notes, "a.ts", rows).keys()], [4]);
});

test("drops notes whose code is no longer in the diff or that belong to another file", () => {
  const notes = parseNotes('{"id":"a","file":"a.ts","quote":"gone()","note":"old"}\n{"id":"b","file":"b.ts","quote":"x","note":"other"}');
  assert.equal(matchNotes(notes, "a.ts", [hunk(0), added(0, "x")]).size, 0);
});

test("raw untracked content matches lines without a diff prefix", () => {
  const notes = parseNotes('{"id":"a","file":"new.ts","quote":"export function run","note":"entry point"}');
  const rows: NoteRow[] = [{ line: "// run", kind: "", hunkIndex: -1 }, { line: "export function run() {", kind: "", hunkIndex: -1 }];
  assert.deepEqual(texts(matchNotes(notes, "new.ts", rows), 1), ["entry point"]);
});

test("mixed CRLF/LF and BOM load; malformed records report their line without hiding valid notes", () => {
  const result = parseNotesResult('\uFEFF{"id":"a","file":"a.ts","quote":"run()","note":"why"}\r\nno json\n{"id":"b","file":"b.ts","quote":"stop()","note":"why"}\r\n');
  assert.equal(result.notes.length, 2);
  assert.match(result.errors[0], /^Notes line 2:/);
});

test("identical added lines do not silently attach to the first loop", () => {
  const note = parseNotes('{"id":"a","file":"a.ts","quote":"scroll();","note":"why"}')[0];
  const rows = [hunk(0), { ...added(0, "scroll();"), newNumber: 5 }, hunk(1), { ...added(1, "scroll();"), newNumber: 20 }];
  assert.equal(matchNotes([note], "a.ts", rows).size, 0);
  assert.match(resolveNote(note, rows).error!, /ambiguous/);
  assert.equal(resolveNote({ ...note, side: "new", startLine: 20 }, rows, true).row, 3);
  assert.equal(resolveNote({ ...note, side: "new", startLine: 10 }, rows, true).row, -1);
});

test("context disambiguates repeated quotes and unique quotes still follow shifted code", () => {
  const note = parseNotes('{"id":"a","file":"a.ts","quote":"scroll();","note":"why"}')[0];
  const rows = [hunk(0), context(0, "first loop"), added(0, "scroll();"), context(0, "second loop"), added(0, "scroll();")];
  assert.equal(resolveNote({ ...note, before: "second loop" }, rows).row, 4);
  assert.equal(resolveNote({ ...note, startLine: 100 }, [hunk(0), { ...added(0, "scroll();"), newNumber: 110 }]).row, 1);
});

test("staged notes never attach to newer working content", () => {
  const note = validateNote({ id: "a", file: "a.ts", quote: "scroll();", note: "why", target: "staged" });
  assert.ok(!("deleted" in note));
  const rows = [hunk(0), added(0, "scroll();")];
  assert.equal(matchNotesResult([note], "a.ts", rows, "working").matched.size, 0);
  assert.equal(matchNotesResult([note], "a.ts", rows, "staged").matched.size, 1);
  assert.throws(() => validateNote({ ...note, quote: "two\nlines" }), /one nonempty/);
  assert.throws(() => validateNote({ ...note, target: ["working"] }), /Invalid note target/);
});
