import test from "node:test";
import assert from "node:assert/strict";
import { highlightRows, numberedDiffRows, repositoryKey, mcpConfiguration, type DiffRow } from "../src/mcpNavigation.ts";

const rows: DiffRow[] = [
  { line: "@@ -10,2 +10,2 @@", kind: "hunk", hunkIndex: 0, oldNumber: null, newNumber: null },
  { line: "-old code", kind: "deleted", hunkIndex: 0, oldNumber: 10, newNumber: null },
  { line: "+new code", kind: "added", hunkIndex: 0, oldNumber: null, newNumber: 10 },
  { line: " context", kind: "", hunkIndex: 0, oldNumber: 11, newNumber: 11 },
  { line: "@@ -20 +20 @@", kind: "hunk", hunkIndex: 1, oldNumber: null, newNumber: null },
  { line: "-other old", kind: "deleted", hunkIndex: 1, oldNumber: 20, newNumber: null },
  { line: "+other new", kind: "added", hunkIndex: 1, oldNumber: null, newNumber: 20 },
];
test("Windows tab paths match without merging separate worktrees or SSH path case", () => {
  assert.equal(repositoryKey("C:\\Work\\repo\\"), repositoryKey("c:/work/repo"));
  assert.notEqual(repositoryKey("C:/work/repo"), repositoryKey("C:/work/repo-topic"));
  assert.notEqual(repositoryKey("ssh://host/Repo"), repositoryKey("ssh://host/repo"));
});
test("old and new line numbers identify opposite sides of a replacement", () => {
  assert.deepEqual([...highlightRows(rows, [{ kind: "lines", side: "old", startLine: 10, quote: "old code" }])], [1]);
  assert.deepEqual([...highlightRows(rows, [{ kind: "lines", side: "new", startLine: 10, endLine: 11 }])], [2, 3]);
});
test("hunks include their header and repeated evidence is deduplicated", () => {
  assert.deepEqual([...highlightRows(rows, [{ kind: "hunk", hunkIndex: 1 }, { kind: "lines", side: "old", startLine: 20 }])], [4, 5, 6]);
});
test("missing lines, wrong quotes, and missing hunks fail without pretending success", () => {
  assert.throws(() => highlightRows(rows, [{ kind: "lines", side: "new", startLine: 10, endLine: 20 }]), /fully present/);
  assert.throws(() => highlightRows(rows, [{ kind: "lines", side: "old", startLine: 10, quote: "new code" }]), /quote/);
  assert.throws(() => highlightRows(rows, [{ kind: "hunk", hunkIndex: 3 }]), /not present/);
  assert.throws(() => highlightRows(rows, [{ kind: "lines", side: "new", startLine: 0 }]), /Invalid/);
});
test("configuration includes authenticated HTTP connection", () => {
  assert.deepEqual(JSON.parse(mcpConfiguration({ url: "http://127.0.0.1:39847/mcp", token: "test-token" })), {
    mcpServers: { gitferry: { url: "http://127.0.0.1:39847/mcp", headers: { Authorization: "Bearer test-token" } } },
  });
});
test("untracked raw rows do not number the empty tail after a final newline", () => {
  const raw = ["hello", ""].map(line => ({ line, kind: "metadata", hunkIndex: -1, oldNumber: null, newNumber: null }));
  const numbered = numberedDiffRows(raw, "untracked");
  assert.equal(numbered[0].newNumber, 1);
  assert.equal(numbered[1].newNumber, null);
  assert.throws(() => highlightRows(numbered, [{ kind: "lines", side: "new", startLine: 2 }]), /fully present/);
  assert.equal(numberedDiffRows([raw[0]], "untracked")[0].newNumber, 1);
});
