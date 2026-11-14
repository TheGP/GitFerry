/** Ranges use 1-based lines in the displayed buffer. Deletions point to the following line (or EOF). */
export type EditorChange = { startLine: number; endLine: number; kind: "added" | "modified" | "removed" };

/** Bounded Myers line comparison. Large replacements fall back to one range, keeping typing responsive. */
export function editorChanges(before: string, after: string): EditorChange[] {
  before = before.replace(/\r\n?/g, "\n");
  after = after.replace(/\r\n?/g, "\n");
  if (before === after) return [];
  const a = before ? before.split("\n") : [], b = after ? after.split("\n") : [];
  let prefix = 0, oldEnd = a.length, newEnd = b.length;
  while (prefix < oldEnd && prefix < newEnd && a[prefix] === b[prefix]) prefix++;
  while (oldEnd > prefix && newEnd > prefix && a[oldEnd - 1] === b[newEnd - 1]) { oldEnd--; newEnd--; }
  const range = (oldStart: number, oldStop: number, start: number, stop: number): EditorChange => ({
    startLine: Math.min(start + 1, Math.max(1, b.length)),
    endLine: Math.max(1, Math.min(Math.max(start + 1, stop), b.length)),
    kind: oldStart === oldStop ? "added" : start === stop ? "removed" : "modified",
  });
  const fallback = () => [range(prefix, oldEnd, prefix, newEnd)];
  if (prefix === oldEnd || prefix === newEnd) return fallback();
  const n = oldEnd - prefix, m = newEnd - prefix;
  const trace: Map<number, number>[] = [];
  let frontier = new Map<number, number>([[1, 0]]), work = 0;
  for (let distance = 0; distance <= Math.min(n + m, 256); distance++) {
    trace.push(new Map(frontier));
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      let x = diagonal === -distance || (diagonal !== distance && (frontier.get(diagonal - 1) ?? -1) < (frontier.get(diagonal + 1) ?? -1))
        ? frontier.get(diagonal + 1) ?? 0 : (frontier.get(diagonal - 1) ?? 0) + 1;
      let y = x - diagonal;
      while (x < n && y < m && a[prefix + x] === b[prefix + y]) { x++; y++; if (++work > 250_000) return fallback(); }
      frontier.set(diagonal, x);
      if (++work > 250_000) return fallback();
      if (x < n || y < m) continue;
      const matches: [number, number][] = [];
      for (let d = distance; d >= 0; d--) {
        const previous = trace[d], k = x - y;
        const previousK = k === -d || (k !== d && (previous.get(k - 1) ?? -1) < (previous.get(k + 1) ?? -1)) ? k + 1 : k - 1;
        const previousX = previous.get(previousK) ?? 0, previousY = previousX - previousK;
        while (x > previousX && y > previousY) matches.push([prefix + --x, prefix + --y]);
        x = previousX; y = previousY;
      }
      const result: EditorChange[] = [];
      let oldStart = prefix, newStart = prefix;
      for (const [oldLine, newLine] of [...matches.reverse(), [oldEnd, newEnd]]) {
        if (oldLine > oldStart || newLine > newStart) result.push(range(oldStart, oldLine, newStart, newLine));
        oldStart = oldLine + 1; newStart = newLine + 1;
      }
      return result;
    }
  }
  return fallback();
}
