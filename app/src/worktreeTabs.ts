import { repositoryKey } from "./mcpNavigation.ts";

export type Worktree = { path: string; branch: string; head: string | null; bare: boolean; prunable: boolean };
export type WorktreeRepository = { path: string; name: string; branch: string; commonGitDir?: string; repositoryName?: string; worktrees?: Worktree[] };

export function worktreeGroupKey(repo: WorktreeRepository): string {
  return repositoryKey(repo.commonGitDir || repo.path);
}

// Keep the actual checkout paths in the application store, including its MCP repository identities.
export function repositoryTabs<T extends WorktreeRepository>(tabs: T[], selectedPath: string | null, remembered: Record<string, string>): T[] {
  const groups = new Map<string, T[]>();
  for (const tab of tabs) {
    const key = worktreeGroupKey(tab);
    groups.set(key, [...(groups.get(key) ?? []), tab]);
  }
  return [...groups].map(([key, members]) => {
    const representative = members.find(tab => tab.path === selectedPath) ?? members.find(tab => tab.path === remembered[key]) ?? members[0];
    return { ...representative, path: members[0].path, name: representative.repositoryName || representative.name };
  });
}

export function availableWorktrees<T extends WorktreeRepository>(repo: T, tabs: T[], order: string[] = []): Worktree[] {
  const members = tabs.filter(tab => worktreeGroupKey(tab) === worktreeGroupKey(repo));
  const listed = (repo.worktrees ?? []).filter(entry => !entry.bare && !entry.prunable);
  const paths = new Map(listed.map(entry => [repositoryKey(entry.path), entry]));
  for (const tab of members) {
    const key = repositoryKey(tab.path);
    // Open checkouts retain their live branch information; an unavailable checkout can still be closed.
    paths.set(key, { ...(paths.get(key) ?? { head: null, bare: false, prunable: false }), path: tab.path, branch: tab.branch });
  }
  const positions = new Map(order.map((path, index) => [repositoryKey(path), index]));
  return [...paths.values()].sort((a, b) => (positions.get(repositoryKey(a.path)) ?? order.length) - (positions.get(repositoryKey(b.path)) ?? order.length));
}

export function worktreeLabel(tree: Worktree): string {
  return tree.branch === "Detached HEAD" && tree.head ? `Detached HEAD · ${tree.head.slice(0, 7)}` : tree.branch || "Detached HEAD";
}

export function reorderRepositoryTabs<T extends WorktreeRepository>(tabs: T[], path: string, to: number): T[] {
  const groups = repositoryTabs(tabs, null, {});
  const from = groups.findIndex(group => group.path === path);
  if (from < 0) return tabs;
  groups.splice(to, 0, groups.splice(from, 1)[0]);
  return groups.flatMap(group => tabs.filter(tab => worktreeGroupKey(tab) === worktreeGroupKey(group)));
}
