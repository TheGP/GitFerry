import { test } from "node:test";
import assert from "node:assert/strict";
import { editorChanges as changesWithRemoved } from "../src/editorChanges.ts";

// Keep assertions about current-file coordinates separate from deleted source text.
const editorChanges = (before: string, after: string) => changesWithRemoved(before, after).map(({ startLine, endLine, kind }) => ({ startLine, endLine, kind }));

test("finds distant changes across a large file, including staged plus unsaved edits", () => {
  const before = Array.from({ length: 4000 }, (_, i) => `line ${i + 1}`);
  const after = [...before];
  after[19] = "changed near top"; after[3099] = "changed near bottom";
  after.splice(1200, 0, "unsaved addition");
  assert.deepEqual(editorChanges(before.join("\n"), after.join("\n")), [
    { startLine: 20, endLine: 20, kind: "modified" },
    { startLine: 1201, endLine: 1201, kind: "added" },
    { startLine: 3101, endLine: 3101, kind: "modified" },
  ]);
});
test("marks deleted lines at the following line, clamping deletions at EOF", () => {
  assert.deepEqual(editorChanges("a\nb\nc\nd", "a\nc"), [
    { startLine: 2, endLine: 2, kind: "removed" },
    { startLine: 2, endLine: 2, kind: "removed" },
  ]);
  assert.deepEqual(editorChanges("a", ""), [{ startLine: 1, endLine: 1, kind: "removed" }]);
});
test("handles new/clean files, newline conventions, Unicode and undo", () => {
  assert.deepEqual(editorChanges("", "α\n新文件"), [{ startLine: 1, endLine: 2, kind: "added" }]);
  assert.deepEqual(editorChanges("a\r\nb\r\n", "a\nb\n"), []);
  assert.deepEqual(editorChanges("a\nb", "a\nb"), []);
  assert.deepEqual(editorChanges("a\nb", "a\ninsert\nb"), [{ startLine: 2, endLine: 2, kind: "added" }]);
  assert.deepEqual(editorChanges("a\nb", "a\nb"), []);
});
test("bounds comparisons for a completely rewritten large file", () => {
  const before = Array.from({ length: 10000 }, (_, i) => `old ${i}`).join("\n");
  const after = Array.from({ length: 12000 }, (_, i) => `new ${i}`).join("\n");
  assert.deepEqual(editorChanges(before, after), [{ startLine: 1, endLine: 12000, kind: "modified" }]);
});
test("covers inserted text and keeps ranges ordered with repeated context", () => {
  // Repeated lines exercise Myers backtracking and insertion/deletion tie breaking.
  let seed = 1;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let run = 0; run < 300; run++) {
    const a = Array.from({ length: 30 }, () => String(random() % 5));
    const b = [...a];
    for (let edit = 0; edit < 5; edit++) b.splice(random() % b.length, random() % 3, `edit${edit}`);
    const ranges = editorChanges(a.join("\n"), b.join("\n"));
    let previous = 0;
    for (const range of ranges) {
      assert.ok(range.startLine > 0 && range.endLine >= range.startLine && range.endLine <= b.length);
      assert.ok(range.startLine >= previous); previous = range.endLine;
      if (range.kind !== "removed") assert.ok(b.slice(range.startLine - 1, range.endLine).length);
    }
    for (let i = 0; i < b.length; i++) if (b[i].startsWith("edit")) assert.ok(ranges.some(r => r.kind !== "removed" && r.startLine <= i + 1 && r.endLine >= i + 1));
  }
});

test("large inserted blocks stay separate from distant changes", () => {
  const before = Array.from({ length: 4000 }, (_, i) => `line ${i + 1}`);
  const after = [...before]; after[3099] = "changed";
  after.splice(100, 0, ...Array.from({ length: 500 }, (_, i) => `added ${i}`));
  assert.deepEqual(editorChanges(before.join("\n"), after.join("\n")), [
    { startLine: 101, endLine: 600, kind: "added" },
    { startLine: 3600, endLine: 3600, kind: "modified" },
  ]);
});
test("large deletions stay separate from changes beyond unchanged islands", () => {
  const before = Array.from({ length: 4000 }, (_, i) => `line ${i + 1}`);
  const after = [...before]; after[3099] = "changed"; after.splice(100, 500);
  assert.deepEqual(editorChanges(before.join("\n"), after.join("\n")), [
    { startLine: 101, endLine: 101, kind: "removed" },
    { startLine: 2600, endLine: 2600, kind: "modified" },
  ]);
});

test("retains actual deleted source lines for replacements, pure deletions and EOF", () => {
  const before = "first\r\nold α\r\nremoved Unicode 文件\r\nkeep\r\nlast";
  const changes = changesWithRemoved(before, "first\nreplacement\nkeep");
  assert.deepEqual(changes.map(change => change.removed), [
    { startLine: 2, lines: ["old α", "removed Unicode 文件"] },
    { startLine: 5, lines: ["last"] },
  ]);
  assert.deepEqual(changesWithRemoved("", "new")[0].removed, null);
  assert.deepEqual(changesWithRemoved("whole file", "")[0].removed, { startLine: 1, lines: ["whole file"] });
});
test("deleted previews follow unsaved edits and disappear when undone", () => {
  assert.deepEqual(changesWithRemoved("a\nb\nc", "prefix\na\nc").map(change => change.removed).filter(Boolean), [{ startLine: 2, lines: ["b"] }]);
  assert.deepEqual(changesWithRemoved("a\nb\nc", "a\nb\nc"), []);
  const before = Array.from({ length: 2000 }, (_, i) => `line ${i + 1}`);
  const after = [...before]; after.splice(100, 500); after[1200] = "changed";
  assert.deepEqual(changesWithRemoved(before.join("\n"), after.join("\n"))[0].removed, { startLine: 101, lines: before.slice(100, 600) });
});
