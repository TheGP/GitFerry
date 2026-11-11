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

test("highlights inserted packages in a long Dockerfile command", () => {
  const before = "    apt-get update && apt-get install -y tzdata gnupg x11vnc xvfb zip wget curl psmisc supervisor gconf-service python3 python3-pip libasound2 libatk1.0-0 libatk-bridge2.0-0 libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 libgcc1 libgconf-2-4 libgdk-pixbuf2.0-0 libglib2.0-0 libgtk-3-bin libnspr4 libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 ca-certificates fonts-liberation libappindicator1 libnss3 lsb-release xdg-utils libgbm-dev nginx libcurl3-gnutls tini && \\";
  const after = before.replace("zip wget", "zip zstd tar wget");
  const rows = [hunk("@@ -1 +1,2 @@"), deleted(before), added(after), added("    zstd --version && tar --version && \\")];
  const parts = highlightDiff(rows, "Dockerfile", 1800);
  assert.equal(changedText(parts[1]), "");
  assert.equal(changedText(parts[2]).trim(), "zstd tar");
  assert.equal(changedText(parts[3]), "");
  assert.equal(text(parts[2]), after);
  const reversed = highlightDiff([deleted(after), added(before)], "Dockerfile", 1800);
  assert.equal(changedText(reversed[0]).trim(), "zstd tar");
  assert.equal(changedText(reversed[1]), "");
});

test("leaves unpaired lines of an uneven block unhighlighted", () => {
  const rows = [hunk("@@ -1,2 +1 @@"), deleted("const a = 1;"), deleted("const b = 2;"), added("const a = 3;")];
  const [, first, second, after] = highlightDiff(rows, "a.ts", 100);
  assert.equal(changedText(first), "1");
  assert.equal(changedText(second), "");
  assert.equal(changedText(after), "3");
});

test("word highlighting starts at 40% shared characters", () => {
  // 10 of 26 shared characters (0.38) stays plain; 12 of 28 (0.43) is highlighted.
  const below = highlightDiff([hunk("@@ -1 +1 @@"), deleted("aaaaa bbbb cccc"), added("aaaaa dddd eeee")], "a.txt", 100);
  assert.equal(changedText(below[2]), "");
  const above = highlightDiff([hunk("@@ -1 +1 @@"), deleted("aaaaaa bbbb cccc"), added("aaaaaa dddd eeee")], "a.txt", 100);
  assert.equal(changedText(above[2]), "ddddeeee");
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
