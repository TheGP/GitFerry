import { repositoryKey } from "./mcpNavigation.ts";
import type { WorktreeRepository, Worktree } from "./worktreeTabs.ts";

export type RepositoryMetadata = { commonGitDir: string; repositoryName: string; branch: string; worktrees: Worktree[] };
export type RepositoryMetadataCache = Record<string, RepositoryMetadata>;

export function parseRepositoryMetadata(text: string | null): RepositoryMetadataCache {
  try {
    const value = JSON.parse(text ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const cache: RepositoryMetadataCache = {};
    for (const [path, metadata] of Object.entries(value)) {
      if (!metadata || typeof metadata !== "object") continue;
      const item = metadata as Record<string, unknown>;
      if (typeof item.commonGitDir !== "string" || !item.commonGitDir || typeof item.repositoryName !== "string" || typeof item.branch !== "string" || !Array.isArray(item.worktrees)) continue;
      const worktrees = item.worktrees.filter((tree): tree is Worktree => Boolean(tree && typeof tree === "object" && typeof tree.path === "string" && typeof tree.branch === "string" && (tree.head === null || typeof tree.head === "string") && typeof tree.bare === "boolean" && typeof tree.prunable === "boolean"));
      cache[repositoryKey(path)] = { commonGitDir: item.commonGitDir, repositoryName: item.repositoryName, branch: item.branch, worktrees };
    }
    return cache;
  } catch { return {}; }
}

// Loading placeholders are hints. A successful snapshot replaces them; failed restores retain the last verified cache.
export function repositoryMetadataCache(tabs: (WorktreeRepository & { loading?: boolean; loadError?: string })[], previous: RepositoryMetadataCache): RepositoryMetadataCache {
  return Object.fromEntries(tabs.flatMap(tab => {
    const key = repositoryKey(tab.path);
    const metadata = tab.loading || tab.loadError ? previous[key]
      : tab.commonGitDir ? { commonGitDir: tab.commonGitDir, repositoryName: tab.repositoryName || tab.name, branch: tab.branch, worktrees: tab.worktrees ?? [] }
      : undefined;
    return metadata ? [[key, metadata]] : [];
  }));
}
