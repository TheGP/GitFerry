import test from "node:test";
import assert from "node:assert/strict";
import { highlightRows, numberedDiffRows, repositoryKey, mcpConfiguration, snapshotDiffTarget, fileFromSnapshotDiff, fileHighlightRows, type DiffRow } from "../src/mcpNavigation.ts";

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

test("file snapshots include unchanged files and preserve file endings", () => {
  const header = "diff --git a/code.ts b/code.ts\nnew file mode 100644\nindex 0000000..1234567\n--- /dev/null\n+++ b/code.ts\n";
  const snapshot = (text: string) => fileFromSnapshotDiff({ text: header + text, truncated: false });
  assert.equal(snapshot("@@ -0,0 +1,2 @@\n+first\n+last\n"), "first\nlast\n");
  assert.equal(snapshot("@@ -0,0 +1,2 @@\n+first\n+last\n\\ No newline at end of file\n"), "first\nlast");
  assert.equal(snapshot("@@ -0,0 +1,2 @@\n+first\r\n+last\r\n"), "first\r\nlast\r\n");
  assert.equal(snapshot(""), "");
  assert.throws(() => snapshot("Binary files /dev/null and b/code.ts differ\n"), /Binary/);
  assert.throws(() => fileFromSnapshotDiff({ text: header, truncated: true }), /large/);
  assert.throws(() => fileFromSnapshotDiff({ text: header + header, truncated: false }), /regular file/);
  assert.throws(() => fileFromSnapshotDiff({ text: header.replace("100644", "120000"), truncated: false }), /regular file/);
  const text = header + "@@ -0,0 +1 @@\n+code\n";
  assert.equal(fileFromSnapshotDiff({ text, truncated: false }, "code.ts"), "code\n");
  assert.throws(() => fileFromSnapshotDiff({ text, truncated: false }, "other.ts"), /snapshot's file/);
  assert.equal(fileFromSnapshotDiff({ text: text.replace("+++ b/code.ts", '+++ "b/\\320\\277.ts"'), truncated: false }, "п.ts"), "code\n");
  assert.equal(fileFromSnapshotDiff({ text: text.replace("+++ b/code.ts", "+++ b/file name.ts\t"), truncated: false }, "file name.ts"), "code\n");
  assert.equal(snapshotDiffTarget("a".repeat(40)), `4b825dc642cb6eb9a060e54bf8d69288fbee4904..${"a".repeat(40)}`);
  assert.equal(snapshotDiffTarget("b".repeat(64)), `6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321..${"b".repeat(64)}`);
  assert.throws(() => snapshotDiffTarget("HEAD"), /revision/);
});

test("file highlights validate quotes and exclude the trailing display row", () => {
  assert.deepEqual([...fileHighlightRows("first\r\nretry\r\nlast\r\n", 2, 3, "retry")], [1, 2]);
  assert.throws(() => fileHighlightRows("first\n", 2), /fully present/);
  assert.throws(() => fileHighlightRows("", 1), /fully present/);
  assert.throws(() => fileHighlightRows("retry\n", 1, 1, "wrong"), /quote/);
});
