import { test } from "node:test";
import assert from "node:assert/strict";
import { highlightDiff, type DiffRow, type HighlightPart } from "../src/diffHighlight.ts";

const hunk = (line: string): DiffRow => ({ line, kind: "hunk", hunkIndex: 0 });
const deleted = (code: string): DiffRow => ({ line: `-${code}`, kind: "deleted", hunkIndex: 0 });
const added = (code: string): DiffRow => ({ line: `+${code}`, kind: "added", hunkIndex: 0 });
const context = (code: string): DiffRow => ({ line: ` ${code}`, kind: "context", hunkIndex: 0 });

const changedText = (parts: HighlightPart[]) => parts.filter(part => part.changed).map(part => part.text).join("");
const text = (parts: HighlightPart[]) => parts.map(part => part.text).join("");

test("highlights only the changed words of similar lines", () => {
  const rows = [hunk("@@ -1 +1 @@"), deleted("const total = count + 1;"), added("const total = count + 2;")];
  const [, before, after] = highlightDiff(rows, "a.ts", 100);
  assert.equal(changedText(before), "1");
  assert.equal(changedText(after), "2");
  assert.equal(text(before), "const total = count + 1;");
});

test("does not highlight a line paired with an unrelated line", () => {
  const rows = [
    hunk("@@ -1,3 +1,6 @@"),
    context("export type GetAccountStatusResult ="),
    deleted("    | { success: true; data: { status: AccountStatus; automationMode?: AutomationMode } }"),
    added("    | {"),
    added("        success: true;"),
    added("        data: { status: AccountStatus; automationMode?: AutomationMode; tagNames?: string[] };"),
    added("    }"),
    context("    | { success: false; error: string };"),
  ];
  const parts = highlightDiff(rows, "types.ts", 1000);
  for (const [index, row] of parts.entries()) assert.equal(changedText(row), "", `row ${index} should have no word changes`);
});

test("keeps highlighting lines with an added suffix", () => {
  const rows = [hunk("@@ -1 +1 @@"), deleted("foo(a);"), added("foo(a); bar(b);")];
  const [, before, after] = highlightDiff(rows, "a.ts", 100);
  assert.equal(changedText(before), "");
  assert.equal(changedText(after).trim(), "bar(b);");
});

test("applies syntax token types", () => {
  const [, row] = highlightDiff([hunk("@@ -1 +1 @@"), added("const x = 'y';")], "a.ts", 100);
  assert.deepEqual(row.find(part => part.text === "const")?.types, ["keyword"]);
  assert.deepEqual(row.find(part => part.text === "'y'")?.types, ["string"]);
});

test("skips word diff and colors for huge diffs", () => {
  const rows = [hunk("@@ -1 +1 @@"), deleted("const a = 1;"), added("const a = 2;")];
  const [, before, after] = highlightDiff(rows, "a.ts", 200_000);
  assert.deepEqual(before, [{ text: "const a = 1;", types: [], changed: false }]);
  assert.deepEqual(after, [{ text: "const a = 2;", types: [], changed: false }]);
});
