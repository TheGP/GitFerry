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
test("lists unopened and unavailable worktrees, updates opened branches and skips bare entries", () => {
  const repo = { ...primary, worktrees: [...primary.worktrees, { path: "C:/bare", branch: "", head: null, bare: true, prunable: false }, { path: "C:/gone", branch: "old", head: null, bare: false, prunable: true }] };
  assert.deepEqual(availableWorktrees(repo, [{ ...repo, branch: "renamed" }]).map(tree => [tree.path, tree.branch]), [[primary.path, "renamed"], [topic.path, "topic"], ["C:/gone", "old"]]);
  assert.equal(availableWorktrees(repo, [{ ...repo, path: "C:/gone", branch: "stale cache" }])[2].branch, "old", "Unavailable entries keep authoritative registration details");
});
test("repository reordering moves all its linked tabs together", () => {
  assert.deepEqual(reorderRepositoryTabs([primary, other, topic], primary.path, 1).map(tab => tab.path), [other.path, primary.path, topic.path]);
});
test("old agent snapshots and SSH authorities keep their own repository identities", () => {
  assert.equal(repositoryTabs([{ path: "C:/a/app", name: "app", branch: "main" }, { path: "C:/b/app", name: "app", branch: "main" }], null, {}).length, 2);
  assert.notEqual(worktreeGroupKey({ ...primary, commonGitDir: "ssh://one/repo/.git" }), worktreeGroupKey({ ...primary, commonGitDir: "ssh://two/repo/.git" }));
});

test("manual worktree order tolerates removed checkouts and inserts new checkouts after main", () => {
  const extra = { ...primary.worktrees[0], path: "C:/trees/new", branch: "new" };
  const repo = { ...primary, worktrees: [...primary.worktrees, extra] };
  assert.deepEqual(availableWorktrees(repo, [repo], [topic.path, "C:/gone", primary.path], true).map(tree => tree.path), [primary.path, extra.path, topic.path]);
});

test("worktree labels show branch names and identify detached checkouts by folder name", () => {
  assert.equal(worktreeLabel(primary.worktrees[0]), "main");
  for (const path of ["C:/trees/contracts-messaging-integration", "C:\\trees\\contracts-messaging-integration\\", "ssh://server/repos/contracts-messaging-integration/"]) {
    assert.equal(worktreeLabel({ ...primary.worktrees[0], path, branch: "Detached HEAD", head: "abcdef123456" }), "contracts-messaging-integration (detached)");
  }
  assert.equal(worktreeLabel({ ...primary.worktrees[0], branch: "", head: null }), "app (detached)");
});

test("merge badges come from the selected snapshot and clear when a live checkout moves", () => {
  const tree = { ...primary.worktrees[1], head: "old", mergedInto: "origin/main" };
  const repo = { ...primary, worktrees: [primary.worktrees[0], tree] };
  assert.equal(availableWorktrees(repo, [repo, { ...topic, head: "old" }])[1].mergedInto, "origin/main");
  assert.equal(availableWorktrees(repo, [repo, { ...topic, head: "new" }])[1].mergedInto, null);
  assert.equal(availableWorktrees(repo, [repo, { ...topic, branch: "other" }])[1].mergedInto, null);
  for (const index of ["A", "M", "D", "R", "U"]) {
    assert.equal(availableWorktrees(repo, [repo, { ...topic, head: "old", status: [{ index }] }])[1].mergedInto, null, "Staged changes hide even a cached badge");
  }
  for (const index of [" ", "?"]) {
    assert.equal(availableWorktrees(repo, [repo, { ...topic, head: "old", status: [{ index }] }])[1].mergedInto, "origin/main");
  }
});

test("verified Git listings do not resurrect removed worktrees from cached open tabs", () => {
  const repo = { ...primary, worktrees: [primary.worktrees[0]] };
  assert.deepEqual(availableWorktrees(repo, [repo, topic]).map(tree => tree.path), [primary.path]);
  assert.equal(availableWorktrees({ ...primary, worktrees: undefined }, [primary, topic]).length, 2, "Old agents still use open checkout metadata");
});

test("worktree order uses newest creation date first after the default branch", () => {
  const older = { ...primary.worktrees[1], path: "C:/trees/z-older", createdAt: 100 };
  const newer = { ...older, path: "C:/trees/a-newer", createdAt: 200 };
  const repo = { ...primary, worktrees: [{ ...primary.worktrees[0], createdAt: 500 }, newer, older] };
  assert.deepEqual(availableWorktrees(repo, [repo]).map(tree => tree.path), [primary.path, newer.path, older.path]);
  assert.deepEqual(availableWorktrees(repo, [repo], [primary.path, older.path, newer.path]).map(tree => tree.path), [primary.path, newer.path, older.path], "Legacy discovery order must not override newest-first sorting");
  const bare = { ...repo, worktrees: [{ ...repo.worktrees[0], bare: true }, newer, older] };
  assert.deepEqual(availableWorktrees(bare, []).map(tree => tree.path), [newer.path, older.path]);
});
test("discovery order stays stable when later Git listings insert or reorder paths", () => {
  const first = { ...primary.worktrees[1], path: "C:/trees/z-first", createdAt: 100 };
  const second = { ...first, path: "C:/trees/a-second", createdAt: 200 };
  let repo = { ...primary, worktrees: [primary.worktrees[0], first] };
  const order = availableWorktrees(repo, [repo]).map(tree => tree.path);
  repo = { ...repo, worktrees: [primary.worktrees[0], second, first] };
  assert.deepEqual(availableWorktrees(repo, [repo], order).map(tree => tree.path), [primary.path, second.path, first.path]);
  const saved = availableWorktrees(repo, [repo], order).map(tree => tree.path);
  assert.deepEqual(availableWorktrees({ ...repo, worktrees: [second, first, primary.worktrees[0]] }, [], saved).map(tree => tree.path), saved);
  assert.deepEqual(availableWorktrees(repo, [repo], [first.path, primary.path], true).map(tree => tree.path), [primary.path, second.path, first.path]);
});
test("old agents and invalid creation dates keep remembered tabs stable and insert new discoveries on the left", () => {
  const extra = { ...primary.worktrees[1], path: "C:/trees/a-new" };
  const order = availableWorktrees(primary, [primary]).map(tree => tree.path);
  const repo = { ...primary, worktrees: [primary.worktrees[0], extra, primary.worktrees[1]] };
  assert.deepEqual(availableWorktrees(repo, [repo], order).map(tree => tree.path), [primary.path, extra.path, topic.path]);
  for (const createdAt of [NaN, Infinity, -1]) assert.deepEqual(availableWorktrees({ ...repo, worktrees: repo.worktrees.map(tree => ({ ...tree, createdAt })) }, [], order).map(tree => tree.path), [primary.path, extra.path, topic.path]);
});

test("main or master is pinned even in a linked checkout and cannot be moved by manual order", () => {
  for (const branch of ["main", "master"]) {
    const root = { ...primary.worktrees[0], branch: "feature", createdAt: 300 };
    const pinned = { ...primary.worktrees[1], branch, createdAt: 100 };
    const latest = { ...pinned, path: "C:/trees/latest", branch: "latest", createdAt: 400 };
    const repo = { ...primary, branch: root.branch, worktrees: [root, pinned, latest] };
    assert.deepEqual(availableWorktrees(repo, []).map(tree => tree.path), [pinned.path, latest.path, root.path]);
    assert.deepEqual(availableWorktrees(repo, [], [root.path, latest.path, pinned.path], true).map(tree => tree.path), [pinned.path, root.path, latest.path]);
  }
});

test("repositories without a default-branch checkout sort every worktree newest first", () => {
  const root = { ...primary.worktrees[0], branch: "feature", createdAt: 100 };
  const latest = { ...primary.worktrees[1], createdAt: 300 };
  const unknown = { ...latest, path: "C:/trees/unknown", createdAt: undefined };
  const repo = { ...primary, branch: root.branch, worktrees: [root, unknown, latest] };
  assert.deepEqual(availableWorktrees(repo, []).map(tree => tree.path), [latest.path, root.path, unknown.path]);
});
