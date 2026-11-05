import assert from "node:assert/strict";
import test from "node:test";
import { textMatches } from "../src/findInPage.ts";

test("find uses literal, case-insensitive text, including regex punctuation", () => {
  assert.deepEqual(textMatches("function Foo() {} foo()", "FOO()"), [{ start: 9, end: 14 }, { start: 18, end: 23 }]);
  assert.deepEqual(textMatches("[a+b] aab .*", "[a+b]"), [{ start: 0, end: 5 }]);
  assert.deepEqual(textMatches("[a+b] aab .*", ".*"), [{ start: 10, end: 12 }]);
});

test("find retains UTF-16 offsets for Unicode and does not expand case-folded strings", () => {
  assert.deepEqual(textMatches("😀 λambda ΛAMBDA", "λambda"), [{ start: 3, end: 9 }, { start: 10, end: 16 }]);
  assert.deepEqual(textMatches("İx x", "x"), [{ start: 1, end: 2 }, { start: 3, end: 4 }]);
  assert.deepEqual(textMatches("😀😀", "😀"), [{ start: 0, end: 2 }, { start: 2, end: 4 }]);
});

test("find handles empty queries, absent text, and non-overlapping matches", () => {
  assert.deepEqual(textMatches("text", ""), []);
  assert.deepEqual(textMatches("text", "missing"), []);
  assert.deepEqual(textMatches("aaaaa", "aa"), [{ start: 0, end: 2 }, { start: 2, end: 4 }]);
});
