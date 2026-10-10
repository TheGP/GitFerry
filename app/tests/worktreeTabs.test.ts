import test from "node:test";
import assert from "node:assert/strict";
import { availableWorktrees, repositoryTabs, reorderRepositoryTabs, worktreeGroupKey, worktreeLabel } from "../src/worktreeTabs.ts";

const primary = { path: "C:/repos/app", name: "app", repositoryName: "app", branch: "main", commonGitDir: "C:/repos/app/.git", worktrees: [{ path: "C:/repos/app", branch: "main", head: null, bare: false, prunable: false }, { path: "C:/trees/topic", branch: "topic", head: null, bare: false, prunable: false }] };
const topic = { ...primary, path: "C:/trees/topic", name: "topic", branch: "topic" };
const other = { ...primary, path: "C:/other/app", commonGitDir: "C:/other/app/.git", worktrees: [] };

test("migrates independent linked checkout tabs into one repository while keeping same-name clones separate", () => {
  const groups = repositoryTabs([primary, other, topic], topic.path, {});
  assert.equal(groups.length, 2);
  assert.equal(groups[0].name, "app");
  assert.equal(groups[0].branch, "topic");
  assert.equal(groups[0].path, primary.path);
  assert.notEqual(worktreeGroupKey(groups[0]), worktreeGroupKey(groups[1]));
});
test("repository selection restores remembered worktree and uses first checkout if it is gone", () => {
  const key = worktreeGroupKey(primary);
  assert.equal(repositoryTabs([primary, topic, other], other.path, { [key]: topic.path })[0].branch, "topic");
  assert.equal(repositoryTabs([primary, topic], null, { [key]: "removed" })[0].branch, "main");
});
test("lists unopened worktrees, updates opened branches, skips bare and prunable entries", () => {
  const repo = { ...primary, worktrees: [...primary.worktrees, { path: "C:/bare", branch: "", head: null, bare: true, prunable: false }, { path: "C:/gone", branch: "old", head: null, bare: false, prunable: true }] };
  assert.deepEqual(availableWorktrees(repo, [{ ...repo, branch: "renamed" }]).map(tree => [tree.path, tree.branch]), [[primary.path, "renamed"], [topic.path, "topic"]]);
});
test("repository reordering moves all its linked tabs together", () => {
  assert.deepEqual(reorderRepositoryTabs([primary, other, topic], primary.path, 1).map(tab => tab.path), [other.path, primary.path, topic.path]);
});
test("old agent snapshots and SSH authorities keep their own repository identities", () => {
  assert.equal(repositoryTabs([{ path: "C:/a/app", name: "app", branch: "main" }, { path: "C:/b/app", name: "app", branch: "main" }], null, {}).length, 2);
  assert.notEqual(worktreeGroupKey({ ...primary, commonGitDir: "ssh://one/repo/.git" }), worktreeGroupKey({ ...primary, commonGitDir: "ssh://two/repo/.git" }));
});

test("manual worktree order tolerates removed checkouts and appends newly discovered checkouts", () => {
  const extra = { ...primary.worktrees[0], path: "C:/trees/new", branch: "new" };
  const repo = { ...primary, worktrees: [...primary.worktrees, extra] };
  assert.deepEqual(availableWorktrees(repo, [repo], [topic.path, "C:/gone", primary.path]).map(tree => tree.path), [topic.path, primary.path, extra.path]);
});

test("worktree labels show branch names and identify detached checkouts without folder names", () => {
  assert.equal(worktreeLabel(primary.worktrees[0]), "main");
  assert.equal(worktreeLabel({ ...primary.worktrees[0], branch: "Detached HEAD", head: "abcdef123456" }), "Detached HEAD · abcdef1");
});
