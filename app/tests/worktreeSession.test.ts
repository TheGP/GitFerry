import test from "node:test";
import assert from "node:assert/strict";
import { parseRepositoryMetadata, repositoryMetadataCache } from "../src/worktreeSession.ts";
import { repositoryTabs, availableWorktrees } from "../src/worktreeTabs.ts";
import { repositoryKey } from "../src/mcpNavigation.ts";

const primary = { path: "C:/repos/app", name: "app", repositoryName: "app", branch: "main", commonGitDir: "C:/repos/app/.git", worktrees: [{ path: "C:/repos/app", branch: "main", head: null, bare: false, prunable: false }, { path: "C:/trees/topic", branch: "topic", head: null, bare: false, prunable: false }] };
const topic = { ...primary, path: "C:/trees/topic", name: "topic", branch: "topic" };

test("cached placeholders present one repository and its worktrees before snapshots complete", () => {
  const cache = parseRepositoryMetadata(JSON.stringify(repositoryMetadataCache([primary, topic], {})));
  const tabs = [primary.path, topic.path].map(path => ({ path, name: path.split("/").pop()!, branch: "Loading…", ...cache[repositoryKey(path)], loading: true }));
  assert.equal(repositoryTabs(tabs, topic.path, {}).length, 1);
  assert.equal(repositoryTabs(tabs, topic.path, {})[0].name, "app");
  assert.equal(repositoryTabs(tabs, topic.path, {})[0].branch, "topic");
  assert.equal(availableWorktrees(tabs[1], tabs).length, 2);
});
test("verified snapshots replace hints; closed checkouts disappear from the cache", () => {
  const cache = repositoryMetadataCache([primary, topic], {});
  const refreshed = repositoryMetadataCache([{ ...topic, branch: "new", commonGitDir: "C:/moved/.git", repositoryName: "moved" }], cache);
  assert.equal(refreshed[repositoryKey(topic.path)].branch, "new");
  assert.equal(refreshed[repositoryKey(topic.path)].commonGitDir, "C:/moved/.git");
  assert.equal(refreshed[repositoryKey(primary.path)], undefined);
});
test("loading and failed restores cannot overwrite the last verified metadata", () => {
  const cache = repositoryMetadataCache([primary, topic], {});
  const refreshed = repositoryMetadataCache([{ ...primary, branch: "Loading…", loading: true }, { ...topic, branch: "Unavailable", loadError: "Missing" }], cache);
  assert.deepEqual(refreshed, cache);
});
test("old agents clear metadata hints after verification and malformed cache degrades to path-only restore", () => {
  const cache = repositoryMetadataCache([primary], {});
  assert.deepEqual(repositoryMetadataCache([{ path: primary.path, name: "app", branch: "main" }], cache), {});
  for (const text of ["bad JSON", "[]", "null", '{"C:/repo":{"commonGitDir":8}}']) assert.deepEqual(parseRepositoryMetadata(text), {});
  assert.deepEqual(parseRepositoryMetadata(JSON.stringify({ [topic.path]: { ...cache[repositoryKey(primary.path)], worktrees: [null, { path: 1 }] } }))[repositoryKey(topic.path)].worktrees, []);
});
