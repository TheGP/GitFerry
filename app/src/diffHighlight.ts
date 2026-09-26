import Prism from "prismjs";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-json";
import "prismjs/components/prism-python";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-go";
import "prismjs/components/prism-markdown";
import "prismjs/components/prism-toml";
import "prismjs/components/prism-sql";

export type DiffRow = { line: string; kind: string; hunkIndex: number };
export type HighlightPart = { text: string; types: string[]; changed: boolean };
type Range = { start: number; end: number };
type TokenPart = { text: string; types: string[] };

const grammarByExtension: Record<string, string> = {
  ts: "typescript", tsx: "tsx", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  json: "json", jsonc: "json", py: "python", rs: "rust", sh: "bash",
  bash: "bash", yml: "yaml", yaml: "yaml", go: "go", md: "markdown",
  toml: "toml", sql: "sql", css: "css", html: "markup", xml: "markup",
};

function grammarFor(path: string): Prism.Grammar | undefined {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return Prism.languages[grammarByExtension[extension] ?? ""];
}

function codeFor(row: DiffRow): string {
  return row.hunkIndex >= 0 && (row.kind === "added" || row.kind === "deleted" || row.line.startsWith(" ")) ? row.line.slice(1) : row.line;
}

function splitWords(value: string): { text: string; start: number; end: number }[] {
  const result: { text: string; start: number; end: number }[] = [];
  for (const match of value.matchAll(/\s+|[\p{L}\p{N}_$]+|[^\s\p{L}\p{N}_$]/gu)) {
    const start = match.index ?? 0;
    result.push({ text: match[0], start, end: start + match[0].length });
  }
  return result;
}

function changedRanges(before: string, after: string): [Range[], Range[]] {
  if (before === after) return [[], []];
  const a = splitWords(before);
  const b = splitWords(after);
  // Bound quadratic work for generated and minified lines.
  if (a.length > 180 || b.length > 180 || before.length > 2400 || after.length > 2400) return [[], []];
  const scores = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--)
    scores[i][j] = a[i].text === b[j].text ? scores[i + 1][j + 1] + 1 : Math.max(scores[i + 1][j], scores[i][j + 1]);
  const oldRanges: Range[] = [];
  const newRanges: Range[] = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i].text === b[j].text) { i++; j++; }
    else if (j < b.length && (i === a.length || scores[i][j + 1] >= scores[i + 1][j])) { newRanges.push({ start: b[j].start, end: b[j++].end }); }
    else if (i < a.length) { oldRanges.push({ start: a[i].start, end: a[i++].end }); }
  }
  return [oldRanges, newRanges];
}

function flatten(tokens: Prism.TokenStream, types: string[], result: TokenPart[]): void {
  if (typeof tokens === "string") { result.push({ text: tokens, types }); return; }
  if (Array.isArray(tokens)) { for (const token of tokens) flatten(token, types, result); return; }
  flatten(tokens.content, [...types, tokens.type], result);
}

function renderParts(code: string, grammar: Prism.Grammar | undefined, ranges: Range[], colorize: boolean): HighlightPart[] {
  const tokens: TokenPart[] = [];
  if (grammar && colorize && code.length <= 4000) {
    try { flatten(Prism.tokenize(code, grammar), [], tokens); }
    catch { tokens.push({ text: code, types: [] }); }
  } else tokens.push({ text: code, types: [] });
  const parts: HighlightPart[] = [];
  let offset = 0;
  for (const token of tokens) {
    const end = offset + token.text.length;
    const cuts = [offset, end];
    for (const range of ranges) {
      if (range.start > offset && range.start < end) cuts.push(range.start);
      if (range.end > offset && range.end < end) cuts.push(range.end);
    }
    cuts.sort((a, b) => a - b);
    for (let index = 0; index < cuts.length - 1; index++) {
      const start = cuts[index], stop = cuts[index + 1];
      if (start === stop) continue;
      parts.push({ text: token.text.slice(start - offset, stop - offset), types: token.types, changed: ranges.some(range => range.start <= start && range.end >= stop) });
    }
    offset = end;
  }
  return parts;
}

export function highlightDiff(rows: DiffRow[], path: string, diffLength: number): HighlightPart[][] {
  const changed = new Map<number, Range[]>();
  for (let index = 0; diffLength <= 180_000 && index < rows.length;) {
    if (rows[index].kind !== "deleted") { index++; continue; }
    const start = index;
    while (rows[index]?.kind === "deleted") index++;
    const added = index;
    while (rows[index]?.kind === "added") index++;
    const pairs = Math.min(added - start, index - added);
    for (let pair = 0; pair < pairs; pair++) {
      const [before, after] = changedRanges(codeFor(rows[start + pair]), codeFor(rows[added + pair]));
      changed.set(start + pair, before);
      changed.set(added + pair, after);
    }
  }
  const grammar = grammarFor(path);
  const colorize = diffLength <= 180_000;
  return rows.map((row, index) => {
    if (row.kind === "metadata" || row.kind === "hunk" || row.hunkIndex < 0) return [{ text: row.line || " ", types: [], changed: false }];
    return renderParts(codeFor(row), grammar, changed.get(index) ?? [], colorize);
  });
}
