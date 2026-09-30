import Prism from "prismjs";
// Explicit .js suffixes let Node load this module directly in unit tests.
import "prismjs/components/prism-typescript.js";
import "prismjs/components/prism-jsx.js";
import "prismjs/components/prism-tsx.js";
import "prismjs/components/prism-json.js";
import "prismjs/components/prism-python.js";
import "prismjs/components/prism-rust.js";
import "prismjs/components/prism-bash.js";
import "prismjs/components/prism-yaml.js";
import "prismjs/components/prism-go.js";
import "prismjs/components/prism-markdown.js";
import "prismjs/components/prism-toml.js";
import "prismjs/components/prism-sql.js";

export type DiffRow = { line: string; kind: string; hunkIndex: number };
export type HighlightPart = { text: string; types: string[]; changed: boolean };
type Range = { start: number; end: number };
type TokenPart = { text: string; types: string[] };

const MIN_SIMILARITY = 0.4;

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
  let i = 0, j = 0, common = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i].text === b[j].text) { common += a[i].text.trim().length; i++; j++; }
    else if (j < b.length && (i === a.length || scores[i][j + 1] >= scores[i + 1][j])) { newRanges.push({ start: b[j].start, end: b[j++].end }); }
    else if (i < a.length) { oldRanges.push({ start: a[i].start, end: a[i++].end }); }
  }
  // Lines that merely sit side by side (e.g. one line split into several) share almost nothing;
  // marking nearly every word as changed is noise, so only highlight genuinely similar lines.
  const total = before.replace(/\s+/g, "").length + after.replace(/\s+/g, "").length;
  if (total > 0 && (2 * common) / total < MIN_SIMILARITY) return [[], []];
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

const escapeHtml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Highlights a whole file at once (so multi-line comments and strings color correctly) and returns one HTML string per line. */
export function highlightFileLines(text: string, path: string): string[] {
  const grammar = grammarFor(path);
  const tokens: TokenPart[] = [];
  if (grammar && text.length <= 400_000) {
    try { flatten(Prism.tokenize(text, grammar), [], tokens); }
    catch { tokens.length = 0; tokens.push({ text, types: [] }); }
  } else tokens.push({ text, types: [] });
  const lines: string[] = [""];
  for (const token of tokens) {
    const open = token.types.length ? `<span class="${token.types.map(type => `syntax-${type}`).join(" ")}">` : "";
    token.text.split("\n").forEach((piece, index) => {
      if (index) lines.push("");
      if (piece) lines[lines.length - 1] += open ? `${open}${escapeHtml(piece)}</span>` : escapeHtml(piece);
    });
  }
  return lines;
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
