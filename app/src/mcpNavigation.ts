export type Highlight =
  | { kind: "lines"; side: "old" | "new"; startLine: number; endLine?: number | null; quote?: string | null }
  | { kind: "hunk"; hunkIndex: number; quote?: string | null };
export type DiffRow = { line: string; kind: string; hunkIndex: number; oldNumber: number | null; newNumber: number | null };
export type McpRequest = { id: number; tool: string; deadline: number; arguments: {
  repository?: string; branch?: string | null; commit?: string; file?: string | null;
  parent?: string | null; query?: string; offset?: number; revision?: string | null;
  startLine?: number; endLine?: number | null; quote?: string | null; comment?: string | null; highlights?: Highlight[];
} };
export type McpConnection = { url: string; token: string };

// Reading against Git's empty tree includes every file line even when the commit did not change it.
// This uses the existing diff RPC, including already-installed SSH agents.
export function snapshotDiffTarget(commit: string): string {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(commit)) throw new Error("Invalid file revision");
  const emptyTree = commit.length === 64 ? "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321" : "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  return `${emptyTree}..${commit}`;
}

function snapshotPath(header: string): string {
  const path = header.slice(4).replace(/\t$/, "");
  if (!path.startsWith('"')) return path;
  if (!path.endsWith('"')) throw new Error("Invalid snapshot path");
  const escapes: Record<string, string> = { a: "\x07", b: "\b", t: "\t", n: "\n", v: "\x0b", f: "\f", r: "\r", '"': '"', "\\": "\\" };
  const bytes: number[] = [];
  for (const token of path.slice(1, -1).match(/\\(?:[0-7]{3}|.)|[^\\]/gu) ?? []) {
    if (/^\\[0-7]{3}$/.test(token)) bytes.push(parseInt(token.slice(1), 8));
    else {
      const text = token.startsWith("\\") ? escapes[token.slice(1)] : token;
      if (text === undefined) throw new Error("Invalid snapshot path");
      bytes.push(...new TextEncoder().encode(text));
    }
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
}

export function fileFromSnapshotDiff(value: { text: string; truncated: boolean }, file?: string): string {
  if (value.truncated) throw new Error("This file is too large to show as of a commit.");
  const rows = value.text.split("\n");
  if (rows.filter(line => line.startsWith("diff --git ")).length !== 1 || !rows.some(line => /^new file mode 100(644|755)$/.test(line))) throw new Error("The requested path is not a regular file at this revision.");
  if (rows.some(line => line.startsWith("Binary files "))) throw new Error("Binary files cannot be shown in the editor.");
  const start = rows.findIndex(line => line.startsWith("@@ "));
  if (start < 0) return ""; // An empty tracked file has a header but no hunk.
  const header = rows.find(line => line.startsWith("+++ "));
  if (file && (!header || snapshotPath(header) !== `b/${file}`)) throw new Error("The requested path is not this snapshot's file.");
  const lines: string[] = [];
  let noNewline = false;
  for (const row of rows.slice(start + 1)) {
    if (row.startsWith("+")) lines.push(row.slice(1));
    else if (row.startsWith("\\ No newline at end of file")) noNewline = true;
    else if (row) throw new Error("Git returned an incomplete file snapshot.");
  }
  return lines.join("\n") + (noNewline ? "" : "\n");
}

export function fileHighlightRows(content: string, startLine: number, endLine?: number | null, quote?: string | null): Set<number> {
  const rows = numberedDiffRows(content.replace(/\r\n?/g, "\n").split("\n").map(line => ({ line, kind: "", hunkIndex: -1, oldNumber: null, newNumber: null })), "untracked");
  return highlightRows(rows, [{ kind: "lines", side: "new", startLine, endLine, quote }]);
}

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
