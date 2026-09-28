import { test } from "node:test";
import assert from "node:assert/strict";
import { matchNotes, parseNotes, type NoteRow } from "../src/hunkNotes.ts";

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
