export type Highlight =
  | { kind: "lines"; side: "old" | "new"; startLine: number; endLine?: number | null; quote?: string | null }
  | { kind: "hunk"; hunkIndex: number; quote?: string | null };
export type DiffRow = { line: string; kind: string; hunkIndex: number; oldNumber: number | null; newNumber: number | null };
export type McpRequest = { id: number; tool: string; deadline: number; arguments: {
  repository?: string; branch?: string | null; commit?: string; file?: string | null;
  parent?: string | null; query?: string; offset?: number; revision?: string | null;
  startLine?: number; highlights?: Highlight[];
} };
export type McpConnection = { url: string; token: string };

export function numberedDiffRows(rows: DiffRow[], target: string): DiffRow[] {
  if (target !== "untracked" || rows.some(row => row.kind === "hunk")) return rows;
  return rows.map((row, index) => ({ ...row, kind: "", newNumber: index < rows.length - 1 || row.line ? index + 1 : null }));
}

// Windows paths are case-insensitive; SSH and Unix repository paths retain their case.
export function repositoryKey(path: string): string {
  if (path.startsWith("ssh://")) return path.replace(/\/$/, "");
  const clean = path.replace(/\\/g, "/").replace(/\/$/, "");
  return /^[a-z]:\//i.test(clean) || clean.startsWith("//") ? clean.toLowerCase() : clean;
}

export function highlightRows(rows: DiffRow[], highlights: Highlight[]): Set<number> {
  const selected = new Set<number>();
  for (const highlight of highlights) {
    let matches: number[];
    if (highlight.kind === "hunk") {
      matches = rows.flatMap((row, index) => row.hunkIndex === highlight.hunkIndex ? [index] : []);
    } else {
      const end = highlight.endLine ?? highlight.startLine;
      if (!Number.isSafeInteger(highlight.startLine) || highlight.startLine < 1 || !Number.isSafeInteger(end) || end < highlight.startLine || end - highlight.startLine > 10000) throw new Error("Invalid highlight range");
      const numbers = new Set<number>();
      matches = rows.flatMap((row, index) => {
        const line = highlight.side === "old" ? row.oldNumber : row.newNumber;
        if (line === null || line < highlight.startLine || line > end) return [];
        numbers.add(line); return [index];
      });
      if (numbers.size !== end - highlight.startLine + 1) throw new Error("The requested line range is not fully present in this diff. Read get_diff for the available old/new line numbers.");
    }
    if (!matches.length) throw new Error("The requested hunk or lines are not present in this diff");
    const quote = highlight.quote;
    if (quote != null && !matches.some(index => rows[index].line.slice(rows[index].hunkIndex >= 0 ? 1 : 0).includes(quote))) throw new Error("The code quote does not match the requested highlight");
    matches.forEach(index => selected.add(index));
  }
  return selected;
}

export function mcpConfiguration(connection: McpConnection): string {
  return JSON.stringify({ mcpServers: { gitferry: { url: connection.url, headers: { Authorization: `Bearer ${connection.token}` } } } }, null, 2);
}
