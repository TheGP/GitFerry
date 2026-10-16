import test from "node:test";
import assert from "node:assert/strict";
import { findCodeMoves } from "../src/movedCode.ts";

const before = `/** Keep navigation history intact. */
async function ensureOnPost(context: OperationContext, targetUrl: string): Promise<{ error: string; retryable: boolean } | null> {
    const { page, logger, cursor } = context;
    if (!targetUrl) return null;
    const wanted = statusIdOf(targetUrl);
    if (wanted && statusIdOf(page.url()) === wanted) {
        logger.debug(LOG_PREFIX + ': post already open', { postUrl: targetUrl });
        return null;
    }
    return await navigateToOptionalPostUrl(page, logger, LOG_PREFIX, targetUrl, GOTO_TIMEOUT_MS, NAV_SETTLE_MIN_MS, NAV_SETTLE_MAX_MS, cursor);
}`;
const after = before.replace("ensureOnPost(context: OperationContext, targetUrl: string)", "ensureOnXPost(page: Page, logger: Logger, cursor: Cursor, targetUrl: string)")
  .replace("    const { page, logger, cursor } = context;\n    if (!targetUrl) return null;\n", "")
  .replaceAll("statusIdOf", "xStatusIdFromUrl").replaceAll("LOG_PREFIX", "logPrefix")
  .replace("GOTO_TIMEOUT_MS", "gotoTimeoutMs").replace("NAV_SETTLE_MIN_MS", "navSettleMinMs").replace("NAV_SETTLE_MAX_MS", "navSettleMaxMs");
function diff(file: string, side: "old" | "new", text: string, line = 30) {
  const count = text.split("\n").length;
  return { file, truncated: false, text: `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -${line},${side === "old" ? count : 0} +${line},${side === "new" ? count : 0} @@\n${text.split("\n").map(row => (side === "old" ? "-" : "+") + row).join("\n")}\n` };
}

test("links an extracted, renamed and adapted TypeScript function with object return types", () => {
  const moves = findCodeMoves([diff("bookmarkPost.ts", "old", before), diff("utils.ts", "new", after, 1700)]);
  assert.equal(moves.length, 1);
  assert.deepEqual(moves[0].from, { file: "bookmarkPost.ts", side: "old", name: "ensureOnPost", line: 30, endLine: 40 });
  assert.equal(moves[0].to.name, "ensureOnXPost");
  assert.equal(moves[0].to.line, 1700);
  assert.equal(moves[0].edited, true);
});

test("exact moves, including multiple functions in a single run, retain their own locations", () => {
  const unrelated = `export function unrelated() {\n    return fetchWidgetsFromDatabase({ active: true, owner: currentAccount, order: sortAscending });\n}`;
  const moves = findCodeMoves([diff("a.js", "old", before), diff("b.js", "new", `${unrelated}\n\n${before}`, 100)]);
  assert.equal(moves.length, 1);
  assert.equal(moves[0].to.line, 104);
  assert.equal(moves[0].edited, false);
});

test("does not guess between duplicate destinations or duplicate sources", () => {
  const source = diff("a.ts", "old", before), destination = diff("b.ts", "new", after);
  assert.deepEqual(findCodeMoves([source, destination, diff("c.ts", "new", after)]), []);
  assert.deepEqual(findCodeMoves([source, destination, diff("c.ts", "old", before)]), []);
});

test("ignores partial functions, unrelated changes, tiny helpers, comments and truncated diffs", () => {
  const source = diff("a.ts", "old", before);
  assert.deepEqual(findCodeMoves([source, { ...diff("b.ts", "new", after), truncated: true }]), []);
  assert.deepEqual(findCodeMoves([diff("a.ts", "old", before.split("\n").slice(0, 5).join("\n")), diff("b.ts", "new", after)]), []);
  assert.deepEqual(findCodeMoves([source, diff("b.ts", "new", "function reset() {\n    return null;\n}")]), []);
  assert.deepEqual(findCodeMoves([source, diff("b.ts", "new", `/*\n${after.split("\n").slice(1).join("\n")}\n*/`)]), []);
  assert.deepEqual(findCodeMoves([source, diff("b.ts", "new", `const message = \u0060${after}\u0060;`)]), []);
  assert.deepEqual(findCodeMoves([source, diff("a.ts", "new", after)]), [], "In-place edits are not moves");
});
