import Prism from "prismjs";
import "prismjs/components/prism-typescript.js";
import { parseDiffLines } from "./diffRows.ts";

export type MoveLocation = { file: string; line: number; endLine: number; name: string; side: "old" | "new" };
export type CodeMove = { from: MoveLocation; to: MoveLocation; edited: boolean };
export type MoveDiff = { file: string; text: string; truncated: boolean };
type Block = { location: MoveLocation; body: string; pairs: Set<string> };

// Keep source offsets while hiding braces inside comments, strings, templates and regex literals.
function maskTokens(tokens: Prism.TokenStream): string {
  if (typeof tokens === "string") return tokens;
  if (Array.isArray(tokens)) return tokens.map(maskTokens).join("");
  const text = maskTokens(tokens.content);
  return ["comment", "string", "template-string", "regex"].includes(tokens.type) ? text.replace(/[^\n]/g, " ") : text;
}

function bodyPairs(body: string): Set<string> {
  // Case/underscore normalization recognizes parameters extracted from constants (LOG_PREFIX -> logPrefix).
  const words = (body.match(/[\p{L}_$][\p{L}\p{N}_$]*|\d+/gu) ?? []).map(word => word.replace(/_/g, "").toLowerCase());
  return new Set(words.slice(1).map((word, index) => `${words[index]} ${word}`));
}

function functionsInRun(file: string, side: "old" | "new", firstLine: number, lines: string[]): Block[] {
  const text = lines.join("\n");
  if (text.length > 100_000 || !/\bfunction\b/.test(text)) return [];
  const mask = maskTokens(Prism.tokenize(text, Prism.languages.typescript));
  const declarations = [...mask.matchAll(/^[ \t]*(?:(?:export|default|async)\s+)*function\s*\*?\s*([\w$]+)\s*(?=[<(])/gm)];
  const blocks: Block[] = [];
  for (let index = 0; index < declarations.length; index++) {
    const declaration = declarations[index];
    const start = declaration.index!;
    const limit = declarations[index + 1]?.index ?? mask.length;
    let cursor = mask.indexOf("(", start + declaration[0].length), depth = 0;
    if (cursor < 0 || cursor >= limit) continue;
    do {
      if (mask[cursor] === "(") depth++;
      if (mask[cursor] === ")") depth--;
      cursor++;
    } while (cursor < limit && depth);
    // Return types may contain object types inside generics; their braces are not the body.
    let angle = 0, open = -1, close = -1;
    for (; cursor < limit; cursor++) {
      const char = mask[cursor];
      if (char === "<") angle++;
      if (char === ">") angle = Math.max(0, angle - 1);
      if (char !== "{" || angle) continue;
      open = cursor; depth = 1;
      for (cursor++; cursor < limit && depth; cursor++) {
        if (mask[cursor] === "{") depth++;
        if (mask[cursor] === "}") depth--;
      }
      if (depth) break; // A function split by unchanged context is not a whole move.
      close = cursor - 1;
      const next = mask.slice(cursor, limit).trimStart()[0];
      if (next === "{" || next === "|" || next === "&") { open = close = -1; cursor--; continue; }
      break;
    }
    if (open < 0 || close < 0) continue;
    const body = text.slice(open + 1, close);
    const pairs = bodyPairs(mask.slice(open + 1, close));
    if (body.length < 80 || pairs.size < 12) continue; // Tiny/common helpers are too ambiguous.
    let startRow = text.slice(0, start).split("\n").length - 1;
    while (startRow > 0 && /^\s*(?:\/\*|\*|\/\/)/.test(lines[startRow - 1])) startRow--;
    blocks.push({ location: { file, side, name: declaration[1], line: firstLine + startRow, endLine: firstLine + text.slice(0, close).split("\n").length - 1 }, body, pairs });
  }
  return blocks;
}

export function findCodeMoves(diffs: MoveDiff[]): CodeMove[] {
  const removed: Block[] = [], added: Block[] = [];
  for (const diff of diffs) {
    if (diff.truncated || diff.text.length > 512_000 || !/\.[cm]?[jt]sx?$/i.test(diff.file)) continue;
    let run: string[] = [], side: "old" | "new" | null = null, first = 0;
    const flush = () => {
      if (side) (side === "old" ? removed : added).push(...functionsInRun(diff.file, side, first, run));
      run = []; side = null;
    };
    for (const row of parseDiffLines(diff)) {
      const next = row.kind === "deleted" ? "old" : row.kind === "added" ? "new" : null;
      if (next !== side) flush();
      if (next) {
        if (!side) { side = next; first = (next === "old" ? row.oldNumber : row.newNumber)!; }
        run.push(row.line.slice(1));
      }
    }
    flush();
  }
  // Limit CPU on generated/very large patches. Normal scans are capped by the caller too.
  if (removed.length + added.length > 500) return [];
  const candidates: { from: Block; to: Block; score: number }[] = [];
  for (const from of removed) for (const to of added) {
    if (from.location.file === to.location.file) continue;
    let common = 0;
    for (const pair of from.pairs) if (to.pairs.has(pair)) common++;
    const score = 2 * common / (from.pairs.size + to.pairs.size);
    if (common >= 10 && score >= .7) candidates.push({ from, to, score });
  }
  return candidates.filter(candidate => !candidates.some(other => other !== candidate
    && (other.from === candidate.from || other.to === candidate.to) && other.score >= candidate.score - .1))
    .map(({ from, to }) => ({ from: from.location, to: to.location, edited: from.body.split("\n").map(line => line.trim()).join("\n") !== to.body.split("\n").map(line => line.trim()).join("\n") }));
}
