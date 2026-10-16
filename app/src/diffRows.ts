export function parseDiffLines(value: { text: string } | null) {
  let hunk = -1;
  let inHunk = false;
  let oldLine = 0;
  let newLine = 0;
  return (value?.text ?? "").split("\n").map(line => {
    if (line.startsWith("diff --git ")) inHunk = false;
    if (line.startsWith("@@ ")) {
      const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      inHunk = Boolean(header);
      if (header) { oldLine = Number(header[1]); newLine = Number(header[2]); }
      return { line, hunkIndex: ++hunk, kind: "hunk", oldNumber: null, newNumber: null };
    }
    let oldNumber: number | null = null;
    let newNumber: number | null = null;
    let kind = !inHunk && line ? "metadata" : "";
    if (inHunk) {
      if (line.startsWith(" ")) { oldNumber = oldLine++; newNumber = newLine++; }
      else if (line.startsWith("-")) { oldNumber = oldLine++; kind = "deleted"; }
      else if (line.startsWith("+")) { newNumber = newLine++; kind = "added"; }
    }
    return { line, hunkIndex: inHunk ? hunk : -1, kind, oldNumber, newNumber };
  });
}
