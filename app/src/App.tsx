import { batch, createComputed, createEffect, createMemo, createSignal, For, Index, on, onCleanup, onMount, Show, untrack, type JSX } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { highlightDiff } from "./diffHighlight";
import { formatCommitDate } from "./commitDate";
import { version } from "../package.json";
import { createHunkNotes, HunkNotes } from "./HunkNote";
import { FileEditor, type EditorTarget, type HunkMarks } from "./FileEditor";
import { forgetWindowGrowth, growWindow, shrinkWindow } from "./windowGrow";
import { highlightRows, numberedDiffRows, repositoryKey, mcpConfiguration, type McpRequest, type McpConnection } from "./mcpNavigation";
import "./App.css";

type Status = { path: string; index: string; worktree: string; worktreeRevision?: string; indexRevision?: string };
type Ref = { name: string; kind: string; target: string; isHead: boolean; ahead?: number; behind?: number };
type Commit = { hash: string; parents: string[]; subject: string; author: string; timestamp: number; decorations: string[] };
type Repo = { refsHash?: string; path: string; name: string; branch: string; head: string | null; status: Status[]; refs: Ref[]; remotes: string[]; commits: Commit[]; hasMore: boolean; operation?: string | null; rebaseEditPause?: boolean; loading?: boolean; loadError?: string };
type RepoState = { refsHash?: string; branch: string; head: string | null; status: Status[]; operation?: string | null; rebaseEditPause?: boolean };
type SearchResult = { commits: Commit[]; hasMore: boolean };
type Details = { hash: string; subject: string; body: string; author: string; authorEmail: string; timestamp: number; parents: string[]; files: { path: string; status: string; additions?: number | null; deletions?: number | null }[]; tree?: string; additions?: number | null; deletions?: number | null };
type Choice = { id?: string; path: string; status: string; target: string; revision?: string; modified?: number; additions?: number | null; deletions?: number | null };
type Diff = { text: string; truncated: boolean };
type EditableFile = { content: string };
// A question ssh asked while connecting: target is user@host for a password, the key file for a passphrase.
type SshPrompt = { id: number; kind: "password" | "passphrase" | "confirm" | "other"; target: string; text: string; error?: string | null };
type SavedFile = { staged: boolean; warning: string | null };
type CompareResult = { mergeBase: string; commits: number; files: { path: string; status: string; additions?: number | null; deletions?: number | null }[]; additions: number; deletions: number };
type Comparison = { base: string; head: string; baseHash: string; headHash: string; result: CompareResult | null; error: string; automatic?: boolean };
type FileDraft = { repo: string; path: string; source: string; original: string; text: string; newline: "\n" | "\r\n" | "\r"; stageOnSave: boolean };
type FileHistoryEntry = { hash: string; subject: string; author: string; timestamp: number; path: string };
type FileHistoryResult = { commits: FileHistoryEntry[]; hasMore: boolean };
type BlameLine = { line: number; hash: string; author: string; timestamp: number; summary: string; content: string };
type BlameResult = { lines: BlameLine[]; hasMore: boolean };
type RebaseCommit = { hash: string; subject: string; message: string };
type RebaseStep = RebaseCommit & { action: "pick" | "reword" | "edit" | "squash" | "fixup" | "drop"; editedMessage?: string };
type RefNode = { label: string; path: string; ref?: Ref; children: RefNode[]; count: number; containsHead: boolean };
type Operation = { kind: "stage_all" | "fetch" | "pull" | "pull_merge" | "pull_rebase" | "push" | "force_push_with_lease" | "abort_operation" | "continue_operation" | "amend_no_edit" } | { kind: "stage_file" | "unstage_file" | "discard_file"; value: { path: string } } | { kind: "stage_files" | "unstage_files" | "discard_files" | "delete_untracked"; value: { paths: string[] } } | { kind: "stage_hunk"; value: { path: string; index: number; reverse: boolean } } | { kind: "discard_hunk"; value: { path: string; index: number; diff: string } } | { kind: "stage_lines" | "unstage_lines" | "discard_lines"; value: { path: string; lines: number[]; diff: string } } | { kind: "commit"; value: { message: string; amend: boolean } } | { kind: "checkout" | "create_branch" | "delete_branch" | "force_delete_branch" | "merge" | "rebase"; value: { branch: string } } | { kind: "track_remote_branch" | "push_branch" | "delete_remote_branch"; value: { remote: string; branch: string } } | { kind: "rename_branch"; value: { branch: string; new_name: string } } | { kind: "interactive_rebase"; value: { branch: string; onto: string; steps: { hash: string; action: RebaseStep["action"]; message?: string }[] } } | { kind: "stash"; value: { message: string } } | { kind: "apply_stash" | "pop_stash" | "cherry_pick" | "revert" | "detach"; value: { hash: string } } | { kind: "reset"; value: { hash: string; mode: "soft" | "mixed" | "hard" } } | { kind: "create_tag"; value: { name: string; hash: string } } | { kind: "delete_tag"; value: { name: string } } | { kind: "push_tag" | "delete_remote_tag"; value: { remote: string; name: string } } | { kind: "resolve_file"; value: { path: string; side: "ours" | "theirs" } };
type ActionDialogField = { key: string; label: string; value: string; options?: string[]; placeholder?: string; required?: boolean };
type ActionDialog = { title: string; description?: string; submitLabel: string; danger?: boolean; fields: ActionDialogField[]; onSubmit: (values: Record<string, string>) => void };
const recentKey = "gitferry.recent";
const tabsKey = "gitferry.openTabs";
const activeKey = "gitferry.activeTab";
const themeKey = "gitferry.theme";
const editorKey = "gitferry.editor";
const editorExecutableKey = "gitferry.editorExecutable";
const tabBranchKey = "gitferry.showTabBranch";
const expansionKey = "gitferry.expansion";
const tabStateKey = "gitferry.tabState";
const testsClosedKey = "gitferry.keepTestsClosed";
const fullFileKey = "gitferry.fullFile";
const detailsViewKey = "gitferry.detailsView";
const whitespaceKey = "gitferry.ignoreWhitespace";
const uiFontKey = "gitferry.uiFont";
const codeFontKey = "gitferry.codeFont";
const codeSizeKey = "gitferry.codeSize";
const sideEditorKey = "gitferry.sideEditor";
const uiFontFallback = `"Segoe UI", -apple-system, BlinkMacSystemFont, system-ui, sans-serif`;
const codeFontFallback = `Consolas, "SFMono-Regular", Menlo, "Liberation Mono", monospace`;
// A chosen font goes first, with the defaults behind it in case it is not installed.
const fontStack = (name: string, fallback: string) => {
  const clean = name.replace(/["';{}]/g, "").trim();
  return clean ? `"${clean}", ${fallback}` : fallback;
};
const testFilePattern = /(^|\/)(__tests__|tests?|specs?)\/|\.(test|spec)\.[^/]+$|(^|\/)test_[^/]*$|_(test|spec)\.[^/.]+$/i;
const editorOptions = [
  { id: "antigravity", label: "Antigravity" },
  { id: "vscode", label: "VS Code" },
  { id: "sublime", label: "Sublime Text" },
] as const;
type EditorId = (typeof editorOptions)[number]["id"];
const storedEditor = localStorage.getItem(editorKey);
const initialEditor: EditorId = editorOptions.find(option => option.id === storedEditor)?.id ?? "antigravity";
const themeOptions = [
  { id: "antigravity", label: "Antigravity Dark" },
  { id: "vscode", label: "VS Code Dark" },
  { id: "sublime", label: "Sublime Merge" },
  { id: "claude", label: "Claude Code" },
] as const;
type ThemeId = (typeof themeOptions)[number]["id"];
const storedTheme = localStorage.getItem(themeKey);
const initialTheme: ThemeId = themeOptions.find(option => option.id === storedTheme)?.id ?? "antigravity";
const demoMode = import.meta.env.DEV && new URLSearchParams(location.search).has("demo");
function savedSideEditor(): EditorTarget | null {
  if (demoMode) return null;
  try {
    const saved = JSON.parse(localStorage.getItem(sideEditorKey) ?? "null");
    if (!saved || typeof saved.repo !== "string" || typeof saved.path !== "string") return null;
    return { repo: saved.repo, path: saved.path, commit: typeof saved.commit === "string" ? saved.commit : undefined, line: Number(saved.line) || 0, marks: null, nonce: 0 };
  } catch { return null; }
}
function savedSession(): { tabs: Repo[]; activePath: string | null } {
  if (!isTauri() || demoMode) return { tabs: [], activePath: null };
  try {
    const stored = JSON.parse(localStorage.getItem(tabsKey) ?? "[]");
    if (!Array.isArray(stored)) return { tabs: [], activePath: null };
    const paths = [...new Set(stored.filter((path): path is string => typeof path === "string" && Boolean(path.trim())))];
    const tabs = paths.map(path => ({
      path, name: path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path,
      branch: "Loading…", head: null, status: [], refs: [], remotes: [], commits: [], hasMore: false, loading: true,
    }));
    const selected = localStorage.getItem(activeKey);
    return { tabs, activePath: selected && paths.includes(selected) ? selected : paths[0] ?? null };
  } catch { return { tabs: [], activePath: null }; }
}
const commitRowHeight = 56;
// One-line commit rows when details are shown below the history.
const compactCommitRowHeight = 32;
const workingRowHeight = 68;
const compareRowHeight = 52;
// Colors are palette indexes: a lane takes its branch's color, or falls back to its position.
type GraphStep = { lane: number; before: number[]; parents: number[]; beforeColors: number[]; nodeColor: number; parentColors: number[] };
const graphColors: Record<ThemeId, string[]> = {
  antigravity: ["#4d9bd8", "#b89bd7", "#d4ae73", "#83bd95", "#e0a070", "#e08a8a", "#6cc5c0", "#c9c26a", "#d69bc4", "#9aa0e8"],
  vscode: ["#4fc1ff", "#c586c0", "#d7ba7d", "#89c996", "#9bb7ed", "#f48771", "#4ec9b0", "#dcdcaa", "#d7a0d9", "#ce9178"],
  sublime: ["#e8a866", "#b6a0d2", "#74b9c0", "#97c58f", "#d5b87c", "#e38b8b", "#8fb3e3", "#c7c26e", "#d59ac0", "#7fcfb0"],
  claude: ["#df8065", "#c5a5d3", "#d3b579", "#92b9a3", "#a3b4ce", "#d98fa6", "#7fb8c9", "#c2c27a", "#b39ddb", "#e0a07a"],
};
const graphPaletteSize = 10;
const mainBranch = /^(main|master|develop|trunk)$/;
// Local and remote-tracking refs share a key ("origin/feat/x" -> "feat/x") so they share a color.
function branchKey(label: string, remotes: string[]): string | null {
  const name = label.replace(/^HEAD -> /, "");
  if (name === "HEAD" || name.startsWith("tag: ") || name.startsWith("refs/")) return null;
  const remote = remotes.find(item => name.startsWith(`${item}/`));
  const branch = remote ? name.slice(remote.length + 1) : name;
  return branch && branch !== "HEAD" ? branch : null;
}
function branchColorIndex(key: string): number {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return Math.abs(hash) % graphPaletteSize;
}
const graphOutlines: Record<ThemeId, string> = { antigravity: "#242424", vscode: "#252526", sublime: "#293039", claude: "#1a1a1a" };

function groupRefs(refs: Ref[], folders: boolean): RefNode[] {
  const root: RefNode = { label: "", path: "", children: [], count: 0, containsHead: false };
  for (const ref of refs) {
    const parts = folders ? ref.name.split("/") : [ref.name];
    let parent = root;
    for (const part of parts.slice(0, -1)) {
      let folder = parent.children.find(item => !item.ref && item.label === part);
      if (!folder) {
        folder = { label: part, path: `${parent.path}${part}/`, children: [], count: 0, containsHead: false };
        parent.children.push(folder);
      }
      folder.count++;
      folder.containsHead ||= ref.isHead;
      parent = folder;
    }
    parent.children.push({ label: parts[parts.length - 1], path: ref.name, ref, children: [], count: 1, containsHead: ref.isHead });
  }
  const sort = (nodes: RefNode[]) => {
    nodes.sort((a, b) => Number(Boolean(a.ref)) - Number(Boolean(b.ref)) || a.label.localeCompare(b.label));
    nodes.forEach(node => sort(node.children));
  };
  sort(root.children);
  return root.children;
}

function RefTree(props: { nodes: RefNode[]; kind: string; depth: number; overrides: Record<string, boolean>; onToggle: (key: string, open: boolean) => void; onSelect: (hash: string) => void; onMenu: (ref: Ref, anchor: HTMLElement, point?: { x: number; y: number }) => void; onCheckout: (ref: Ref) => void; colorFor: (ref: Ref) => string | undefined }) {
  const hasMenu = (ref: Ref) => ["branch", "remote", "tag"].includes(props.kind) && !(props.kind === "remote" && ref.name.endsWith("/HEAD"));
  return <For each={props.nodes}>{node => <Show when={!node.ref} fallback={<div class="ref-entry"><button class={`ref-item ${node.ref?.isHead ? "current" : ""}`} style={{ "padding-left": `${(props.kind === "branch" ? 22 : 25) + props.depth * 14}px` }} title={node.path} disabled={props.kind === "submodule"} onClick={() => props.onSelect(node.ref!.target)} onDblClick={() => { if (props.kind === "branch" || props.kind === "remote") props.onCheckout(node.ref!); }} onContextMenu={event => { if (!hasMenu(node.ref!)) return; event.preventDefault(); props.onMenu(node.ref!, event.currentTarget, { x: event.clientX, y: event.clientY }); }}>
    <Show when={props.colorFor(node.ref!)}>{color => <span class="branch-dot" style={{ background: color() }} />}</Show><Show when={props.kind !== "branch" && !props.colorFor(node.ref!)}><span class="ref-icon">{props.kind === "remote" ? "☁" : props.kind === "stash" ? "◷" : props.kind === "submodule" ? "▣" : "◇"}</span></Show><span class="ref-name">{node.label}</span><Show when={node.ref?.isHead}><span class="ref-head">HEAD</span></Show><Show when={node.ref?.ahead}><span class="ref-tracking" title={`${node.ref!.ahead} commits to push`}>{node.ref!.ahead}↑</span></Show><Show when={node.ref?.behind}><span class="ref-tracking" title={`${node.ref!.behind} commits to pull`}>{node.ref!.behind}↓</span></Show>
  </button><Show when={hasMenu(node.ref!)}><button class="ref-action-trigger" title={`Actions for ${node.path}`} aria-label={`Actions for ${node.path}`} onClick={event => props.onMenu(node.ref!, event.currentTarget)}><Icon name="more" /></button></Show></div>}>
    {(() => {
      const key = `${props.kind}:${node.path}`;
      const open = () => props.overrides[key] ?? node.containsHead;
      return <><button class="ref-folder" style={{ "padding-left": `${14 + props.depth * 14}px` }} aria-expanded={open()} onClick={() => props.onToggle(key, !open())}><span class="ref-disclosure"><ChevronDown /></span><span class="ref-folder-name">{node.label}</span><span class="ref-folder-count">{node.count}</span></button><Show when={open()}><RefTree nodes={node.children} kind={props.kind} depth={props.depth + 1} overrides={props.overrides} onToggle={props.onToggle} onSelect={props.onSelect} onMenu={props.onMenu} onCheckout={props.onCheckout} colorFor={props.colorFor} /></Show></>;
    })()}
  </Show>}</For>;
}

function parseDiffLines(value: Diff | null) {
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

function firstChangedLine(value: Diff | null): number {
  let nextLine = 1;
  for (const row of parseDiffLines(value)) {
    if (row.kind === "hunk") {
      nextLine = Number(/\+(\d+)/.exec(row.line)?.[1] ?? 1);
    } else if (row.kind === "added") {
      return Math.max(1, row.newNumber ?? nextLine);
    } else if (row.kind === "deleted") {
      return Math.max(1, nextLine);
    } else if (row.newNumber !== null) {
      nextLine = row.newNumber + 1;
    }
  }
  return 1;
}

function copyDiffSelection(event: ClipboardEvent) {
  const selection = window.getSelection();
  const container = event.currentTarget as HTMLElement;
  if (!selection || selection.isCollapsed || !event.clipboardData || !container.contains(selection.anchorNode) || !container.contains(selection.focusNode)) return;
  const selectedRange = selection.getRangeAt(0);
  const copied: string[] = [];
  let prefixed: boolean | undefined;
  for (const row of container.querySelectorAll<HTMLElement>(".diff-line")) {
    const text = row.querySelector<HTMLElement>(".line-text");
    if (!text || getComputedStyle(text).visibility === "hidden" || !selectedRange.intersectsNode(text)) continue;
    const lineRange = document.createRange();
    lineRange.selectNodeContents(text);
    const part = selectedRange.cloneRange();
    if (part.compareBoundaryPoints(Range.START_TO_START, lineRange) < 0) part.setStart(lineRange.startContainer, lineRange.startOffset);
    if (part.compareBoundaryPoints(Range.END_TO_END, lineRange) > 0) part.setEnd(lineRange.endContainer, lineRange.endOffset);
    // A selection starting inside the indentation counts as the whole line, so it keeps its indentation and diff prefix.
    const before = document.createRange();
    before.setStart(lineRange.startContainer, lineRange.startOffset);
    before.setEnd(part.startContainer, part.startOffset);
    if (!before.toString().trim()) part.setStart(lineRange.startContainer, lineRange.startOffset);
    const value = part.toString();
    if (!value && !(lineRange.collapsed && row.dataset.copyPrefix)) continue;
    // Diff prefixes are added only when the selection starts at a line start; one starting mid-line copies plain code.
    prefixed ??= part.compareBoundaryPoints(Range.START_TO_START, lineRange) === 0;
    copied.push(`${prefixed ? row.dataset.copyPrefix ?? "" : ""}${value}`);
  }
  if (!copied.length) return;
  event.clipboardData.setData("text/plain", copied.join("\n"));
  event.preventDefault();
}

const CONFIRM_TIMEOUT_MS = 10_000;

/** Destructive button confirmed in place, like Sublime Merge: the first click arms it (red), a second click within CONFIRM_TIMEOUT_MS runs it. Changing `resetKey` or `disabled` disarms it. */
function ConfirmButton(props: { class: string; disabled?: boolean; resetKey?: unknown; onConfirm: () => void; children: JSX.Element }) {
  const [armed, setArmed] = createSignal(false);
  let timer: number | undefined;
  const disarm = () => { window.clearTimeout(timer); setArmed(false); };
  createEffect(on([() => props.resetKey, () => props.disabled], disarm, { defer: true }));
  onCleanup(() => window.clearTimeout(timer));
  return <button class={`${props.class} ${armed() ? "armed" : ""}`} disabled={props.disabled} aria-pressed={armed()} title={armed() ? "Click again to confirm" : undefined} onClick={() => {
    if (armed()) { disarm(); props.onConfirm(); return; }
    setArmed(true);
    timer = window.setTimeout(() => setArmed(false), CONFIRM_TIMEOUT_MS);
  }}>{props.children}</button>;
}

// Branch comparisons diff "<merge base>..<head>"; other targets are a commit hash or a working-tree area.
const isComparisonTarget = (target: string) => target.includes("..");
const isWorkingTarget = (target: string) => target === "working" || target === "staged" || target === "untracked";
// A full-context diff lists every line of the file's new version, so it rebuilds the file as of a commit.
function fileFromFullDiff(value: Diff): string {
  if (value.truncated) throw new Error("This file is too large to show as of a commit.");
  if (!value.text.includes("\n@@ ")) throw new Error("This file has no text content in this commit.");
  const lines: string[] = [];
  let noNewline = false;
  for (const row of parseDiffLines(value)) {
    if (row.hunkIndex < 0) continue;
    if (row.newNumber !== null) { lines.push(row.line.slice(1)); noNewline = false; }
    else if (row.line.startsWith("\\") && lines.length) noNewline = true;
  }
  return lines.join("\n") + (noNewline ? "" : "\n");
}

// Each mounted diff owns its selection, including expanded Summary cards. Weak keys disappear when a card closes.
const diffViews = new WeakMap<HTMLElement, () => { value: Diff; item: Choice; selection: { rows: number[]; hunkIndex: number | null } }>();

function DiffText(props: { value: Diff; item: Choice; working: boolean; ignoreWhitespace: boolean; fullContext?: boolean; actionBusy: boolean; repoPath: string; aiRows?: ReadonlySet<number>; onSelection?: (value: { rows: number[]; hunkIndex: number | null }) => void; onAction: (operation: Operation, confirmation?: string) => void; onOpenEditor?: (line: number, marks: HunkMarks | null) => void }) {
  const lines = createMemo(() => parseDiffLines(props.value));
  const highlighted = createMemo(() => highlightDiff(lines(), props.item.path, props.value.text.length));
  // Rows keyed by content keep their DOM when the diff reloads; only changed lines, shifted line numbers and tokens update.
  const [rows, setRows] = createStore<(ReturnType<typeof parseDiffLines>[number] & { key: string; parts: ReturnType<typeof highlightDiff>[number] })[]>([]);
  createComputed(() => {
    const parts = highlighted();
    const seen = new Map<string, number>();
    setRows(reconcile(numberedDiffRows(lines(), props.item.target).map((row, index) => {
      const base = `${row.kind}\u0000${row.line}`;
      const occurrence = seen.get(base) ?? 0;
      seen.set(base, occurrence + 1);
      return { ...row, key: `${base}\u0000${occurrence}`, parts: parts[index] ?? [] };
    }), { key: "key" }));
  });
  const hunkCount = createMemo(() => lines().filter(line => line.kind === "hunk").length);
  const hunkNotes = createHunkNotes(() => props.repoPath, () => props.item.path, lines, () => (props.working && ["working", "staged", "untracked"].includes(props.item.target)) || isComparisonTarget(props.item.target));
  const [selectedLines, setSelectedLines] = createSignal<number[]>([]);
  const [selectedHunk, setSelectedHunk] = createSignal(0);
  createEffect(() => props.onSelection?.({ rows: selectedLines(), hunkIndex: hunkCount() ? selectedHunk() : null }));
  const selectedSet = createMemo(() => new Set(selectedLines()));
  const fileOnlyChange = createMemo(() => /(^|\n)(new file mode|deleted file mode|rename from|rename to|copy from|copy to|old mode|new mode)/.test(props.value.text));
  const lineStageNote = createMemo(() => props.value.truncated ? "Diff too large for line actions; use the file action." : props.value.text.includes("\\ No newline at end of file") ? "Use the hunk action when a file has no final newline." : fileOnlyChange() ? "Use the file action for rename or mode changes." : "");
  const actionable = createMemo(() => props.working && props.item.status !== "U" && !props.ignoreWhitespace && !props.fullContext && (props.item.target === "working" || props.item.target === "staged"));
  const lineActionable = createMemo(() => actionable() && !lineStageNote());
  const changed = (index: number) => {
    const kind = lines()[index]?.kind;
    return lineActionable() && (kind === "added" || kind === "deleted");
  };
  // Double-clicking a working-tree line opens the file in the side editor at that line, with its hunk highlighted.
  // Working-tree files open editable; a commit's or comparison's files open read-only as of that diff.
  const editorOpenable = createMemo(() => Boolean(props.onOpenEditor) && props.item.status !== "D" && props.item.target !== "tracked" && (props.working || !isWorkingTarget(props.item.target)));
  // What each hunk changed in the new file: its added lines, and the lines that removed lines (not replaced by added ones) sat above.
  const hunkMarks = createMemo(() => {
    const marks = new Map<number, HunkMarks>();
    const of = (hunk: number) => { let value = marks.get(hunk); if (!value) marks.set(hunk, value = { added: [], removed: [] }); return value; };
    let next = 1;
    let removedIn = -1;
    const flushRemoved = (line: number) => { if (removedIn >= 0) of(removedIn).removed.push(Math.max(1, line)); removedIn = -1; };
    for (const row of lines()) {
      if (row.kind === "hunk") { flushRemoved(next); next = Number(/\+(\d+)/.exec(row.line)?.[1] ?? 1); continue; }
      if (row.hunkIndex < 0) continue;
      if (row.kind === "deleted") { removedIn = row.hunkIndex; of(row.hunkIndex); continue; }
      if (row.kind === "added" && row.newNumber !== null) { of(row.hunkIndex).added.push(row.newNumber); removedIn = -1; }
      else if (row.newNumber !== null) flushRemoved(row.newNumber);
      if (row.newNumber !== null) next = row.newNumber + 1;
    }
    flushRemoved(next);
    return marks;
  });
  // Untracked files arrive as raw content rather than a diff, so their rows map 1:1 to file lines.
  // A conflicted file's diff is a combined diff ("@@@" hunks, two prefix columns), which parseDiffLines leaves unnumbered;
  // number its lines in the working file here. Lines without a number (removed ones, headers) open at the first conflict.
  const conflictLines = createMemo(() => {
    if (props.item.status !== "U") return [];
    let next = 0;
    return lines().map(row => {
      const header = /^@@@ -\d+(?:,\d+)? -\d+(?:,\d+)? \+(\d+)/.exec(row.line);
      if (header) { next = Number(header[1]); return null; }
      if (!next || row.line.startsWith("\\") || row.line.slice(0, 2).includes("-")) return null;
      return next++;
    });
  });
  function editorLine(index: number): number | null {
    const row = rows[index];
    if (!row || !editorOpenable()) return null;
    if (props.item.status === "U") return conflictLines()[index] ?? 0;
    if (props.item.target === "untracked" && !hunkCount()) return index + 1;
    if (row.hunkIndex < 0) return null;
    if (row.newNumber !== null) return row.newNumber;
    // A deleted line or hunk header opens where the hunk sits in the new file.
    const marks = hunkMarks().get(row.hunkIndex);
    return marks?.added[0] ?? marks?.removed[0] ?? Number(/\+(\d+)/.exec(lines()[index].line)?.[1] ?? 1);
  }
  function openEditorAt(index: number, event: MouseEvent) {
    const line = editorLine(index);
    if (line === null) return;
    event.preventDefault();
    window.getSelection()?.removeAllRanges();
    const row = rows[index];
    props.onOpenEditor?.(line, row.hunkIndex >= 0 ? hunkMarks().get(row.hunkIndex) ?? null : null);
  }
  let anchor = -1;
  let dragStart = -1;
  let dragged = false;
  createEffect(() => { void props.value.text; setSelectedLines([]); setSelectedHunk(0); anchor = -1; });
  const selectRange = (from: number, to: number) => {
    const range: number[] = [];
    for (let index = Math.min(from, to); index <= Math.max(from, to); index++) if (changed(index)) range.push(index);
    return range;
  };
  function selectLine(index: number, event: MouseEvent) {
    if (dragged) { dragged = false; return; }
    setSelectedHunk(lines()[index].hunkIndex);
    if (event.shiftKey && anchor >= 0) setSelectedLines(current => [...new Set([...current, ...selectRange(anchor, index)])]);
    else { setSelectedLines(current => current.includes(index) ? current.filter(item => item !== index) : [...current, index]); anchor = index; }
  }
  function selectHunk(index: number) {
    setSelectedHunk(index);
    setSelectedLines([]);
    anchor = -1;
  }
  function applySelection(discard: boolean) {
    const path = props.item.path;
    const lineMode = selectedLines().length > 0;
    if (lineMode) {
      const kind = discard ? "discard_lines" : props.item.target === "staged" ? "unstage_lines" : "stage_lines";
      props.onAction({ kind, value: { path, lines: [...selectedLines()].sort((a, b) => a - b), diff: props.value.text } });
    } else {
      const index = selectedHunk();
      const operation: Operation = discard ? { kind: "discard_hunk", value: { path, index, diff: props.value.text } } : { kind: "stage_hunk", value: { path, index, reverse: props.item.target === "staged" } };
      props.onAction(operation);
    }
  }
  return <>
    <Show when={actionable() && hunkCount()}><div class="line-selection-toolbar" data-mode={selectedLines().length ? "lines" : "hunk"}><span>{lineStageNote() || (selectedLines().length ? `${selectedLines().length} line${selectedLines().length === 1 ? "" : "s"} selected` : `Hunk ${selectedHunk() + 1} of ${hunkCount()}`)}</span><Show when={props.item.target === "working"}><ConfirmButton class="discard-selection" disabled={props.actionBusy || props.value.truncated || fileOnlyChange()} resetKey={`${selectedHunk()}:${selectedLines().join()}`} onConfirm={() => applySelection(true)}>{selectedLines().length ? "Discard Lines" : "Discard Hunk"}</ConfirmButton></Show><button class={selectedLines().length ? "stage-lines" : "hunk-action"} disabled={props.actionBusy || props.value.truncated || fileOnlyChange()} onClick={() => applySelection(false)}>{props.item.target === "staged" ? "Unstage" : "Stage"} {selectedLines().length ? "Lines" : "Hunk"}</button></div></Show>
    <div ref={element => diffViews.set(element, () => ({ value: props.value, item: props.item, selection: { rows: selectedLines(), hunkIndex: hunkCount() ? selectedHunk() : null } }))} class={`diff-content ${actionable() ? "actionable" : ""} ${hunkCount() ? "has-hunks" : ""}`} onCopy={copyDiffSelection} onPointerUp={() => { dragStart = -1; }}><For each={rows}>{(row, index) => <><HunkNotes notes={hunkNotes().get(index())} row={row} /><div class={`diff-line ${row.kind} ${selectedSet().has(index()) ? "selected" : ""} ${props.aiRows?.has(index()) ? "ai-highlight" : ""}`} data-row-index={index()} data-old-line={row.oldNumber ?? undefined} data-new-line={row.newNumber ?? undefined} data-copy-prefix={row.hunkIndex >= 0 && (row.kind === "added" || row.kind === "deleted" || row.line.startsWith(" ")) ? row.line.charAt(0) : ""} onClick={event => { if (actionable() && row.hunkIndex >= 0 && !(event.target as HTMLElement).closest("button")) selectHunk(row.hunkIndex); }}>
      <Show when={changed(index())} fallback={<span class="line-number"><span class="old-line">{row.oldNumber ?? ""}</span><span class="new-line">{row.newNumber ?? ""}</span></span>}><button class="line-number selectable" type="button" title="Select line for staging" aria-label={`Select ${row.kind === "added" ? "new" : "old"} line ${row.kind === "added" ? row.newNumber : row.oldNumber}`} aria-pressed={selectedSet().has(index())} onPointerDown={event => { if (event.button === 0) { dragStart = index(); dragged = false; } }} onPointerEnter={event => { if (dragStart >= 0 && index() !== dragStart && (event.buttons & 1)) { dragged = true; anchor = dragStart; setSelectedLines(selectRange(dragStart, index())); } }} onClick={event => selectLine(index(), event)}><span class="old-line">{row.oldNumber ?? ""}</span><span class="new-line">{row.newNumber ?? ""}</span></button></Show>
      <span class="line-text" title={editorOpenable() && editorLine(index()) !== null ? (isWorkingTarget(props.item.target) ? "Double-click to edit in the side editor" : "Double-click to view the file as of this commit") : undefined} onDblClick={event => openEditorAt(index(), event)}><For each={row.parts}>{part => <span class={`${part.types.map(type => `syntax-${type}`).join(" ")} ${part.changed ? "word-change" : ""}`}>{part.text}</span>}</For></span>
    </div></>}</For></div><Show when={props.value.truncated}><div class="truncated-note">Diff preview limited to 512 KB.</div></Show>
  </>;
}

function demoDiff(item: Choice): Diff {
  return { text: `diff --git a/${item.path} b/${item.path}\nindex 2a6d9f1..a83f140 100644\n--- a/${item.path}\n+++ b/${item.path}\n@@ -12,6 +12,9 @@ function RepositoryView() {\n   const branch = repository.branch;\n-  const loading = false;\n+  const loading = repository.isLoading;\n+  const remote = repository.remoteHost;\n+  const preview = "This long sample line checks that changed code wraps inside the diff pane instead of disappearing beyond its right edge, even when the file contains a full sentence with many words and a long identifier like RepositoryPreviewConfigurationWithRemoteTrackingEnabled";\n   return renderHistory(branch);\n }\n`, truncated: false };
}

function DiffCard(props: { item: Choice; repoPath: string; working: boolean; recent: boolean; expanded: boolean; eager: boolean; keyboardSelected: boolean; ignoreWhitespace: boolean; actionBusy: boolean; scrollRoot: HTMLElement; onSelect: () => void; onToggle: () => void; onOpenTab: () => void; onOpenEditor: (diff: Diff | null) => void; onOpenEditorLine: (line: number, marks: HunkMarks | null) => void; onAction: (operation: Operation, confirmation?: string) => void; onError: (error: string) => void }) {
  let element!: HTMLDivElement;
  const [value, setValue] = createSignal<Diff | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [loadError, setLoadError] = createSignal("");
  const [loadedKey, setLoadedKey] = createSignal("");
  let loadId = 0;
  let fileKey = "";
  // A comparison's target moves with its branches; like a new revision, that is a new version of the same file,
  // so the card keeps its diff until the new one arrives.
  const fileIdentity = () => `${props.ignoreWhitespace}:${props.repoPath}:${isComparisonTarget(props.item.target) ? "compare" : props.item.target}:${props.item.path}`;
  const loadKey = () => `${fileIdentity()}:${props.item.target}:${props.item.revision ?? ""}`;
  createEffect(() => {
    const identity = fileIdentity(); void props.item.revision;
    loadId++;
    setLoading(false); setLoadError("");
    // Keep showing the previous diff of the same file until the new one arrives to avoid a loading flash.
    const cached = cachedDiff(loadKey());
    if (identity !== fileKey) {
      fileKey = identity;
      const movedKey = `${props.repoPath}\u0000${props.item.target}\u0000${props.item.path}`;
      const moved = !cached && !props.ignoreWhitespace ? movedDiffs.get(movedKey) : undefined;
      movedDiffs.delete(movedKey);
      setValue(cached ?? moved ?? null); setLoadedKey(cached ? loadKey() : "");
    } else if (cached) { setValue(cached); setLoadedKey(loadKey()); }
  });
  createEffect(() => {
    if (!props.expanded || loadedKey() === loadKey() || loading() || loadError()) return;
    const load = () => {
      setLoading(true);
      const id = loadId;
      const key = loadKey();
      const result = demoMode ? Promise.resolve(demoDiff(props.item)) : invoke<Diff>("repo_diff", { path: props.repoPath, target: props.item.target, file: props.item.path, ignoreWhitespace: props.ignoreWhitespace });
      void result.then(diff => {
        if (!demoMode) cacheDiff(key, diff);
        if (id !== loadId) return;
        const previous = value();
        if (!previous || previous.text !== diff.text || previous.truncated !== diff.truncated) setValue(diff);
        setLoadedKey(key);
      }).catch(cause => { if (id === loadId) { setLoadError(String(cause)); props.onError(String(cause)); } }).finally(() => { if (id === loadId) setLoading(false); });
    };
    if (props.eager) { load(); return; }
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      load();
    }, { root: props.scrollRoot, rootMargin: "400px" });
    observer.observe(element);
    onCleanup(() => observer.disconnect());
  });
  return <div class="all-diff-card summary-diff-card" ref={element} data-path={props.item.path} data-target={props.item.target} onPointerDown={props.onSelect}>
    <div class="summary-diff-heading"><button class={`file-row ${props.keyboardSelected ? "keyboard-selected" : ""}`} aria-expanded={props.expanded} aria-current={props.keyboardSelected ? "true" : undefined} onFocus={props.onSelect} onClick={props.onToggle}><span class={`file-status ${props.item.status === "A" || props.item.status === "U" ? "added" : props.item.status === "D" ? "deleted" : "modified"}`}>{props.item.status}</span><Show when={props.recent}><span class="recent-icon" title="Recently modified"><Icon name="clock" /></span></Show><span class="file-path">{props.item.path}</span><Show when={props.item.target === "staged"}><span class="file-tag">STAGED</span></Show><Show when={props.item.additions != null || props.item.deletions != null}><span class="commit-stats file-stats"><span class="stat-deleted">-{props.item.deletions ?? 0}</span><span class="stat-added">+{props.item.additions ?? 0}</span></span></Show><span class="file-chevron"><ChevronDown /></span></button><Show when={props.working}><span class="row-actions">
      <Show when={props.item.target === "untracked"}><ConfirmButton class="row-action" disabled={props.actionBusy} onConfirm={() => props.onAction({ kind: "delete_untracked", value: { paths: [props.item.path] } })}>Delete</ConfirmButton></Show>
      <Show when={props.item.target === "working" && props.item.status !== "U"}><ConfirmButton class="row-action" disabled={props.actionBusy} onConfirm={() => props.onAction({ kind: "discard_file", value: { path: props.item.path } })}>Discard</ConfirmButton></Show>
      <Show when={props.item.target === "staged"} fallback={<button class="row-action stage" disabled={props.actionBusy} onClick={() => props.onAction({ kind: "stage_file", value: { path: props.item.path } })}>{props.item.target === "working" && props.item.status === "U" ? "Mark resolved" : "Stage"}</button>}><button class="row-action stage" disabled={props.actionBusy} onClick={() => props.onAction({ kind: "unstage_file", value: { path: props.item.path } })}>Unstage</button></Show>
    </span></Show><button class="summary-open-tab" title={`Open ${props.item.path} in a tab`} aria-label={`Open ${props.item.path} in a tab`} onClick={props.onOpenTab}><Icon name="external" /></button><button class="open-editor-button" title={`Open ${props.item.path} in editor`} aria-label={`Open ${props.item.path} in editor`} onClick={() => props.onOpenEditor(value())}><Icon name="code" /></button></div>
    <Show when={props.expanded}><Show when={props.item.target === "working" && props.item.status === "U"}><div class="diff-filter-note">Conflicted file. Edit the file or choose a side in the conflict panel, then mark it resolved.</div></Show><Show when={value()} fallback={<div class="empty-note">{loadError() || "Loading diff…"}</div>}>{current => <DiffText value={current()} item={props.item} working={props.working} ignoreWhitespace={props.ignoreWhitespace} actionBusy={props.actionBusy || loading()} repoPath={props.repoPath} onOpenEditor={props.onOpenEditorLine} onAction={(operation, confirmation) => props.onAction(operation, confirmation)} />}</Show></Show>
  </div>;
}

function GraphRow(props: { step: GraphStep; theme: ThemeId; height: number; head: boolean }) {
  let canvas!: HTMLCanvasElement;
  createEffect(() => {
    const step = props.step;
    const theme = props.theme;
    const height = props.height, nodeY = Math.min(27, height / 2);
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, 74, height);
    const x = (lane: number) => 21 + lane * 12;
    const stroke = (colorIndex: number, fromX: number, fromY: number, toX: number, toY: number) => {
      context.strokeStyle = graphColors[theme][colorIndex];
      context.lineWidth = 2;
      context.beginPath(); context.moveTo(fromX, fromY); context.lineTo(toX, toY); context.stroke();
    };
    step.before.forEach((lane, index) => stroke(step.beforeColors[index], x(lane), 0, x(lane), lane === step.lane ? nodeY : height));
    step.parents.forEach((lane, index) => stroke(step.parentColors[index], x(step.lane), nodeY, x(lane), height));
    context.fillStyle = graphColors[theme][step.nodeColor];
    context.beginPath(); context.arc(x(step.lane), nodeY, props.head ? 6 : 4.5, 0, Math.PI * 2); context.fill();
    context.strokeStyle = graphOutlines[theme]; context.lineWidth = 2; context.stroke();
  });
  return <canvas class="graph-canvas" ref={canvas} width="74" height={props.height} aria-hidden="true" />;
}

const icons = {
  search: ["M7 11.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9Z", "m10.5 10.5 3 3"],
  sidebar: ["M3.5 3h9a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z", "M6.5 3v10"],
  columns: ["M3.5 3h9a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z", "M8.5 3v10"],
  rows: ["M3.5 3h9a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z", "M2.5 8.5h11"],
  branch: ["M5 2.5v8", "M5 13.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z", "M11 6a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z", "M11 6a4 4 0 0 1-4 4H5"],
  refresh: ["M13 8a5 5 0 1 1-1.5-3.55", "M12 2.5v2.5H9.5"],
  fetch: ["M8 2.5v7", "m5 6.5 3 3 3-3", "M3 13h10"],
  pull: ["M8 2.5v11", "m4 9.5 4 4 4-4"],
  push: ["M8 13.5v-11", "m4 6.5 4-4 4 4"],
  stash: ["M2.5 3h11v3h-11z", "M3.5 6v6.5a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V6", "M6.5 9h3"],
  unstash: ["M5.5 3.5 2.5 6.5l3 3", "M2.5 6.5h7a3.5 3.5 0 0 1 0 7H7"],
  plus: ["M8 3v10", "M3 8h10"],
  close: ["m4.5 4.5 7 7", "m11.5 4.5-7 7"],
  settings: ["M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z", "M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4", "M8 12.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9Z"],
  left: ["M10 3.5 5.5 8l4.5 4.5"],
  right: ["m6 3.5 4.5 4.5L6 12.5"],
  down: ["m3.5 6 4.5 4.5L12.5 6"],
  external: ["M6 3.5h6.5V10", "M12.5 3.5 4 12"],
  code: ["m5.5 4.5-3.5 3.5 3.5 3.5", "m10.5 4.5 3.5 3.5-3.5 3.5"],
  clock: ["M8 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12Z", "M8 4.5V8l2.5 1.5"],
  more: ["M3.5 8h.01M8 8h.01M12.5 8h.01"],
  folder: ["M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"],
  up: ["M8 13V3", "m4 7 4-4 4 4"],
  arrowDown: ["M8 3v10", "m4 9 4 4 4-4"],
  eye: ["M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z", "M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"],
  eyeOff: ["M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z", "M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z", "m2.5 2.5 11 11"],
};
type IconName = keyof typeof icons;
// In-memory caches so switching tabs or commits re-renders from memory instead of waiting on the agent.
const detailsCache = new Map<string, Details>();
const movedDiffs = new Map<string, Diff>();
const diffCache = new Map<string, Diff>();
const diffCacheLimit = 20_000_000;
let diffCacheSize = 0;
function cachedDiff(key: string): Diff | undefined {
  const value = diffCache.get(key);
  if (value) { diffCache.delete(key); diffCache.set(key, value); }
  return value;
}
function cacheDiff(key: string, value: Diff) {
  const previous = diffCache.get(key);
  if (previous) { diffCacheSize -= previous.text.length; diffCache.delete(key); }
  diffCache.set(key, value);
  diffCacheSize += value.text.length;
  for (const [oldest, entry] of diffCache) {
    if (diffCacheSize <= diffCacheLimit || oldest === key) break;
    diffCache.delete(oldest);
    diffCacheSize -= entry.text.length;
  }
}
// Sublime Merge marks recently modified untracked files; it does not document the window, so use one day.
const recentlyModifiedMs = 24 * 60 * 60_000;

function Icon(props: { name: IconName }) {
  return <svg class={`icon icon-${props.name}`} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width={props.name === "more" ? 2.2 : 1.5} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><For each={icons[props.name]}>{d => <path d={d} />}</For></svg>;
}

// Reuse unchanged objects from the previous snapshot so refreshes only re-render what changed.
function reuseEqual<T>(previous: T[], next: T[], key: (item: T) => string): T[] {
  const old = new Map(previous.map(item => [key(item), item]));
  const merged = next.map(item => {
    const prior = old.get(key(item));
    return prior && JSON.stringify(prior) === JSON.stringify(item) ? prior : item;
  });
  return merged.length === previous.length && merged.every((item, index) => item === previous[index]) ? previous : merged;
}

function mergeRepo(previous: Repo, update: Repo): Repo {
  const next: Repo = {
    ...update,
    commits: reuseEqual(previous.commits, update.commits, item => item.hash),
    refs: reuseEqual(previous.refs, update.refs, item => `${item.kind}:${item.name}`),
    status: reuseEqual(previous.status, update.status, item => item.path),
    remotes: JSON.stringify(previous.remotes) === JSON.stringify(update.remotes) ? previous.remotes : update.remotes,
  };
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]) as Set<keyof Repo>;
  return [...keys].every(key => previous[key] === next[key]) ? previous : next;
}

function ChevronDown() {
  return <svg class="chevron-icon" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="m2.5 4.5 3.5 3 3.5-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>;
}

function App() {
  const restored = savedSession();
  const [theme, setTheme] = createSignal<ThemeId>(initialTheme);
  const [editor, setEditor] = createSignal<EditorId>(initialEditor);
  const [showTabBranch, setShowTabBranch] = createSignal(localStorage.getItem(tabBranchKey) === "true");
  const [fullFile, setFullFile] = createSignal(localStorage.getItem(fullFileKey) === "true");
  const [uiFont, setUiFont] = createSignal(localStorage.getItem(uiFontKey) ?? "");
  const [codeFont, setCodeFont] = createSignal(localStorage.getItem(codeFontKey) ?? "");
  const [codeSize, setCodeSize] = createSignal(Number(localStorage.getItem(codeSizeKey)) || 13);
  createEffect(() => {
    const root = document.documentElement.style;
    root.setProperty("--ui-font", fontStack(uiFont(), uiFontFallback));
    root.setProperty("--code-font", fontStack(codeFont(), codeFontFallback));
    root.setProperty("--code-size", `${Math.min(24, Math.max(9, codeSize()))}px`);
    localStorage.setItem(uiFontKey, uiFont()); localStorage.setItem(codeFontKey, codeFont()); localStorage.setItem(codeSizeKey, String(codeSize()));
  });
  createEffect(() => localStorage.setItem(fullFileKey, String(fullFile())));
  const [keepTestsClosed, setKeepTestsClosed] = createSignal(localStorage.getItem(testsClosedKey) === "true");
  const [editorExecutable, setEditorExecutable] = createSignal(localStorage.getItem(editorExecutableKey) ?? "");
  const [showSettings, setShowSettings] = createSignal(false);
  const [actionDialog, setActionDialog] = createSignal<ActionDialog | null>(null);
  const [actionDialogValues, setActionDialogValues] = createSignal<Record<string, string>>({});
  const [tabs, setTabs] = createSignal<Repo[]>(restored.tabs);
  const [activePath, setActivePath] = createSignal<string | null>(restored.activePath);
  const [selected, setSelected] = createSignal("working");
  const [details, setDetails] = createSignal<Details | null>(null);
  const [choice, setChoice] = createSignal<Choice | null>(null);
  // A file tab left open while viewing the Summary; it closes with its × or when the view changes.
  const [parkedFile, setParkedFile] = createSignal<Choice | null>(null);
  const [diff, setDiff] = createSignal<Diff | null>(null);
  const [fileView, setFileView] = createSignal<"diff" | "history" | "blame" | "edit">("diff");
  const [fileDraft, setFileDraft] = createSignal<FileDraft | null>(null);
  const [fileEditLoading, setFileEditLoading] = createSignal(false);
  const [fileEditSaving, setFileEditSaving] = createSignal(false);
  const [fileEditError, setFileEditError] = createSignal("");
  const activeFileDraft = createMemo(() => {
    const draft = fileDraft();
    return draft?.repo === activePath() && draft.path === choice()?.path ? draft : null;
  });
  // The side editor opened by double-clicking a diff line.
  // The editor is part of the window: it reopens after a restart with the same file (the window was saved widened with it).
  const [sideEditor, setSideEditor] = createSignal<EditorTarget | null>(savedSideEditor());
  if (!sideEditor()) forgetWindowGrowth();
  createEffect(() => {
    const target = sideEditor();
    if (target) localStorage.setItem(sideEditorKey, JSON.stringify({ repo: target.repo, path: target.path, commit: target.commit, line: target.line }));
    else localStorage.removeItem(sideEditorKey);
  });
  const [sideEditorDirty, setSideEditorDirty] = createSignal(false);
  const [sideEditorWidth, setSideEditorWidth] = createSignal(Number(localStorage.getItem("gitferry.editorWidth")) || 620);
  let sideEditorNonce = 0;
  // Opening the editor widens the window by the editor's width, so the rest of the layout keeps its size; closing it narrows the window back.
  // While the window resizes, the workspace is pinned to its final width (the window clips the overflow), so the
  // existing panes keep their size instead of squeezing for a frame and springing back.
  const [workspaceLock, setWorkspaceLock] = createSignal<number | null>(null);
  let workspaceElement: HTMLElement | undefined;
  async function showSideEditor(target: EditorTarget) {
    if (sideEditor()) { setSideEditor(target); return; }
    const extra = sideEditorWidth() + 1;
    setWorkspaceLock((workspaceElement?.clientWidth ?? window.innerWidth) + extra);
    setSideEditor(target);
    await growWindow(extra);
    setWorkspaceLock(null);
  }
  async function hideSideEditor() {
    setWorkspaceLock(workspaceElement?.clientWidth ?? null);
    await shrinkWindow();
    setSideEditor(null);
    setWorkspaceLock(null);
  }
  const [fileHistory, setFileHistory] = createSignal<FileHistoryResult | null>(null);
  const [fileBlame, setFileBlame] = createSignal<BlameResult | null>(null);
  const [fileInfoLoading, setFileInfoLoading] = createSignal(false);
  const [fileInfoError, setFileInfoError] = createSignal("");
  const [fileFinderOpen, setFileFinderOpen] = createSignal(false);
  const [fileFinderQuery, setFileFinderQuery] = createSignal("");
  const [fileFinderResults, setFileFinderResults] = createSignal<string[]>([]);
  const [fileFinderBusy, setFileFinderBusy] = createSignal(false);
  const [fileFinderError, setFileFinderError] = createSignal("");
  const [ignoreWhitespace, setIgnoreWhitespace] = createSignal(localStorage.getItem(whitespaceKey) === "true");
  // Each repository tab keeps its own comparison, selection and history scroll position.
  const [comparisons, setComparisons] = createSignal<Record<string, Comparison>>({});
  const comparison = () => comparisons()[activePath() ?? ""] ?? null;
  const updateComparison = (path: string, update: (current: Comparison | null) => Comparison | null) => setComparisons(previous => {
    const next = { ...previous };
    const value = update(previous[path] ?? null);
    if (value) next[path] = value; else delete next[path];
    return next;
  });
  const tabViews = new Map<string, { selected: string; scrollTop: number }>();
  // Saved per-tab state from the previous run: comparisons are recomputed and selections restored after each repo loads.
  const pendingComparisons = new Map<string, { base: string; head: string; automatic?: boolean }>();
  const initialSelection = new Map<string, string>();
  try {
    const saved = JSON.parse(localStorage.getItem(tabStateKey) ?? "{}") as Record<string, { selected?: string; compare?: { base: string; head: string; automatic?: boolean } }>;
    for (const [path, view] of Object.entries(saved)) {
      if (view.compare?.base && view.compare.head) {
        pendingComparisons.set(path, view.compare);
        setComparisons(previous => ({ ...previous, [path]: { base: view.compare!.base, head: view.compare!.head, baseHash: "", headHash: "", result: null, error: "", automatic: view.compare!.automatic } }));
      }
      if (view.selected && view.selected !== "working") { initialSelection.set(path, view.selected); tabViews.set(path, { selected: view.selected, scrollTop: 0 }); }
    }
  } catch { /* Ignore invalid saved tab state. */ }
  // Open/closed diffs of each repository's working directory and branch comparison survive restarts; commit views stay per session.
  const savedExpansion = (() => {
    try {
      const value = JSON.parse(localStorage.getItem(expansionKey) ?? "{}");
      return { defaults: value.defaults ?? {}, diffs: value.diffs ?? {} } as { defaults: Record<string, boolean>; diffs: Record<string, boolean> };
    } catch { return { defaults: {}, diffs: {} }; }
  })();
  const [expansionDefaults, setExpansionDefaults] = createSignal<Record<string, boolean>>(savedExpansion.defaults);
  const [summaryDiffs, setSummaryDiffs] = createSignal<Record<string, boolean>>(savedExpansion.diffs);
  createEffect(() => {
    const working = (entries: Record<string, boolean>, matches: (key: string) => boolean) => Object.fromEntries(Object.entries(entries).filter(([key]) => matches(key)));
    localStorage.setItem(expansionKey, JSON.stringify({
      defaults: working(expansionDefaults(), key => key.endsWith(":working") || key.endsWith(":compare")),
      diffs: working(summaryDiffs(), key => key.includes(":working:") || key.includes(":compare:compare:")),
    }));
  });
  const [keyboardFileKey, setKeyboardFileKey] = createSignal<string | null>(null);
  const [folderOverrides, setFolderOverrides] = createSignal<Record<string, boolean>>({});
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [actionBusy, setActionBusy] = createSignal(false);
  const [notice, setNotice] = createSignal("");
  const [progress, setProgress] = createSignal("");
  const [watchFallback, setWatchFallback] = createSignal(false);
  const [cancelToken, setCancelToken] = createSignal<string | null>(null);
  const [cancelRequested, setCancelRequested] = createSignal(false);
  const [commitMessage, setCommitMessage] = createSignal("");
  const [amend, setAmend] = createSignal(false);
  const [branchMenu, setBranchMenu] = createSignal(false);
  const [branchFilter, setBranchFilter] = createSignal("");
  const [tabListOpen, setTabListOpen] = createSignal(false);
  const [tabOverflow, setTabOverflow] = createSignal(false);
  const [canScrollTabsLeft, setCanScrollTabsLeft] = createSignal(false);
  const [canScrollTabsRight, setCanScrollTabsRight] = createSignal(false);
  const [refMenu, setRefMenu] = createSignal<{ ref: Ref; x: number; y: number } | null>(null);
  const [rebasePlan, setRebasePlan] = createSignal<{ onto: string; branch: string; steps: RebaseStep[] } | null>(null);
  const [rebaseAmendMessage, setRebaseAmendMessage] = createSignal("");
  const [rebaseLoading, setRebaseLoading] = createSignal(false);
  const [pushMenu, setPushMenu] = createSignal(false);
  const [pullMenu, setPullMenu] = createSignal(false);
  const [stashMenu, setStashMenu] = createSignal(false);
  const [moreMenu, setMoreMenu] = createSignal(false);
  const [searchOpen, setSearchOpen] = createSignal(false);
  // Errors and Git progress show in the toolbar's center box instead of pushing the panes down.
  const [errorDetails, setErrorDetails] = createSignal(false);
  const [newBranch, setNewBranch] = createSignal("");
  const [searchInput, setSearchInput] = createSignal("");
  const [searchQuery, setSearchQuery] = createSignal("");
  const [searchResult, setSearchResult] = createSignal<SearchResult>({ commits: [], hasMore: false });
  const [searchBusy, setSearchBusy] = createSignal(false);
  const [paletteOpen, setPaletteOpen] = createSignal(false);
  const [draggingFolder, setDraggingFolder] = createSignal(false);
  const [paletteInput, setPaletteInput] = createSignal("");
  const [showOpen, setShowOpen] = createSignal(false);
  const [openKind, setOpenKind] = createSignal<"local" | "remote">("local");
  const [pathInput, setPathInput] = createSignal("");
  const [hostInput, setHostInput] = createSignal("");
  const [remotePathInput, setRemotePathInput] = createSignal("");
  const [sshPrompt, setSshPrompt] = createSignal<SshPrompt | null>(null);
  const [sshAnswer, setSshAnswer] = createSignal("");
  const [sshRemember, setSshRemember] = createSignal(false);
  const [sshReveal, setSshReveal] = createSignal(false);
  const [savedSsh, setSavedSsh] = createSignal<string[]>([]);
  const [locationsOpen, setLocationsOpen] = createSignal(true);
  const [bottomLayout, setBottomLayout] = createSignal(localStorage.getItem("gitferry.bottomLayout") === "true");
  const [locationsWidth, setLocationsWidth] = createSignal(Number(localStorage.getItem("gitferry.locationsWidth")) || 205);
  const [commitsWidth, setCommitsWidth] = createSignal(Number(localStorage.getItem("gitferry.commitsWidth")) || 365);
  const [commitsHeight, setCommitsHeight] = createSignal(Number(localStorage.getItem("gitferry.commitsHeight")) || 320);
  const [recent, setRecent] = createSignal<string[]>([]);
  const [mcpConnection, setMcpConnection] = createSignal<McpConnection | null>(null);
  const [mcpError, setMcpError] = createSignal("");
  const [mcpBusy, setMcpBusy] = createSignal(false);
  const [mcpPort, setMcpPort] = createSignal(Number(localStorage.getItem("gitferry.mcpPort")) || 39847);
  const [mcpHighlight, setMcpHighlight] = createSignal<{ repo: string; target: string; file: string; text: string; rows: Set<number> } | null>(null);
  const [diffSelection, setDiffSelection] = createSignal<{ rows: number[]; hunkIndex: number | null }>({ rows: [], hunkIndex: null });
  const [revealedCommit, setRevealedCommit] = createSignal<{ repo: string; commit: Commit } | null>(null);
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewportHeight, setViewportHeight] = createSignal(600);
  createEffect(() => {
    document.documentElement.dataset.theme = theme();
    localStorage.setItem(themeKey, theme());
    // Match the native Windows title bar to the tab bar.
    const style = getComputedStyle(document.documentElement);
    if (isTauri() && !demoMode) void invoke("set_titlebar_color", { background: style.getPropertyValue("--theme-chrome").trim(), text: style.getPropertyValue("--theme-text").trim() }).catch(() => {});
  });
  createEffect(() => {
    localStorage.setItem(editorKey, editor());
    localStorage.setItem(editorExecutableKey, editorExecutable());
  });
  createEffect(() => localStorage.setItem(tabBranchKey, String(showTabBranch())));
  createEffect(() => localStorage.setItem(testsClosedKey, String(keepTestsClosed())));
  createEffect(() => localStorage.setItem(whitespaceKey, String(ignoreWhitespace())));
  let request = 0;
  // The revision of the file whose diff the file tab shows; a refresh reloads it only when this changes.
  let shownDiffRevision = "";
  // The request id of the file tab's diff load in flight, 0 when none.
  let loadingFileDiff = 0;
  let fileInfoRequest = 0;
  let fileEditRequest = 0;
  let fileFinderRequest = 0;
  let fileFinderTimer: ReturnType<typeof setTimeout> | undefined;
  let stateBusy = false;
  let navigationArea: "commits" | "files" = "commits";
  const [tabDrag, setTabDrag] = createSignal<{ path: string; from: number; to: number; dx: number; width: number; settling: boolean } | null>(null);
  let suppressTabClick = false;
  let tabStrip!: HTMLDivElement;
  let commitScroll!: HTMLDivElement;
  let detailsScroll!: HTMLDivElement;
  const repo = createMemo(() => tabs().find(item => item.path === activePath()) ?? null);
  const tabBranchVisibility = createMemo(() => {
    const seen = new Set<string>();
    return new Map(tabs().map(item => {
      const name = item.name.toLocaleLowerCase();
      const visible = showTabBranch() || seen.has(name);
      seen.add(name);
      return [item.path, visible] as const;
    }));
  });
  const tabDisplayName = (item: Repo) => tabBranchVisibility().get(item.path) ? `${item.name} · ${item.branch}` : item.name;
  const matchingLocalBranches = createMemo(() => repo()?.refs.filter(item => item.kind === "branch" && item.name.toLocaleLowerCase().includes(branchFilter().trim().toLocaleLowerCase())) ?? []);
  const matchingRemoteBranches = createMemo(() => repo()?.refs.filter(item => item.kind === "remote" && !item.name.endsWith("/HEAD") && item.name.toLocaleLowerCase().includes(branchFilter().trim().toLocaleLowerCase())) ?? []);
  function openActionDialog(dialog: ActionDialog) {
    setActionDialogValues(Object.fromEntries(dialog.fields.map(field => [field.key, field.value])));
    setActionDialog(dialog);
  }
  function submitActionDialog() {
    const dialog = actionDialog();
    if (!dialog) return;
    const values = Object.fromEntries(Object.entries(actionDialogValues()).map(([key, value]) => [key, value.trim()]));
    if (dialog.fields.some(field => field.required !== false && !values[field.key])) return;
    setActionDialog(null);
    dialog.onSubmit(values);
  }
  function updateTabScroll() {
    if (!tabStrip) return;
    setTabOverflow(tabStrip.scrollWidth > tabStrip.clientWidth + 1);
    setCanScrollTabsLeft(tabStrip.scrollLeft > 1);
    setCanScrollTabsRight(tabStrip.scrollLeft + tabStrip.clientWidth < tabStrip.scrollWidth - 1);
  }
  function revealActiveTab() {
    if (!tabStrip) return;
    const active = tabStrip.querySelector<HTMLElement>(".repo-tab.active");
    if (!active) return;
    const viewport = tabStrip.getBoundingClientRect();
    const tab = active.getBoundingClientRect();
    if (tab.left < viewport.left) tabStrip.scrollLeft += tab.left - viewport.left;
    else if (tab.right > viewport.right) tabStrip.scrollLeft += tab.right - viewport.right;
    updateTabScroll();
  }
  function activateTab(path: string) {
    const previous = activePath();
    if (previous === path) return;
    if (previous) tabViews.set(previous, { selected: selected(), scrollTop: commitScroll?.scrollTop ?? 0 });
    setActivePath(path); setNotice(""); setStashMenu(false); setTabListOpen(false);
    setScrollTop(0); setSearchQuery(""); setSearchInput(""); setSearchOpen(false);
    if (commitScroll) commitScroll.scrollTop = 0;
    const view = tabViews.get(path);
    if (view?.selected === "compare" && comparisons()[path]) showComparison();
    else if (view && view.selected !== "working" && view.selected !== "compare") void selectCommit(view.selected);
    else selectWorking();
    if (view?.scrollTop) requestAnimationFrame(() => { if (activePath() === path && commitScroll) { commitScroll.scrollTop = view.scrollTop; setScrollTop(commitScroll.scrollTop); } });
    saveTabs();
  }
  createEffect(() => { tabs(); requestAnimationFrame(updateTabScroll); });
  createEffect(() => { activePath(); requestAnimationFrame(revealActiveTab); });
  createEffect(() => { tabOverflow(); requestAnimationFrame(updateTabScroll); });
  const repoReady = createMemo(() => Boolean(repo() && !repo()?.loading && !repo()?.loadError));
  const busyStatus = () => actionBusy() && Boolean(progress() || cancelToken());
  createEffect(on(error, () => setErrorDetails(false), { defer: true }));
  const stashes = createMemo(() => repo()?.refs.filter(item => item.kind === "stash") ?? []);
  const conflicts = createMemo(() => repo()?.status.filter(item => item.index === "U" || item.worktree === "U" || ["AA", "DD"].includes(item.index + item.worktree)) ?? []);
  const displayedCommits = createMemo(() => {
    const commits = searchQuery() ? searchResult().commits : repo()?.commits ?? [];
    const revealed = revealedCommit();
    return revealed?.repo === activePath() && selected() === revealed.commit.hash && !commits.some(item => item.hash === revealed.commit.hash) ? [revealed.commit, ...commits] : commits;
  });
  const hasMore = createMemo(() => searchQuery() ? searchResult().hasMore : repo()?.hasMore ?? false);
  // A keyed store keeps each file's object stable across refreshes; a changed revision or status
  // updates that one card in place instead of remounting it.
  const [workingStore, setWorkingStore] = createStore<Choice[]>([]);
  createComputed(() => {
    const choice = (path: string, status: string, target: string, revision?: string, worktreeRevision?: string): Choice => {
      // worktreeRevision is "<mtime ns>:<size>"; keep the mtime in milliseconds for the recently-modified marker.
      const nanos = Number(worktreeRevision?.split(":")[0]);
      return { id: `${target}:${path}`, path, status, target, revision, modified: nanos ? Math.floor(nanos / 1e6) : undefined };
    };
    const next = (repo()?.status ?? []).flatMap(item => {
      if (item.index === "?" && item.worktree === "?") return [choice(item.path, "U", "untracked", item.worktreeRevision, item.worktreeRevision)];
      if (item.index === "U" || item.worktree === "U" || ["AA", "DD"].includes(item.index + item.worktree)) return [choice(item.path, "U", "working", `${item.indexRevision ?? ""}:${item.worktreeRevision ?? ""}`, item.worktreeRevision)];
      const files: Choice[] = [];
      if (item.worktree !== " " && item.worktree !== "?") files.push(choice(item.path, item.worktree, "working", `${item.indexRevision ?? ""}:${item.worktreeRevision ?? ""}`, item.worktreeRevision));
      if (item.index !== " " && item.index !== "?") files.push(choice(item.path, item.index, "staged", item.indexRevision, item.worktreeRevision));
      return files;
    });
    setWorkingStore(reconcile(next, { key: "id" }));
  });
  const workingFiles = () => workingStore;
  // Comparison files are keyed by path the same way: when a branch moves, each card keeps its object and only its target changes.
  const [compareStore, setCompareStore] = createStore<Choice[]>([]);
  createComputed(() => {
    const current = comparison(), result = current?.result;
    const target = current && result ? `${result.mergeBase}..${current.headHash}` : "";
    setCompareStore(reconcile(result ? result.files.map(item => ({ ...item, target })) : [], { key: "path" }));
  });
  const [now, setNow] = createSignal(Date.now());
  const clock = window.setInterval(() => setNow(Date.now()), 30_000);
  onCleanup(() => window.clearInterval(clock));
  const commitLabel = createMemo(() => {
    const staged = workingFiles().filter(item => item.target === "staged").length;
    return amend() ? "Amend commit" : staged ? `Commit ${staged} file${staged === 1 ? "" : "s"}` : "Nothing to commit";
  });
  const commitDecorations = createMemo(() => displayedCommits().find(item => item.hash === details()?.hash)?.decorations ?? []);
  const workingSummary = createMemo(() => {
    const counts = { staged: 0, working: 0, untracked: 0 };
    for (const item of workingFiles()) counts[item.target as keyof typeof counts]++;
    return ([[counts.staged, "staged"], [counts.working, "unstaged"], [counts.untracked, "untracked"]] as const)
      .filter(([count]) => count).map(([count, label]) => `${count} ${label} file${count === 1 ? "" : "s"}`).join(", ");
  });
  const files = createMemo<Choice[]>(() => {
    if (selected() === "working") return workingFiles();
    if (selected() === "compare") return compareStore;
    return (details()?.files ?? []).map(item => ({ ...item, target: selected() }));
  });
  const stagedFiles = createMemo(() => files().filter(item => item.target === "staged"));
  const unstagedFiles = createMemo(() => files().filter(item => item.target === "working"));
  const untrackedFiles = createMemo(() => files().filter(item => item.target === "untracked"));
  const workingGroups = [
    { title: "STAGED", get items() { return stagedFiles(); } },
    { title: "UNSTAGED", get items() { return unstagedFiles(); } },
    { title: "UNTRACKED", get items() { return untrackedFiles(); } },
  ];
  const commitGroup = { title: "", get items() { return files(); } };
  const fileGroups = createMemo(() => selected() === "working" ? workingGroups.filter(group => group.items.length) : [commitGroup]);
  const navigationFiles = createMemo(() => fileGroups().flatMap(group => group.items));
  // Comparison targets change whenever the branches move; key those files by path so opened/closed state survives a refresh.
  const diffKey = (item: Choice) => `${selected() === "compare" ? "compare" : item.target}:${item.path}`;
  const summaryKey = (item: Choice) => `${activePath()}:${selected()}:${diffKey(item)}`;
  const expansionScope = () => `${activePath()}:${selected()}`;
  // With the setting on, test files stay collapsed unless opened one by one; bulk expand skips them.
  const keptClosed = (item: Choice) => keepTestsClosed() && testFilePattern.test(item.path);
  const isSummaryExpanded = (item: Choice) => summaryDiffs()[summaryKey(item)] ?? (keptClosed(item) ? false : expansionDefaults()[expansionScope()] ?? files().length <= 20);
  // Decide auto-expansion once per view so file-count changes during refreshes do not toggle every card.
  createEffect(() => {
    const scope = expansionScope(), count = files().length;
    if (count && untrack(expansionDefaults)[scope] === undefined) setExpansionDefaults(previous => ({ ...previous, [scope]: count <= 20 }));
  });
  function toggleSummaryDiff(item: Choice) { setSummaryDiffs(previous => ({ ...previous, [summaryKey(item)]: !isSummaryExpanded(item) })); }
  const isSummaryGroupExpanded = (items: Choice[]) => {
    const bulk = items.filter(item => !keptClosed(item));
    return (bulk.length ? bulk : items).every(isSummaryExpanded);
  };
  function toggleSummaryGroup(items: Choice[]) {
    const open = !isSummaryGroupExpanded(items);
    const skipTests = items.some(item => !keptClosed(item));
    setSummaryDiffs(previous => {
      const next = { ...previous };
      for (const item of items) next[summaryKey(item)] = open && skipTests && keptClosed(item) ? false : open;
      return next;
    });
  }
  function setEveryDiff(open: boolean) {
    const scope = expansionScope();
    setExpansionDefaults(previous => ({ ...previous, [scope]: open }));
    setSummaryDiffs(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => !key.startsWith(`${scope}:`))));
  }
  const graph = createMemo<GraphStep[]>(() => {
    const pending: (string | null)[] = [];
    // Branch that owns each lane: set by the first decorated commit reached on it and carried down its first parents.
    const keys: (string | null)[] = [];
    const remotes = repo()?.remotes ?? [];
    const color = (lane: number) => keys[lane] ? branchColorIndex(keys[lane]!) : lane % graphPaletteSize;
    return displayedCommits().map(item => {
      let lane = pending.indexOf(item.hash);
      if (lane < 0) { lane = pending.indexOf(null); if (lane < 0) lane = pending.length; pending[lane] = item.hash; keys[lane] = null; }
      const before = pending.flatMap((hash, index) => hash === null ? [] : [index]);
      const beforeColors = before.map(color);
      const own = item.decorations.map(label => branchKey(label, remotes)).find(Boolean) ?? null;
      const key = keys[lane] ?? own;
      keys[lane] = key;
      const nodeColor = color(lane);
      pending[lane] = null;
      const parents = item.parents.map((hash, index) => {
        let target = pending.indexOf(hash);
        if (target < 0) {
          target = index === 0 ? lane : pending.indexOf(null);
          if (target < 0) target = pending.length;
          pending[target] = hash;
          keys[target] = index === 0 ? key : null;
        } else if (index === 0 && key && (!keys[target] || mainBranch.test(key))) {
          // History shared with a feature branch belongs to the main line.
          keys[target] = key;
        }
        return target;
      });
      const parentColors = parents.map((target, index) => index === 0 ? nodeColor : color(target));
      return { lane, before, parents, beforeColors, nodeColor, parentColors };
    });
  });
  const branchColor = (key: string | null) => key ? graphColors[theme()][branchColorIndex(key)] : undefined;
  const decorationColor = (label: string) => branchColor(branchKey(label, repo()?.remotes ?? []));
  const rowHeight = () => bottomLayout() ? compactCommitRowHeight : commitRowHeight;
  // Pinned rows above the virtual commit list: the comparison (when open) and the working directory.
  const listHeaderHeight = () => searchQuery() ? 0 : workingRowHeight + (comparison() ? compareRowHeight : 0);
  const visibleStart = createMemo(() => Math.max(0, Math.floor(Math.max(0, scrollTop() - listHeaderHeight()) / rowHeight()) - 8));
  // Slice the commit objects themselves so <For> keeps existing rows while scrolling and refreshing.
  const visibleCommits = createMemo(() => {
    const commits = displayedCommits();
    const start = visibleStart();
    return commits.slice(start, Math.min(commits.length, start + Math.ceil(viewportHeight() / rowHeight()) + 18));
  });
  const paletteCommands = createMemo(() => {
    const commands: { label: string; run: () => void }[] = [
      { label: "Open repository", run: () => setShowOpen(true) },
      { label: "Settings", run: () => setShowSettings(true) },
      { label: "Refresh repository", run: () => { void refresh(); } },
      { label: "Search commits", run: openSearch },
    ];
    if (repoReady()) {
      commands.push(
        { label: "Browse tracked files", run: openFileFinder },
        { label: "Stage all files", run: () => { void runAction({ kind: "stage_all" }); } },
        { label: "Fetch all remotes", run: () => { void runAction({ kind: "fetch" }); } },
        { label: "Pull fast-forward", run: () => { void runAction({ kind: "pull" }); } },
        { label: "Push current branch", run: () => { void runAction({ kind: "push" }); } },
        { label: "Force push current branch with lease", run: forcePushWithLease },
      );
      for (const branch of repo()!.refs.filter(item => item.kind === "branch")) {
        commands.push({ label: `Switch to ${branch.name}`, run: () => { void runAction({ kind: "checkout", value: { branch: branch.name } }); } });
      }
    }
    return commands.filter(item => item.label.toLowerCase().includes(paletteInput().toLowerCase()));
  });
  function paletteKey(event: KeyboardEvent) {
    if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      const first = paletteCommands()[0];
      if (first) { setPaletteOpen(false); first.run(); }
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(".palette-list button"));
    if (!buttons.length) return;
    event.preventDefault();
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length].focus();
  }
  createEffect(() => { if (repo() && commitScroll) setViewportHeight(commitScroll.clientHeight); });
  createEffect(() => {
    const path = activePath();
    if (!path || !repoReady() || !isTauri() || demoMode) return;
    let stopped = false;
    setWatchFallback(false);
    // Catch up on changes made while another tab was active; the watcher may have handed them to that tab's loop.
    untrack(() => void refreshState());
    const loop = async () => {
      while (!stopped) {
        try {
          const changed = await invoke<boolean>("repo_watch", { path, timeoutMs: 60_000 });
          // Refresh while visible even without focus, so edits made from another app show up; a hidden window catches up when shown.
          // The watcher reports each change once, so a replaced loop still passes its change on when its repository is active.
          if (changed && activePath() === path && document.visibilityState === "visible") void refreshState();
          if (stopped) return;
        } catch {
          if (!stopped) setWatchFallback(true);
          return;
        }
      }
    };
    void loop();
    onCleanup(() => { stopped = true; });
  });

  function resetFileInfo() {
    fileInfoRequest++;
    setFileView("diff"); setFileHistory(null); setFileBlame(null); setFileInfoLoading(false); setFileInfoError("");
  }
  function selectWorking() { navigationArea = "commits"; request++; resetFileInfo(); setSelected("working"); setDetails(null); setChoice(null); setParkedFile(null); setDiff(null); setKeyboardFileKey(null); if (detailsScroll) detailsScroll.scrollTop = 0; }
  createEffect(() => {
    const message = notice();
    if (!message) return;
    const timer = window.setTimeout(() => setNotice(current => current === message ? "" : current), 4000);
    onCleanup(() => window.clearTimeout(timer));
  });
  function saveRecent(path: string) {
    const next = [path, ...recent().filter(item => item !== path)].slice(0, 12);
    setRecent(next);
    localStorage.setItem(recentKey, JSON.stringify(next));
  }
  function saveTabs() {
    localStorage.setItem(tabsKey, JSON.stringify(tabs().map(item => item.path)));
    localStorage.setItem(activeKey, activePath() ?? "");
  }
  async function restoreRepo(path: string) {
    try {
      const result = await invoke<Repo>("repo_snapshot", { path, offset: 0 });
      batch(() => {
        setTabs(current => current.map(item => item.path === path && item.loading ? result : item));
        if (activePath() === path) setActivePath(result.path);
      });
      saveTabs();
    } catch (cause) {
      setTabs(current => current.map(item => item.path === path && item.loading
        ? { ...item, branch: "Unavailable", loading: false, loadError: String(cause) } : item));
    }
  }
  function retryRestoredRepo(path: string) {
    setTabs(current => current.map(item => item.path === path
      ? { ...item, branch: "Loading…", loading: true, loadError: undefined } : item));
    void restoreRepo(path);
  }
  async function openRepo(path: string) {
    if (!path.trim()) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await invoke<Repo>("repo_snapshot", { path: path.trim(), offset: 0 });
      setTabs(current => current.some(item => item.path === result.path) ? current.map(item => item.path === result.path ? result : item) : [...current, result]);
      setActivePath(result.path); setScrollTop(0); setSearchQuery(""); setSearchInput(""); setSearchOpen(false); if (commitScroll) commitScroll.scrollTop = 0;
      selectWorking(); setShowOpen(false); saveRecent(result.path); saveTabs();
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }
  function showSshPrompt(prompt: SshPrompt) {
    if (sshPrompt()?.id === prompt.id) return;
    // A retry after a wrong password keeps the Remember choice.
    if (!prompt.error) setSshRemember(false);
    setSshAnswer(""); setSshReveal(false); setSshPrompt(prompt);
  }
  function answerSshPrompt(answer: string | null) {
    const prompt = sshPrompt();
    if (!prompt) return;
    setSshPrompt(null); setSshAnswer("");
    void invoke("ssh_prompt_answer", { id: prompt.id, answer, remember: answer !== null && sshRemember() }).catch(cause => setError(String(cause)));
  }
  function forgetSsh(key: string) {
    void invoke("ssh_forget_credential", { key }).then(() => setSavedSsh(keys => keys.filter(item => item !== key))).catch(cause => setError(String(cause)));
  }
  createEffect(() => {
    if (showSettings() && isTauri()) void invoke<string[]>("ssh_saved_credentials").then(setSavedSsh).catch(() => setSavedSsh([]));
  });
  async function chooseFolder() {
    const path = await open({ directory: true, multiple: false, title: "Open a Git repository" });
    if (typeof path === "string") await openRepo(path);
  }
  async function refresh() {
    if (!isTauri()) return;
    const path = activePath();
    if (!path || !repoReady()) return;
    try {
      const update = await invoke<Repo>("repo_snapshot", { path, offset: 0 });
      setTabs(current => current.map(item => {
        if (item.path !== path) return item;
        const overlap = item.commits.findIndex(commit => commit.hash === update.commits[update.commits.length - 1]?.hash);
        return mergeRepo(item, { ...update, commits: overlap >= 0 ? [...update.commits, ...item.commits.slice(overlap + 1)] : update.commits });
      }));
      refreshWorkingDiff(path);
      setError("");
    } catch (cause) { setError(String(cause)); }
  }
  // Status refreshes run one at a time; a request made while one runs is queued (and shared) instead of dropped.
  let stateRunning: Promise<void> | null = null;
  let stateQueued: Promise<void> | null = null;
  function refreshState(): Promise<void> {
    if (stateQueued) return stateQueued;
    const start = () => { stateQueued = null; stateRunning = refreshStateOnce().finally(() => { stateRunning = null; }); return stateRunning; };
    if (!stateRunning) return start();
    stateQueued = stateRunning.then(start, start);
    return stateQueued;
  }
  async function refreshStateOnce() {
    const path = activePath();
    if (!path || !repoReady() || !isTauri() || stateBusy) return;
    stateBusy = true;
    try {
      const update = await invoke<RepoState>("repo_state", { path });
      const current = tabs().find(item => item.path === path);
      if (!current) return;
      const refsMoved = Boolean(update.refsHash && current.refsHash && update.refsHash !== current.refsHash);
      if (refsMoved || update.head !== current.head || update.branch !== current.branch || update.operation !== current.operation || update.rebaseEditPause !== current.rebaseEditPause) {
        if (activePath() === path) await refresh();
      } else if (JSON.stringify(update.status) !== JSON.stringify(current.status)) {
        setTabs(items => items.map(item => item.path === path ? { ...item, status: reuseEqual(item.status, update.status, entry => entry.path) } : item));
        refreshWorkingDiff(path);
      }
    } catch (cause) { setError(String(cause)); }
    finally { stateBusy = false; }
  }
  async function loadMore() {
    const current = repo();
    if (!current || busy() || searchBusy() || !hasMore()) return;
    if (searchQuery()) {
      setSearchBusy(true);
      try {
        const result = await invoke<SearchResult>("repo_search", { path: current.path, query: searchQuery(), offset: searchResult().commits.length });
        setSearchResult(previous => ({ commits: [...previous.commits, ...result.commits], hasMore: result.hasMore }));
      } catch (cause) { setError(String(cause)); }
      finally { setSearchBusy(false); }
      return;
    }
    setBusy(true);
    try {
      const update = await invoke<Repo>("repo_snapshot", { path: current.path, offset: current.commits.length });
      setTabs(tabs => tabs.map(item => item.path === current.path ? { ...update, commits: [...item.commits, ...update.commits] } : item));
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }
  // Search takes the branch box's place, as in Sublime Merge, until it is cleared or dismissed.
  let searchInputRef: HTMLInputElement | undefined;
  function openSearch() {
    setSearchOpen(true);
    requestAnimationFrame(() => searchInputRef?.focus());
  }
  function closeSearch() {
    setSearchOpen(false);
    if (searchQuery() || searchInput()) void performSearch("");
  }
  async function performSearch(query = searchInput()) {
    const path = activePath();
    const term = query.trim();
    setSearchInput(query); setSearchQuery(term); setSearchResult({ commits: [], hasMore: false });
    setScrollTop(0); if (commitScroll) commitScroll.scrollTop = 0;
    if (!term || !path) return;
    if (demoMode) {
      const needle = term.toLowerCase();
      setSearchResult({ commits: (repo()?.commits ?? []).filter(item => `${item.subject} ${item.author}`.toLowerCase().includes(needle)), hasMore: false });
      return;
    }
    setSearchBusy(true);
    try {
      const result = await invoke<SearchResult>("repo_search", { path, query: term, offset: 0 });
      if (activePath() === path && searchQuery() === term) setSearchResult(result);
    } catch (cause) { setError(String(cause)); }
    finally { setSearchBusy(false); }
  }
  // Compare against the remote merge destination; a local main line may be stale or have unpushed commits.
  function findBaseBranch(refs: Ref[]) {
    for (const name of ["main", "master", "develop", "trunk"]) {
      const origin = refs.find(item => item.kind === "remote" && item.name === `origin/${name}`);
      if (origin) return origin;
    }
    for (const name of ["main", "master", "develop", "trunk"]) {
      const remote = refs.find(item => item.kind === "remote" && item.name.endsWith(`/${name}`));
      if (remote) return remote;
    }
    for (const name of ["main", "master", "develop", "trunk"]) {
      const local = refs.find(item => item.kind === "branch" && item.name === name);
      if (local) return local;
    }
    return null;
  }
  const baseBranch = createMemo(() => findBaseBranch(repo()?.refs ?? []));
  async function compareWithBase(ref: Ref) {
    const path = activePath(), base = baseBranch();
    if (!path || !base) return;
    showComparison();
    if (detailsScroll) detailsScroll.scrollTop = 0;
    commitScroll.scrollTop = 0; setScrollTop(0);
    await runComparison(path, base.name, ref.name);
  }
  const branchTarget = (refs: Ref[], name: string) => refs.find(item => (item.kind === "branch" || item.kind === "remote") && item.name === name)?.target ?? "";
  // Latest comparison request per repository, so a slower earlier result cannot overwrite a newer one.
  const comparisonRequests = new Map<string, string>();
  // Branches are resolved by name each time, so a comparison follows commits made since it was opened.
  // A refresh keeps the previous result on screen until the new one arrives.
  async function runComparison(path: string, baseName: string, headName: string, refresh = false, automatic = false) {
    const refs = tabs().find(item => item.path === path)?.refs ?? [];
    const baseHash = branchTarget(refs, baseName), headHash = branchTarget(refs, headName);
    const request = `${baseName}:${headName}:${baseHash}:${headHash}`;
    comparisonRequests.set(path, request);
    const missing = !baseHash ? baseName : !headHash ? headName : "";
    if (!refresh || missing) updateComparison(path, current => ({ base: baseName, head: headName, baseHash, headHash, result: null, error: missing ? `Branch ${missing} no longer exists` : "", automatic: refresh ? current?.automatic : automatic }));
    if (missing) return;
    const settle = (change: Partial<Comparison>) => {
      if (comparisonRequests.get(path) === request) updateComparison(path, current => current?.head === headName ? { ...current, baseHash, headHash, ...change } : current);
    };
    try {
      settle({ result: await invoke<CompareResult>("repo_compare", { path, base: baseHash, head: headHash }), error: "" });
      // The open compare file's target has moved with the branches (compareStore updates it in place); reload its diff too.
      if (refresh && activePath() === path && selected() === "compare" && choice()) await reloadFileDiff();
    } catch (cause) {
      settle({ result: null, error: String(cause) });
    }
  }
  // Rerun open comparisons when either branch moves (new commits, fetch, rebase).
  createEffect(() => {
    const open = comparisons();
    for (const tab of tabs()) {
      const current = open[tab.path];
      if (!current || tab.loading || tab.loadError || pendingComparisons.has(tab.path)) continue;
      const baseHash = branchTarget(tab.refs, current.base), headHash = branchTarget(tab.refs, current.head);
      if (baseHash === current.baseHash && headHash === current.headHash) continue;
      if (comparisonRequests.get(tab.path) === `${current.base}:${current.head}:${baseHash}:${headHash}`) continue;
      untrack(() => void runComparison(tab.path, current.base, current.head, true));
    }
  });
  // Restore saved comparisons and selections once each repository has loaded.
  createEffect(() => {
    const path = activePath();
    if (!path || !repoReady()) return;
    untrack(() => {
      const pending = pendingComparisons.get(path);
      if (pending) { pendingComparisons.delete(path); void runComparison(path, pending.base, pending.head, false, pending.automatic); }
      if (initialSelection.has(path)) {
        const saved = initialSelection.get(path)!;
        initialSelection.delete(path);
        if (selected() !== "working") return;
        if (saved === "compare" && comparisons()[path]) showComparison();
        else if (saved !== "working" && saved !== "compare") void jumpToCommit(saved);
      }
    });
  });
  // Keep the checked-out feature branch's comparison available without changing the selected view.
  createEffect(() => {
    if (demoMode) return;
    const open = comparisons();
    for (const tab of tabs()) {
      if (tab.loading || tab.loadError || pendingComparisons.has(tab.path)) continue;
      const current = open[tab.path], base = findBaseBranch(tab.refs);
      const feature = base && !["main", "master", base.name, base.name.split("/").pop()].includes(tab.branch) && tab.refs.some(ref => ref.kind === "branch" && ref.name === tab.branch);
      untrack(() => {
        if (!feature) {
          if (current?.automatic) {
            comparisonRequests.delete(tab.path);
            updateComparison(tab.path, () => null);
            if (activePath() === tab.path && selected() === "compare") selectWorking();
          }
          return;
        }
        if (current?.base === base.name && current.head === tab.branch) {
          if (!current.automatic) updateComparison(tab.path, value => value ? { ...value, automatic: true } : null);
        } else if (!current || current.automatic || current.head === tab.branch) void runComparison(tab.path, base.name, tab.branch, false, true);
      });
    }
  });
  createEffect(() => {
    const active = activePath(), current = selected(), open = comparisons();
    const state: Record<string, { selected: string; compare?: { base: string; head: string; automatic?: boolean } }> = {};
    for (const tab of tabs()) {
      const compare = open[tab.path] ?? (pendingComparisons.has(tab.path) ? pendingComparisons.get(tab.path) : undefined);
      state[tab.path] = { selected: tab.path === active ? initialSelection.get(active) ?? current : tabViews.get(tab.path)?.selected ?? "working", ...(compare ? { compare: { base: compare.base, head: compare.head, automatic: compare.automatic } } : {}) };
    }
    localStorage.setItem(tabStateKey, JSON.stringify(state));
  });
  // The details pane of the active repository (open file tab and scroll positions) survives restarts. Summary scroll is
  // saved as the file card at the top plus the distance into it, since lazily loaded diffs change pixel offsets.
  type DetailsView = { repo: string; selected: string; file?: { path: string; target: string; open: boolean; scrollTop: number }; summary?: { path: string; target: string; offset: number } };
  let pendingDetails: DetailsView | null = (() => { try { return JSON.parse(localStorage.getItem(detailsViewKey) ?? "null"); } catch { return null; } })();
  // Give up restoring (and resume saving) if the saved view never comes back, e.g. its working tree is now clean.
  window.setTimeout(() => { pendingDetails = null; }, 15_000);
  const sameFile = (item: Choice, saved: { path: string; target: string }) => item.path === saved.path && (selected() === "compare" || item.target === saved.target);
  function saveDetailsView() {
    const repoPath = activePath();
    if (pendingDetails || !repoPath || !detailsScroll) return;
    const file = choice() ?? parkedFile();
    const view: DetailsView = { repo: repoPath, selected: selected(), ...(file ? { file: { path: file.path, target: file.target, open: Boolean(choice()), scrollTop: choice() ? detailsScroll.scrollTop : 0 } } : {}) };
    if (!choice()) {
      const top = detailsScroll.getBoundingClientRect().top;
      const card = [...detailsScroll.querySelectorAll<HTMLElement>(".summary-diff-card")].find(element => element.getBoundingClientRect().bottom > top);
      if (card && detailsScroll.scrollTop > 0) view.summary = { path: card.dataset.path ?? "", target: card.dataset.target ?? "", offset: top - card.getBoundingClientRect().top };
    }
    localStorage.setItem(detailsViewKey, JSON.stringify(view));
  }
  let detailsSaveTimer = 0;
  const scheduleDetailsSave = () => { window.clearTimeout(detailsSaveTimer); detailsSaveTimer = window.setTimeout(saveDetailsView, 250); };
  createEffect(() => { activePath(); selected(); choice(); parkedFile(); scheduleDetailsSave(); });
  createEffect(() => {
    if (!pendingDetails) return;
    const view = pendingDetails;
    if (!activePath()) return;
    if (activePath() !== view.repo) { pendingDetails = null; return; }
    // Wait until the saved commit or comparison is selected again and its files are listed.
    if (selected() !== view.selected || !files().length) return;
    untrack(() => {
      pendingDetails = null;
      const file = view.file && files().find(item => sameFile(item, view.file!));
      if (file && view.file!.open) { void selectFile(file, view.file!.scrollTop); return; }
      if (file) setParkedFile(file);
      const summary = view.summary;
      if (!summary) return;
      // Cards load their diffs lazily; retry briefly until the saved card is tall enough to scroll into.
      const started = performance.now();
      const restore = () => {
        if (choice() || performance.now() - started > 2000) return;
        const card = [...detailsScroll.querySelectorAll<HTMLElement>(".summary-diff-card")].find(element => element.dataset.path === summary.path && (selected() === "compare" || element.dataset.target === summary.target));
        if (!card) return;
        const rect = card.getBoundingClientRect();
        detailsScroll.scrollTop += rect.top - detailsScroll.getBoundingClientRect().top + Math.min(summary.offset, rect.height);
        if (rect.height < summary.offset) window.setTimeout(restore, 100);
      };
      window.setTimeout(restore);
    });
  });
  function showComparison() {
    navigationArea = "commits"; request++; resetFileInfo();
    setSelected("compare"); setDetails(null); setChoice(null); setParkedFile(null); setDiff(null); setKeyboardFileKey(null);
  }
  function closeFileTab() {
    setParkedFile(null);
    if (choice()) { setChoice(null); setDiff(null); resetFileInfo(); }
    if (detailsScroll) detailsScroll.scrollTop = 0;
  }
  function closeComparison() {
    const path = activePath();
    if (path) { pendingComparisons.delete(path); updateComparison(path, () => null); }
    if (selected() === "compare") selectWorking();
  }
  const inspectRevision = () => selected() === "working" ? "HEAD" : selected() === "compare" ? comparison()?.headHash ?? "HEAD" : selected();
  // Sidebar refs: select the commit and scroll it to the middle of the history, loading older pages if needed.
  async function jumpToCommit(hash: string, loadHistory = true) {
    const path = activePath();
    if (searchQuery()) await performSearch("");
    let index = displayedCommits().findIndex(item => item.hash === hash);
    for (let page = 0; loadHistory && index < 0 && hasMore() && page < 20 && activePath() === path; page++) {
      while (busy()) await new Promise(resolve => setTimeout(resolve, 50));
      await loadMore();
      index = displayedCommits().findIndex(item => item.hash === hash);
    }
    if (activePath() !== path) return;
    void selectCommit(hash);
    if (index < 0) return;
    const top = listHeaderHeight() + index * rowHeight() - (commitScroll.clientHeight - rowHeight()) / 2;
    commitScroll.scrollTop = Math.max(0, top);
    setScrollTop(commitScroll.scrollTop);
  }
  async function selectCommit(hash: string) {
    const path = activePath();
    if (!path) return;
    navigationArea = "commits";
    resetFileInfo();
    // Commits never change, so a cached copy renders instantly when returning to a tab or commit.
    const cacheKey = `${path}\u0000${hash}`;
    const cached = detailsCache.get(cacheKey);
    setSelected(hash); setDetails(cached ?? null); setChoice(null); setParkedFile(null); setDiff(null); setKeyboardFileKey(null);
    if (detailsScroll) detailsScroll.scrollTop = 0;
    const id = ++request;
    if (cached) return;
    if (demoMode) {
      const commit = repo()?.commits.find(item => item.hash === hash);
      if (commit) setDetails({ hash, subject: commit.subject, body: "A focused update to the repository experience.\n\nThe implementation keeps navigation responsive while the history grows.", author: commit.author, authorEmail: "sam@example.com", timestamp: commit.timestamp, parents: commit.parents, files: [{ path: "src/components/RepositoryView.tsx", status: "M" }, { path: "src/styles/diff.css", status: "M" }, { path: "docs/notes.md", status: "A" }] });
      return;
    }
    try {
      const result = await invoke<Details>("repo_commit", { path, hash });
      detailsCache.set(cacheKey, result);
      if (detailsCache.size > 200) detailsCache.delete(detailsCache.keys().next().value!);
      if (id === request) setDetails(result);
    } catch (cause) { if (id === request) setError(String(cause)); }
  }
  async function selectFile(item: Choice, restoreScroll?: number) {
    const path = activePath();
    if (!path) return;
    navigationArea = "files";
    const keepEditing = fileView() === "edit" && selected() === "working" && choice()?.path === item.path;
    resetFileInfo();
    if (keepEditing) setFileView("edit");
    setChoice(item); setDiff(null); setKeyboardFileKey(summaryKey(item));
    const reveal = () => restoreScroll === undefined ? requestAnimationFrame(revealDiff) : window.setTimeout(() => { detailsScroll.scrollTop = restoreScroll; });
    await loadFileDiff(path, item, result => { setDiff(result); reveal(); });
  }
  // Reloads the open file's diff after its file changes without clearing it first, so the rendered rows update
  // in place and the view, scroll position and file view (history, blame, edit) stay as they are.
  async function reloadFileDiff() {
    const path = activePath(), item = choice();
    // A first load still in flight shows the diff itself and reveals or restores its position; a failed one is retried.
    if (!path || !item || (!diff() && loadingFileDiff === request)) return;
    await loadFileDiff(path, item, result => {
      const previous = diff();
      if (choice() === item && (!previous || previous.text !== result.text || previous.truncated !== result.truncated)) setDiff(result);
    });
  }
  function refreshWorkingDiff(path: string) {
    const item = choice();
    if (activePath() !== path || selected() !== "working" || !item || item.target === "tracked") return;
    const fresh = workingFiles().find(file => file.target === item.target && file.path === item.path);
    if (!fresh || (fresh.revision ?? "") !== shownDiffRevision) void reloadFileDiff();
  }
  // A newer request (another file, commit or reload) makes an older result stale.
  async function loadFileDiff(path: string, item: Choice, show: (result: Diff) => void) {
    const revision = item.revision ?? "";
    const id = loadingFileDiff = ++request;
    try {
      const result = demoMode ? demoDiff(item) : await invoke<Diff>("repo_diff", { path, target: item.target, file: item.path, ignoreWhitespace: ignoreWhitespace(), fullContext: fullFile() });
      if (id === request) { shownDiffRevision = revision; show(result); }
    } catch (cause) { if (id === request) setError(String(cause)); }
    finally { if (loadingFileDiff === id) loadingFileDiff = 0; }
  }
  async function editFile(item: Choice) {
    const path = activePath();
    if (!path || selected() !== "working" || item.status === "D") return;
    const existing = fileDraft();
    if (existing && (existing.repo !== path || existing.path !== item.path) && existing.text !== existing.original) {
      setError(`Save or discard the unsaved edits to ${existing.path} before editing another file.`);
      return;
    }
    if (choice()?.path !== item.path || choice()?.target !== item.target) void selectFile(item);
    setFileView("edit");
    setFileEditError("");
    if (existing?.repo === path && existing.path === item.path) {
      setFileDraft({ ...existing, stageOnSave: item.target === "staged" });
      return;
    }
    setFileEditLoading(true);
    const id = ++fileEditRequest;
    try {
      const result = demoMode ? { content: demoDiff(item).text } : await invoke<EditableFile>("repo_read_file", { path, file: item.path });
      if (id === fileEditRequest) {
        const newline = result.content.includes("\r\n") ? "\r\n" : result.content.includes("\r") ? "\r" : "\n";
        const text = result.content.replace(/\r\n?|\n/g, "\n");
        setFileDraft({ repo: path, path: item.path, source: result.content, original: text, text, newline, stageOnSave: item.target === "staged" });
      }
    } catch (cause) { if (id === fileEditRequest) setFileEditError(String(cause)); }
    finally { if (id === fileEditRequest) setFileEditLoading(false); }
  }
  async function saveEditedFile() {
    const draft = fileDraft();
    if (!draft || draft.text === draft.original || fileEditSaving() || actionBusy()) return;
    setFileEditSaving(true);
    setFileEditError("");
    try {
      const content = draft.newline === "\n" ? draft.text : draft.text.replace(/\n/g, draft.newline);
      const result = demoMode ? { staged: draft.stageOnSave, warning: null } : await invoke<SavedFile>("repo_save_file", {
        path: draft.repo, file: draft.path, content, expectedContent: draft.source, stage: draft.stageOnSave,
      });
      setFileDraft(current => current?.repo === draft.repo && current.path === draft.path ? { ...current, source: content, original: draft.text } : current);
      if (result.warning) setError(result.warning);
      else setNotice(result.staged ? "File saved and staged" : "File saved");
      if (activePath() === draft.repo && !demoMode) {
        await refresh();
        const item = workingFiles().find(file => file.path === draft.path && file.target === (draft.stageOnSave ? "staged" : "working"))
          ?? workingFiles().find(file => file.path === draft.path);
        if (item) await selectFile(item);
      }
    } catch (cause) { setFileEditError(String(cause)); }
    finally { setFileEditSaving(false); }
  }
  function discardEditedFile() {
    const draft = fileDraft();
    if (draft?.text !== draft?.original) {
      openActionDialog({ title: `Discard edits to ${draft?.path}?`, submitLabel: "Discard", danger: true, fields: [], onSubmit: () => { setFileDraft(null); setFileView("diff"); setFileEditError(""); } });
    } else {
      setFileDraft(null); setFileView("diff"); setFileEditError("");
    }
  }
  async function openInEditor(item: Choice, loadedDiff: Diff | null = null) {
    const path = activePath();
    if (!path) return;
    setError("");
    try {
      const value = item.target === "tracked" ? null : loadedDiff ?? (demoMode ? demoDiff(item) : await invoke<Diff>("repo_diff", { path, target: item.target, file: item.path, ignoreWhitespace: false }));
      const line = item.target === "untracked" || item.target === "tracked" ? 1 : firstChangedLine(value!);
      if (demoMode) { setNotice(`Open ${item.path}:${line} in ${editorOptions.find(option => option.id === editor())?.label}`); return; }
      await invoke("open_in_editor", { repo: path, file: item.path, line, editor: editor(), executable: editorExecutable() });
    } catch (cause) { setError(String(cause)); }
  }
  function openSideEditor(item: Choice, line: number, marks: HunkMarks | null) {
    const path = activePath();
    if (!path) return;
    const current = sideEditor();
    const commit = isWorkingTarget(item.target) ? undefined : item.target;
    const open = () => void showSideEditor({ repo: path, path: item.path, commit, line, marks, nonce: ++sideEditorNonce });
    if (current && sideEditorDirty() && (current.repo !== path || current.path !== item.path || current.commit !== commit)) {
      openActionDialog({ title: `Discard unsaved edits to ${current.path}?`, submitLabel: "Discard", danger: true, fields: [], onSubmit: open });
    } else open();
  }
  function closeSideEditor() {
    const current = sideEditor();
    if (current && sideEditorDirty()) openActionDialog({ title: `Discard unsaved edits to ${current.path}?`, submitLabel: "Discard and close", danger: true, fields: [], onSubmit: () => void hideSideEditor() });
    else void hideSideEditor();
  }
  async function readSideEditorFile(path: string, file: string, commit?: string) {
    if (commit) return fileFromFullDiff(demoMode ? demoDiff({ path: file, status: "M", target: commit }) : await invoke<Diff>("repo_diff", { path, target: commit, file, ignoreWhitespace: false, fullContext: true }));
    if (demoMode) return demoDiff({ path: file, status: "M", target: "working" }).text;
    return (await invoke<EditableFile>("repo_read_file", { path, file })).content;
  }
  async function saveSideEditorFile(path: string, file: string, content: string, expectedContent: string) {
    if (demoMode) { setNotice("File saved"); return; }
    const result = await invoke<SavedFile>("repo_save_file", { path, file, content, expectedContent, stage: false });
    if (result.warning) setError(result.warning);
    if (activePath() === path) void refreshState();
  }
  function changeIgnoreWhitespace(value: boolean) {
    setIgnoreWhitespace(value);
    if (choice()) void selectFile(choice()!);
  }
  // The setting persists, so every view says when whitespace-only changes are hidden.
  const whitespaceNote = () => `Whitespace-only changes are hidden${selected() === "working" ? ", so line and hunk actions are unavailable" : ""}. Turn this off in Settings.`;
  function revealDiff() {
    detailsScroll?.querySelector<HTMLElement>(".diff-heading")?.scrollIntoView({ block: "start", behavior: "auto" });
    // A full file can start far above its first change; bring that change into view with a few lines of context above it.
    const change = fullFile() ? detailsScroll?.querySelector<HTMLElement>(".diff-content .diff-line.added, .diff-content .diff-line.deleted") : null;
    if (!change) return;
    const view = detailsScroll.getBoundingClientRect();
    const line = change.getBoundingClientRect();
    if (line.bottom > view.bottom) detailsScroll.scrollTop += line.top - view.top - 3 * line.height;
  }
  // Predict the status change of simple file actions so the file moves immediately; the next status refresh replaces the guess.
  function applyOptimisticAction(path: string, operation: Operation) {
    const paths = "value" in operation && operation.value && typeof operation.value === "object"
      ? "paths" in operation.value ? operation.value.paths : "path" in operation.value && ["stage_file", "unstage_file", "discard_file"].includes(operation.kind) ? [operation.value.path as string] : null
      : null;
    if (!paths) return;
    const targets = new Set(paths);
    const kind = operation.kind.replace(/s$/, "");
    const current = tabs().find(item => item.path === path);
    if (!current) return;
    for (const entry of current.status) {
      if (!targets.has(entry.path) || ignoreWhitespace()) continue;
      const revision = `${entry.indexRevision ?? ""}:${entry.worktreeRevision ?? ""}`;
      // Hand the loaded diff to the card the file is moving to, when the change moves whole.
      if (kind === "stage_file" && entry.index === " " && entry.worktree !== "?") {
        const diff = cachedDiff(`false:${path}:working:${entry.path}:${revision}`);
        if (diff) movedDiffs.set(`${path}\u0000staged\u0000${entry.path}`, diff);
      }
      if (kind === "unstage_file" && entry.worktree === " " && entry.index !== "A") {
        const diff = cachedDiff(`false:${path}:staged:${entry.path}:${entry.indexRevision ?? ""}`);
        if (diff) movedDiffs.set(`${path}\u0000working\u0000${entry.path}`, diff);
      }
    }
    const next = current.status.flatMap(entry => {
      if (!targets.has(entry.path) || entry.index === "U" || entry.worktree === "U") return [entry];
      const pending = `pending:${entry.worktreeRevision ?? ""}`;
      if (kind === "stage_file") {
        if (entry.index === "?" && entry.worktree === "?") return [{ ...entry, index: "A", worktree: " ", indexRevision: pending }];
        if (entry.worktree === " ") return [entry];
        return [{ ...entry, index: entry.index === " " ? entry.worktree : entry.index === "A" ? "A" : "M", worktree: " ", indexRevision: pending }];
      }
      if (kind === "unstage_file") {
        if (entry.index === "A") return [{ ...entry, index: "?", worktree: "?", indexRevision: "" }];
        if (entry.index === " " || entry.index === "?") return [entry];
        return [{ ...entry, worktree: entry.worktree === " " ? entry.index : "M", index: " ", indexRevision: "" }];
      }
      if (kind === "discard_file") return entry.index === " " ? [] : [{ ...entry, worktree: " " }];
      if (kind === "delete_untracked") return entry.index === "?" && entry.worktree === "?" ? [] : [entry];
      return [entry];
    });
    setTabs(items => items.map(item => item.path === path ? { ...item, status: next } : item));
  }
  async function runAction(operation: Operation, confirmation?: string) {
    const path = activePath();
    if (!path || actionBusy()) return;
    if (confirmation) {
      const danger = /^(discard|delete|force_delete|force_push|reset|abort)/.test(operation.kind);
      const questionEnd = confirmation.lastIndexOf("?");
      const title = questionEnd < 0 ? confirmation : confirmation.slice(0, questionEnd);
      const description = questionEnd < 0 ? "" : confirmation.slice(questionEnd + 1).trim();
      const labels: Record<string, string> = { force_push_with_lease: "Force push", force_delete_branch: "Force delete", abort_operation: "Abort", resolve_file: "Use version", detach: "Check out" };
      const submitLabel = labels[operation.kind] ?? (/^(discard|delete|reset|revert|merge|rebase)/.test(operation.kind) ? operation.kind.split("_")[0].replace(/^./, letter => letter.toUpperCase()) : "Continue");
      openActionDialog({ title, description, submitLabel, danger, fields: [], onSubmit: () => void runAction(operation) });
      return;
    }
    const scopedAction = ["stage_lines", "unstage_lines", "discard_lines", "stage_hunk", "discard_hunk"].includes(operation.kind);
    const fileAction = scopedAction || ["stage_all", "stage_file", "unstage_file", "discard_file", "stage_files", "unstage_files", "discard_files", "delete_untracked"].includes(operation.kind);
    applyOptimisticAction(path, operation);
    const previousFile = scopedAction ? choice() : null;
    const token = ["fetch", "pull", "pull_merge", "pull_rebase", "push", "force_push_with_lease", "push_branch", "delete_remote_branch", "push_tag", "delete_remote_tag"].includes(operation.kind) ? crypto.randomUUID() : null;
    setActionBusy(true); setError(""); setNotice(""); setProgress(""); setCancelToken(token); setCancelRequested(false);
    try {
      const output = await invoke<string>("repo_action", { path, operation, cancelToken: token });
      setNotice(output || "Done");
      if (["merge", "rebase", "interactive_rebase", "pull", "pull_merge", "pull_rebase", "cherry_pick", "revert", "reset", "detach", "continue_operation", "abort_operation"].includes(operation.kind)) selectWorking();
      if (!previousFile) { setChoice(null); setDiff(null); }
      setBranchMenu(false); setRefMenu(null); setPushMenu(false); setPullMenu(false); setMoreMenu(false); setStashMenu(false);
      if (fileAction) await refreshState(); else await refresh();
      if (previousFile) {
        const nextFile = workingFiles().find(item => item.path === previousFile.path && item.target === previousFile.target)
          ?? workingFiles().find(item => item.path === previousFile.path);
        // The status refresh reloads the same file's diff in place; under another target (all lines staged) it opens fresh.
        if (!nextFile) { setChoice(null); setDiff(null); }
        else if (nextFile.target !== previousFile.target) await selectFile(nextFile);
      }
      if (searchQuery()) await performSearch(searchQuery());
    } catch (cause) {
      setBranchMenu(false); setRefMenu(null); setPullMenu(false); setPushMenu(false); setStashMenu(false);
      if (["merge", "rebase", "interactive_rebase", "pull_merge", "pull_rebase", "cherry_pick", "revert", "continue_operation"].includes(operation.kind)) selectWorking();
      if (fileAction) await refreshState(); else await refresh();
      setError(repo()?.operation && conflicts().length ? "Conflict detected. Resolve the files below, then Continue or Abort." : String(cause));
    }
    finally { setActionBusy(false); setProgress(""); setCancelToken(null); setCancelRequested(false); }
  }
  async function cancelAction() {
    const path = activePath();
    const token = cancelToken();
    if (!path || !token || cancelRequested()) return;
    setCancelRequested(true);
    setProgress("Cancelling operation…");
    try { await invoke<string>("repo_cancel", { path, token }); }
    catch (cause) { if (actionBusy()) { setError(String(cause)); setCancelRequested(false); } }
  }
  function forcePushWithLease() {
    setPushMenu(false);
    void runAction({ kind: "force_push_with_lease" }, `Force push ${repo()?.branch} with lease? This can replace remote commits if the remote still matches your tracking branch.`);
  }
  async function openRebasePlan(onto: string) {
    const current = repo();
    if (!current || actionBusy() || rebaseLoading()) return;
    setBranchMenu(false); setError(""); setRebaseLoading(true);
    try {
      const commits = await invoke<RebaseCommit[]>("repo_rebase_plan", { path: current.path, onto });
      if (activePath() === current.path) setRebasePlan({ onto, branch: current.branch, steps: commits.map(item => ({ ...item, action: "pick" })) });
    } catch (cause) { setError(String(cause)); }
    finally { setRebaseLoading(false); }
  }
  function moveRebaseStep(index: number, direction: number) {
    setRebasePlan(previous => {
      if (!previous || index + direction < 0 || index + direction >= previous.steps.length) return previous;
      const steps = [...previous.steps];
      [steps[index], steps[index + direction]] = [steps[index + direction], steps[index]];
      return { ...previous, steps };
    });
  }
  function setRebaseAction(hash: string, action: RebaseStep["action"]) {
    setRebasePlan(previous => previous && ({ ...previous, steps: previous.steps.map(item => item.hash === hash ? { ...item, action } : item) }));
  }
  function remoteField(): ActionDialogField | null {
    const remotes = repo()?.remotes ?? [];
    if (!remotes.length) { setError("Add a Git remote before pushing or deleting remote refs."); return null; }
    return { key: "remote", label: "Remote", value: remotes.includes("origin") ? "origin" : remotes[0], options: remotes };
  }
  function remoteBranch(ref: Ref): { remote: string; branch: string } | null {
    const remote = [...(repo()?.remotes ?? [])].sort((a, b) => b.length - a.length).find(name => ref.name.startsWith(`${name}/`));
    if (!remote) { setError(`Cannot find the remote for ${ref.name}.`); return null; }
    const branch = ref.name.slice(remote.length + 1);
    return branch === "HEAD" ? null : { remote, branch };
  }
  // Switches to a local branch; a remote branch switches to its local branch, creating a tracking branch if there is none.
  function checkoutRef(ref: Ref) {
    setRefMenu(null);
    if (actionBusy() || ref.isHead) return;
    if (ref.kind === "branch") { void runAction({ kind: "checkout", value: { branch: ref.name } }); return; }
    if (ref.kind !== "remote") return;
    const target = remoteBranch(ref);
    if (!target) return;
    const local = repo()?.refs.find(item => item.kind === "branch" && item.name === target.branch);
    if (local?.isHead) return;
    void runAction(local ? { kind: "checkout", value: { branch: local.name } } : { kind: "track_remote_branch", value: target });
  }
  function renameBranch(branch: string) {
    setRefMenu(null);
    openActionDialog({ title: "Rename branch", description: branch, submitLabel: "Rename", fields: [{ key: "name", label: "New branch name", value: branch }], onSubmit: ({ name }) => {
      if (name !== branch) void runAction({ kind: "rename_branch", value: { branch, new_name: name } });
    } });
  }
  function pushRef(ref: Ref) {
    setRefMenu(null);
    const remote = remoteField();
    if (!remote) return;
    openActionDialog({ title: `Push ${ref.kind}`, description: ref.name, submitLabel: "Push", fields: [remote], onSubmit: ({ remote }) => {
      if (ref.kind === "branch") void runAction({ kind: "push_branch", value: { remote, branch: ref.name } });
      if (ref.kind === "tag") void runAction({ kind: "push_tag", value: { remote, name: ref.name } });
    } });
  }
  function deleteRemoteTag(name?: string) {
    setRefMenu(null);
    const remote = remoteField();
    if (!remote) return;
    openActionDialog({ title: "Delete remote tag", description: name ? `Delete ${name} from the selected remote.` : "Remove a tag from the selected remote repository.", submitLabel: "Delete tag", danger: true,
      fields: name ? [remote] : [remote, { key: "name", label: "Tag name", value: "", placeholder: "v1.0.0" }],
      onSubmit: values => void runAction({ kind: "delete_remote_tag", value: { remote: values.remote, name: name ?? values.name } }),
    });
  }
  function deleteRemoteBranchByName() {
    setRefMenu(null);
    const remote = remoteField();
    if (!remote) return;
    openActionDialog({ title: "Delete remote branch", description: "Remove a branch from the selected remote repository.", submitLabel: "Delete branch", danger: true,
      fields: [remote, { key: "branch", label: "Branch name", value: "", placeholder: "feature/my-branch" }],
      onSubmit: ({ remote, branch }) => void runAction({ kind: "delete_remote_branch", value: { remote, branch } }),
    });
  }
  // A right-click opens the menu at the cursor; the ⋯ button opens it next to itself.
  function openRefMenu(ref: Ref, anchor: HTMLElement, point?: { x: number; y: number }) {
    const rect = anchor.getBoundingClientRect();
    const x = point?.x ?? rect.right - 8, y = point?.y ?? rect.top + 20;
    setRefMenu({ ref, x: Math.max(8, Math.min(x, innerWidth - 222)), y: Math.max(8, Math.min(y, innerHeight - 250)) });
  }
  function copyText(text: string) {
    // Fall back to a hidden textarea when the webview denies the async clipboard API.
    const fallback = () => {
      const area = document.createElement("textarea");
      area.value = text; area.style.position = "fixed"; area.style.opacity = "0";
      document.body.append(area); area.select();
      const copied = document.execCommand("copy");
      area.remove();
      if (!copied) throw new Error("Could not copy to the clipboard");
    };
    navigator.clipboard.writeText(text).catch(fallback).then(() => setNotice("Copied to the clipboard"), cause => setError(String(cause)));
  }
  async function loadFileHistory(offset: number) {
    const path = activePath();
    const item = choice();
    if (!path || !item || fileInfoLoading()) return;
    const id = ++fileInfoRequest;
    const revision = inspectRevision();
    setFileInfoLoading(true); setFileInfoError("");
    try {
      const result: FileHistoryResult = selected() === "working" && (!repo()?.head || item.target === "untracked" || item.status === "A")
        ? { commits: [], hasMore: false }
        : demoMode
          ? { commits: [{ hash: repo()?.head ?? "0".repeat(40), subject: "Initial commit", author: "GitFerry", timestamp: Math.floor(Date.now() / 1000), path: item.path }], hasMore: false }
          : await invoke<FileHistoryResult>("repo_file_history", { path, file: item.path, revision, offset });
      if (id === fileInfoRequest) setFileHistory(previous => offset && previous ? { commits: [...previous.commits, ...result.commits], hasMore: result.hasMore } : result);
    } catch (cause) { if (id === fileInfoRequest) setFileInfoError(String(cause)); }
    finally { if (id === fileInfoRequest) setFileInfoLoading(false); }
  }
  async function loadFileBlame(startLine: number) {
    const path = activePath();
    const item = choice();
    if (!path || !item || fileInfoLoading()) return;
    const id = ++fileInfoRequest;
    const revision = inspectRevision();
    setFileInfoLoading(true); setFileInfoError("");
    try {
      const result: BlameResult = selected() === "working" && (!repo()?.head || item.target === "untracked" || item.status === "A")
        ? { lines: [], hasMore: false }
        : demoMode
          ? { lines: [{ line: 1, hash: repo()?.head ?? "0".repeat(40), author: "GitFerry", timestamp: Math.floor(Date.now() / 1000), summary: "Initial commit", content: "// Example file" }], hasMore: false }
          : await invoke<BlameResult>("repo_blame", { path, file: item.path, revision, startLine });
      if (id === fileInfoRequest) setFileBlame(previous => startLine > 1 && previous ? { lines: [...previous.lines, ...result.lines], hasMore: result.hasMore } : result);
    } catch (cause) { if (id === fileInfoRequest) setFileInfoError(String(cause)); }
    finally { if (id === fileInfoRequest) setFileInfoLoading(false); }
  }
  function openFileView(view: "diff" | "history" | "blame") {
    fileInfoRequest++;
    setFileView(view); setFileInfoError(""); setFileInfoLoading(false);
    if (detailsScroll) detailsScroll.scrollTop = 0;
    if (view === "history" && !fileHistory()) void loadFileHistory(0);
    if (view === "blame" && !fileBlame()) void loadFileBlame(1);
  }
  async function openHistoryCommit(entry: FileHistoryEntry) {
    await selectCommit(entry.hash);
    const file = details()?.hash === entry.hash ? details()?.files.find(item => item.path === entry.path) : null;
    if (file) await selectFile({ ...file, target: entry.hash });
  }

  // Share the normal navigation and Git commands with MCP, rather than operating a second UI model.
  const mcpRows = (value: Diff, target: string) => numberedDiffRows(parseDiffLines(value), target);
  function mcpView() {
    const nativeSelection = window.getSelection();
    const nativeRange = nativeSelection && !nativeSelection.isCollapsed && nativeSelection.rangeCount && detailsScroll?.contains(nativeSelection.anchorNode)
      ? nativeSelection.getRangeAt(0) : null;
    const anchor = nativeSelection?.anchorNode;
    const anchorElement = anchor instanceof Element ? anchor : anchor?.parentElement;
    const content = choice() ? detailsScroll?.querySelector<HTMLElement>(".diff-content")
      : (nativeRange ? anchorElement?.closest<HTMLElement>(".diff-content") : null)
        ?? detailsScroll?.querySelector<HTMLElement>(".summary-diff-card:has(.file-row.keyboard-selected) .diff-content");
    const context = content ? diffViews.get(content)?.() : null;
    const value = context?.value ?? diff(), item = context?.item ?? choice(), rows = value && item ? mcpRows(value, item.target) : [];
    const highlighted = mcpHighlight();
    const aiRows = highlighted?.repo === activePath() && highlighted.target === item?.target && highlighted.file === item?.path && highlighted.text === value?.text ? highlighted.rows : new Set<number>();
    const selection = context?.selection ?? (choice() ? diffSelection() : { rows: [], hunkIndex: null });
    const textRows = new Map<HTMLElement, ReturnType<typeof mcpRows>>();
    const textSelection = nativeRange && nativeSelection
      ? { text: nativeSelection.toString(), lines: [...detailsScroll.querySelectorAll<HTMLElement>(".diff-line")].filter(element => nativeRange.intersectsNode(element)).flatMap(element => {
        const root = element.closest<HTMLElement>(".diff-content"), view = root && diffViews.get(root)?.();
        if (!root || !view) return [];
        let numbered = textRows.get(root);
        if (!numbered) { numbered = mcpRows(view.value, view.item.target); textRows.set(root, numbered); }
        const row = numbered[Number(element.dataset.rowIndex)];
        return row ? [{ ...row, file: view.item.path, target: view.item.target }] : [];
      }) } : null;
    return {
      tabId: activePath(), repository: activePath(), branch: repo()?.branch ?? null, head: repo()?.head ?? null,
      commit: selected(), file: item?.path ?? null, target: item?.target ?? null, fileView: fileView(),
      selection: { hunkIndex: selection.hunkIndex, lines: selection.rows.map(index => rows[index]).filter(Boolean), textSelection },
      highlights: [...aiRows].map(index => ({ rowIndex: index, ...rows[index] })),
    };
  }
  async function setMcpEnabled(enabled: boolean) {
    setMcpBusy(true); setMcpError("");
    try {
      if (enabled) {
        const connection = await invoke<McpConnection>("mcp_start", { port: mcpPort() });
        setMcpConnection(connection);
        localStorage.setItem("gitferry.mcpPort", String(mcpPort()));
      } else { await invoke("mcp_stop"); setMcpConnection(null); }
      localStorage.setItem("gitferry.mcpEnabled", String(enabled));
    } catch (cause) { setMcpError(String(cause)); }
    finally { setMcpBusy(false); }
  }
  async function handleMcp(message: McpRequest): Promise<unknown> {
    const a = message.arguments;
    const initialRequest = request, initialPath = activePath();
    const valid = async (navigation = false) => {
      if (Date.now() >= message.deadline || !await invoke<boolean>("mcp_request_active", { id: message.id })) throw new Error("MCP request expired or was cancelled");
      if (navigation && (request !== initialRequest || activePath() !== initialPath)) throw new Error("The user changed the view during this request; retry");
      if (navigation && (actionBusy() || busy() || sideEditorDirty() || activeFileDraft()?.text !== activeFileDraft()?.original)) throw new Error("Finish the current operation or save/cancel the editor changes before AI navigation");
    };
    await valid();
    if (message.tool === "get_view") return mcpView();
    if (message.tool === "list_repositories") {
      const open = await Promise.all(tabs().map(async tab => {
        if (tab.loading || tab.loadError) return { tabId: tab.path, path: tab.path, name: tab.name, branch: null, head: null, active: tab.path === activePath(), loading: Boolean(tab.loading), error: tab.loadError ?? null };
        try {
          const current = await invoke<RepoState>("repo_state", { path: tab.path });
          setTabs(tabs => tabs.map(item => item.path === tab.path ? { ...item, ...current } : item));
          return { tabId: tab.path, path: tab.path, name: tab.name, branch: current.branch, head: current.head, active: tab.path === activePath(), selectedCommit: tab.path === activePath() ? selected() : tabViews.get(tab.path)?.selected ?? "working" };
        } catch (cause) { return { tabId: tab.path, path: tab.path, name: tab.name, branch: null, head: null, active: tab.path === activePath(), error: String(cause) }; }
      }));
      return { repositories: open, recent: recent().map(path => ({ path, open: tabs().some(tab => repositoryKey(tab.path) === repositoryKey(path)) })) };
    }
    const repository = a.repository;
    if (!repository) throw new Error("repository is required");
    let tab = tabs().find(item => repositoryKey(item.path) === repositoryKey(repository));
    if (message.tool === "open_repository") {
      const current = await invoke<Repo>("repo_snapshot", { path: tab?.path ?? repository, offset: 0 });
      if (a.branch && current.branch !== a.branch) throw new Error(`Repository is on ${current.branch}, expected ${a.branch}. Open the worktree path for that branch.`);
      await valid(true);
      setTabs(tabs => tabs.some(item => item.path === current.path) ? tabs.map(item => item.path === current.path ? current : item) : [...tabs, current]);
      activateTab(current.path); saveRecent(current.path); saveTabs();
      return mcpView();
    }
    if (!tab || tab.loading || tab.loadError) throw new Error("Repository is not open and ready. Call open_repository with its path first.");
    const path = tab.path;
    if (message.tool === "list_branches" || message.tool === "show_branch") {
      const current = await invoke<Repo>("repo_snapshot", { path, offset: 0 });
      if (message.tool === "list_branches") {
        if (a.branch && current.branch !== a.branch) throw new Error(`Repository is on ${current.branch}, expected ${a.branch}`);
        return { repository: path, branch: current.branch, head: current.head, branches: current.refs.filter(ref => ref.kind === "branch" || ref.kind === "remote") };
      }
      const ref = current.refs.find(ref => (ref.kind === "branch" || ref.kind === "remote") && ref.name === a.branch);
      if (!ref) throw new Error(`Branch ${a.branch} does not exist in this repository`);
      a.commit = ref.target;
    }
    if (message.tool === "search_commits" || message.tool === "find_changes") return invoke<SearchResult>("repo_search", { path, query: a.query, codeSearch: message.tool === "find_changes", offset: a.offset ?? 0 });
    if (message.tool === "get_commit") return invoke<Details>("repo_commit", { path, hash: a.commit });
    if (message.tool === "file_history") return invoke<FileHistoryResult>("repo_file_history", { path, file: a.file, revision: a.revision ?? "HEAD", offset: a.offset ?? 0 });
    if (message.tool === "blame") return invoke<BlameResult>("repo_blame", { path, file: a.file, revision: a.revision ?? "HEAD", startLine: a.startLine ?? 1 });
    const commit = a.commit;
    if (!commit) throw new Error("commit is required");
    const working = ["working", "staged", "untracked"].includes(commit);
    const detail = working ? null : await invoke<Details>("repo_commit", { path, hash: commit });
    if (a.parent && !detail?.parents.includes(a.parent)) throw new Error("parent must be a parent of this commit");
    const target = a.parent ? `${a.parent}..${detail!.hash}` : detail?.hash ?? commit;
    const value = a.file ? await invoke<Diff>("repo_diff", { path, target, file: a.file, ignoreWhitespace: false, fullContext: false }) : null;
    const rows = value ? mcpRows(value, target) : [];
    if (message.tool === "get_diff") return { repository: path, commit, parent: a.parent ?? detail?.parents[0] ?? null, file: a.file, ...value, rows };
    if (message.tool !== "reveal_change" && message.tool !== "show_branch") throw new Error("Unknown MCP tool");
    const current = await invoke<RepoState>("repo_state", { path });
    if (message.tool === "reveal_change" && a.branch && current.branch !== a.branch) throw new Error(`Repository is on ${current.branch}, expected ${a.branch}. Select the matching worktree tab.`);
    if (value?.truncated && a.highlights?.length) throw new Error("Diff is truncated; exact highlighting cannot be confirmed");
    const selectedRows = highlightRows(rows, a.highlights ?? []);
    if (a.file && !value?.text.trim()) throw new Error("This file has no diff at the requested target");
    await valid(true);
    setTabs(tabs => tabs.map(item => item.path === path ? { ...item, ...current } : item));
    activateTab(path);
    setSearchQuery(""); setSearchInput(""); setSearchOpen(false);
    if (detail) {
      detailsCache.set(`${path}\u0000${detail.hash}`, detail);
      setRevealedCommit({ repo: path, commit: { ...detail, decorations: [] } });
      void selectCommit(detail.hash);
    } else selectWorking();
    const navigationRequest = request;
    if (a.file && value) {
      setIgnoreWhitespace(false); setFullFile(false); setFileView("diff");
      const item: Choice = working ? workingFiles().find(item => item.path === a.file && item.target === target) ?? { path: a.file, target, status: "M" }
        : { path: a.file, target, status: detail?.files.find(file => file.path === a.file)?.status ?? "M" };
      // The exact diff validated above is the diff rendered below; no second read can shift its lines.
      setChoice(item); setParkedFile(null); setDiff(value); resetFileInfo(); setFileView("diff");
      shownDiffRevision = item.revision ?? "";
      setMcpHighlight({ repo: path, target, file: a.file, text: value.text, rows: selectedRows });
    } else setMcpHighlight(null);
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    await valid();
    if (request !== navigationRequest || activePath() !== path || selected() !== (detail?.hash ?? "working")) throw new Error("The view changed before navigation could be confirmed");
    const commitIndex = displayedCommits().findIndex(item => item.hash === detail?.hash);
    if (commitIndex >= 0) {
      commitScroll.scrollTop = Math.max(0, listHeaderHeight() + commitIndex * rowHeight() - (commitScroll.clientHeight - rowHeight()) / 2);
      setScrollTop(commitScroll.scrollTop);
    }
    const elements = detailsScroll?.querySelectorAll<HTMLElement>(".diff-line.ai-highlight");
    if (selectedRows.size && elements?.length !== selectedRows.size) throw new Error("GitFerry could not confirm the rendered highlights");
    (elements?.[0] ?? detailsScroll?.querySelector<HTMLElement>(".diff-heading"))?.scrollIntoView({ block: "center" });
    return { ...mcpView(), confirmed: true };
  }
  function closeFileFinder() {
    fileFinderRequest++;
    if (fileFinderTimer) clearTimeout(fileFinderTimer);
    setFileFinderOpen(false); setFileFinderBusy(false);
  }
  async function loadTrackedFiles(query: string, id: number) {
    const path = activePath();
    if (!path) return;
    try {
      const result = demoMode ? ["src/components/RepositoryView.tsx", "src/styles/diff.css", "docs/notes.md"].filter(file => file.toLowerCase().includes(query.toLowerCase())) : await invoke<string[]>("repo_tracked_files", { path, query });
      if (id === fileFinderRequest && fileFinderOpen() && activePath() === path) setFileFinderResults(result);
    } catch (cause) { if (id === fileFinderRequest) setFileFinderError(String(cause)); }
    finally { if (id === fileFinderRequest) setFileFinderBusy(false); }
  }
  function searchTrackedFiles(query: string) {
    setFileFinderQuery(query); setFileFinderResults([]); setFileFinderError(""); setFileFinderBusy(true);
    if (fileFinderTimer) clearTimeout(fileFinderTimer);
    const id = ++fileFinderRequest;
    fileFinderTimer = setTimeout(() => void loadTrackedFiles(query, id), query ? 220 : 0);
  }
  function openFileFinder() {
    if (!repoReady()) return;
    setFileFinderOpen(true); setFileFinderQuery("");
    searchTrackedFiles("");
  }
  function inspectTrackedFile(file: string) {
    closeFileFinder();
    selectWorking();
    setChoice({ path: file, status: "", target: "tracked" });
    setDiff(null);
    openFileView("history");
  }
  function setRebaseMessage(hash: string, message: string) {
    setRebasePlan(previous => previous && ({ ...previous, steps: previous.steps.map(item => item.hash === hash ? { ...item, editedMessage: message } : item) }));
  }
  function rebasePlanError(steps: RebaseStep[]) {
    const firstKept = steps.find(item => item.action !== "drop");
    if (firstKept?.action === "fixup" || firstKept?.action === "squash") return "The first kept commit cannot be Fixup or Squash.";
    if (steps.some(item => item.action === "reword" && !(item.editedMessage ?? item.message).trim())) return "Reword needs a commit message.";
    if (steps.some(item => item.action === "reword" && new TextEncoder().encode(item.editedMessage ?? item.message).length > 8 * 1024)) return "Reword messages must be at most 8 KiB.";
    return "";
  }
  function startPlannedRebase() {
    const plan = rebasePlan();
    if (!plan) return;
    if (rebasePlanError(plan.steps)) return;
    setRebaseAmendMessage("");
    setRebasePlan(null);
    void runAction({ kind: "interactive_rebase", value: { branch: plan.branch, onto: plan.onto, steps: plan.steps.map(({ hash, action, message, editedMessage }) => ({ hash, action, message: action === "reword" ? editedMessage ?? message : undefined })) } });
  }
  async function commitChanges() {
    if (!commitMessage().trim()) return;
    await runAction({ kind: "commit", value: { message: commitMessage(), amend: amend() } });
    if (!error()) { setCommitMessage(""); setAmend(false); }
  }
  function revealCommit(index: number) {
    const top = index < 0 ? (comparison() ? compareRowHeight : 0) : listHeaderHeight() + index * rowHeight();
    const bottom = top + (index < 0 ? workingRowHeight : rowHeight());
    const current = commitScroll.scrollTop;
    const next = top < current ? top : bottom > current + commitScroll.clientHeight ? bottom - commitScroll.clientHeight : current;
    if (next !== current) { commitScroll.scrollTop = next; setScrollTop(next); }
    commitScroll.focus({ preventScroll: true });
  }
  async function moveCommit(direction: number) {
    const current = displayedCommits();
    let index = selected() === "working" ? -1 : current.findIndex(item => item.hash === selected());
    if (direction > 0 && index === current.length - 1 && hasMore()) await loadMore();
    const commits = displayedCommits();
    if (!commits.length) return;
    if (direction < 0 && index < 0 && (selected() !== "working" || searchQuery())) index = commits.length;
    const next = Math.max(searchQuery() ? 0 : -1, Math.min(commits.length - 1, index + direction));
    if (next === index) return;
    navigationArea = "commits";
    if (next < 0) selectWorking(); else void selectCommit(commits[next].hash);
    revealCommit(next);
  }
  function revealFile(index: number) {
    detailsScroll.focus({ preventScroll: true });
    requestAnimationFrame(() => detailsScroll.querySelectorAll<HTMLElement>(".summary-diff-card .file-row")[index]?.scrollIntoView({ block: "nearest" }));
  }
  function moveFile(direction: number) {
    const list = navigationFiles();
    if (!list.length) return;
    const current = choice()
      ? list.findIndex(item => diffKey(item) === diffKey(choice()!))
      : list.findIndex(item => summaryKey(item) === keyboardFileKey());
    const next = Math.max(0, Math.min(list.length - 1, current < 0 ? direction > 0 ? 0 : list.length - 1 : current + direction));
    const item = list[next];
    navigationArea = "files";
    setKeyboardFileKey(summaryKey(item));
    if (choice()) { void selectFile(item); detailsScroll.focus({ preventScroll: true }); }
    else revealFile(next);
  }
  function expandKeyboardFile() {
    const list = navigationFiles();
    const index = list.findIndex(item => summaryKey(item) === keyboardFileKey());
    const item = index < 0 ? choice() ?? list[0] : list[index];
    if (!item) return;
    navigationArea = "files";
    setKeyboardFileKey(summaryKey(item));
    if (choice()) {
      setChoice(null); setDiff(null);
      if (!isSummaryExpanded(item)) toggleSummaryDiff(item);
      revealFile(Math.max(0, list.findIndex(file => diffKey(file) === diffKey(item))));
    } else {
      toggleSummaryDiff(item);
      revealFile(index < 0 ? 0 : index);
    }
  }
  function tagSelectedCommit() {
    const hash = details()?.hash;
    if (!hash) return;
    openActionDialog({ title: "Create tag", description: `Tag commit ${hash.slice(0, 8)}.`, submitLabel: "Create tag", fields: [{ key: "name", label: "Tag name", value: "", placeholder: "v1.0.0" }],
      onSubmit: ({ name }) => void runAction({ kind: "create_tag", value: { name, hash } }),
    });
  }
  function stashChanges() {
    openActionDialog({ title: "Stash changes", description: "Save the current working changes for later.", submitLabel: "Stash", fields: [{ key: "message", label: "Stash message", value: "Work in progress" }],
      onSubmit: ({ message }) => void runAction({ kind: "stash", value: { message } }),
    });
  }
  function closeTab(path: string) {
    const draft = fileDraft();
    if (draft?.repo === path && draft.text !== draft.original) {
      openActionDialog({ title: `Close repository with unsaved edits to ${draft.path}?`, submitLabel: "Discard and close", danger: true, fields: [], onSubmit: () => { setFileDraft(null); closeTab(path); } });
      return;
    }
    if (draft?.repo === path) setFileDraft(null);
    const editing = sideEditor();
    if (editing?.repo === path && sideEditorDirty()) {
      openActionDialog({ title: `Close repository with unsaved edits to ${editing.path}?`, submitLabel: "Discard and close", danger: true, fields: [], onSubmit: () => { setSideEditorDirty(false); closeTab(path); } });
      return;
    }
    // The editor stays open for the other tabs, empty.
    if (editing?.repo === path) setSideEditor({ ...editing, repo: "", path: "", commit: undefined, marks: null });
    const next = tabs().filter(item => item.path !== path);
    setTabs(next);
    tabViews.delete(path); pendingComparisons.delete(path); initialSelection.delete(path); updateComparison(path, () => null);
    if (activePath() === path) { setActivePath(next.length ? next[next.length - 1].path : null); setScrollTop(0); selectWorking(); }
    saveTabs();
  }
  // Pointer-based dragging: native HTML drag events are swallowed by the webview folder-drop handler.
  // The dragged tab follows the pointer while the others slide aside; the order is committed on drop.
  function startTabDrag(path: string, event: PointerEvent) {
    if (event.button !== 0 || tabDrag() || (event.target as Element).closest(".tab-close")) return;
    const from = tabs().findIndex(item => item.path === path);
    if (from < 0) return;
    const startX = event.clientX, startScroll = tabStrip.scrollLeft;
    let rects: { left: number; right: number }[] = [];
    let dragging = false;
    const offsetFor = (to: number) => to > from ? rects[to].right - rects[from].right : to < from ? rects[to].left - rects[from].left : 0;
    const move = (moveEvent: PointerEvent) => {
      if (!dragging) {
        if (Math.abs(moveEvent.clientX - startX) < 5) return;
        dragging = true;
        rects = Array.from(tabStrip.querySelectorAll<HTMLElement>(".repo-tab")).map(element => ({ left: element.offsetLeft, right: element.offsetLeft + element.offsetWidth }));
      }
      const strip = tabStrip.getBoundingClientRect();
      if (moveEvent.clientX < strip.left + 30) tabStrip.scrollLeft -= 12;
      else if (moveEvent.clientX > strip.right - 30) tabStrip.scrollLeft += 12;
      const width = rects[from].right - rects[from].left;
      const dx = Math.min(Math.max(moveEvent.clientX - startX + tabStrip.scrollLeft - startScroll, rects[0].left - rects[from].left), rects[rects.length - 1].right - rects[from].right);
      // Swap with a neighbour once the dragged tab's leading edge passes its middle.
      const middle = (rect: { left: number; right: number }) => (rect.left + rect.right) / 2;
      const to = from + rects.filter((rect, index) => index > from && middle(rect) < rects[from].right + dx).length - rects.filter((rect, index) => index < from && middle(rect) > rects[from].left + dx).length;
      setTabDrag({ path, from, to, dx, width, settling: false });
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      const drag = tabDrag();
      if (!dragging || !drag) return;
      suppressTabClick = true;
      setTimeout(() => { suppressTabClick = false; });
      setTabDrag({ ...drag, dx: offsetFor(drag.to), settling: true });
      setTimeout(() => batch(() => {
        const next = [...tabs()];
        const index = next.findIndex(item => item.path === path);
        if (index >= 0) next.splice(drag.to, 0, next.splice(index, 1)[0]);
        setTabs(next); setTabDrag(null); saveTabs();
      }), 150);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  }
  function tabShift(path: string, index: number) {
    const drag = tabDrag();
    if (!drag) return undefined;
    if (drag.path === path) return `translateX(${drag.dx}px)`;
    if (drag.from < drag.to && index > drag.from && index <= drag.to) return `translateX(${-drag.width}px)`;
    if (drag.to < drag.from && index >= drag.to && index < drag.from) return `translateX(${drag.width}px)`;
    return undefined;
  }
  function startResize(which: "locations" | "commits" | "history" | "editor", event: PointerEvent) {
    event.preventDefault();
    if (which === "editor") {
      // The editor sits on the right, so dragging its splitter left widens it.
      const startX = event.clientX, start = sideEditorWidth();
      const move = (next: PointerEvent) => setSideEditorWidth(Math.max(320, Math.min(window.innerWidth - 480, start - next.clientX + startX)));
      const stop = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop); localStorage.setItem("gitferry.editorWidth", String(sideEditorWidth())); };
      window.addEventListener("pointermove", move); window.addEventListener("pointerup", stop);
      return;
    }
    const startPosition = which === "history" ? event.clientY : event.clientX;
    const startWidth = which === "locations" ? locationsWidth() : which === "history" ? commitsHeight() : commitsWidth();
    const move = (next: PointerEvent) => {
      if (which === "history") {
        setCommitsHeight(Math.max(180, Math.min(window.innerHeight - 320, startWidth + next.clientY - startPosition)));
        if (commitScroll) setViewportHeight(commitScroll.clientHeight);
        return;
      }
      const maximum = which === "locations"
        ? Math.min(320, window.innerWidth - commitsWidth() - 360)
        : Math.min(600, window.innerWidth - (locationsOpen() ? locationsWidth() : 0) - 360);
      const width = Math.max(which === "locations" ? 150 : 280, Math.min(maximum, startWidth + next.clientX - startPosition));
      if (which === "locations") setLocationsWidth(width); else setCommitsWidth(width);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop);
      localStorage.setItem("gitferry.locationsWidth", String(locationsWidth()));
      localStorage.setItem("gitferry.commitsWidth", String(commitsWidth()));
      localStorage.setItem("gitferry.commitsHeight", String(commitsHeight()));
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", stop);
  }
  createEffect(on(() => [activePath(), selected(), choice()?.path, choice()?.target], () => setDiffSelection({ rows: [], hunkIndex: null })));
  onMount(() => {
    let unlistenMcp: (() => void) | undefined;
    if (isTauri()) void listen<McpRequest>("mcp-request", event => {
      void handleMcp(event.payload).then(result => invoke("mcp_reply", { id: event.payload.id, result, error: null }),
        cause => invoke("mcp_reply", { id: event.payload.id, result: null, error: String(cause) })).catch(cause => setMcpError(String(cause)));
    }).then(unlisten => {
      unlistenMcp = unlisten;
      if (localStorage.getItem("gitferry.mcpEnabled") === "true") void setMcpEnabled(true);
    }).catch(cause => setMcpError(String(cause)));
    let unlistenDrop: (() => void) | undefined;
    let unlistenProgress: (() => void) | undefined;
    if (isTauri()) void listen<{ path: string; message: string }>("git-progress", event => {
      if (event.payload.path === activePath()) setProgress(event.payload.message);
    }).then(unlisten => { unlistenProgress = unlisten; }).catch(cause => setError(String(cause)));
    const unlistenSsh: (() => void)[] = [];
    // Restored SSH tabs connect right away; pick up a prompt that was asked before these listeners existed.
    if (isTauri()) void Promise.all([
      listen<SshPrompt>("ssh-prompt", event => showSshPrompt(event.payload)),
      listen<number>("ssh-prompt-closed", event => { if (sshPrompt()?.id === event.payload) setSshPrompt(null); }),
    ]).then(unlisteners => { unlistenSsh.push(...unlisteners); return invoke<SshPrompt | null>("ssh_current_prompt"); })
      .then(prompt => { if (prompt) showSshPrompt(prompt); }).catch(cause => setError(String(cause)));
    if (isTauri()) void getCurrentWebview().onDragDropEvent(event => {
      if (event.payload.type === "drop") {
        setDraggingFolder(false);
        for (const path of event.payload.paths) void openRepo(path);
      } else setDraggingFolder(event.payload.type === "enter" || event.payload.type === "over");
    }).then(unlisten => { unlistenDrop = unlisten; }).catch(cause => setError(String(cause)));
    if (demoMode) {
      const hashes = Array.from({ length: 7 }, (_, index) => String(index + 1).repeat(40));
      const sample: Repo = {
        path: "ssh://root@warmer/srv/atelier", name: "atelier", branch: "feature/remote-git", head: hashes[0],
        status: [{ path: "src/components/RepositoryView.tsx", index: " ", worktree: "M" }, { path: "src/styles/diff.css", index: "M", worktree: " " }, { path: "docs/notes.md", index: "?", worktree: "?" }],
        refs: [{ name: "feature/remote-git", kind: "branch", target: hashes[0], isHead: true, behind: 57 }, { name: "main", kind: "branch", target: hashes[3], isHead: false, ahead: 1 }, { name: "origin/main", kind: "remote", target: hashes[3], isHead: false }, { name: "v0.9.0", kind: "tag", target: hashes[6], isHead: false }],
        remotes: ["origin"],
        commits: ["Refine repository overview layout", "Add persistent SSH transport", "Handle binary file previews", "Merge branch feature/graph", "Improve diff readability", "Create agent protocol", "Initialize project scaffold"].map((subject, index) => ({ hash: hashes[index], parents: index === 3 ? [hashes[4], hashes[5]] : index < 6 ? [hashes[index + 1]] : [], subject, author: index % 2 ? "Alex Morgan" : "Sam Rivera", timestamp: Date.now() / 1000 - index * 86400, decorations: index === 0 ? ["HEAD -> feature/remote-git"] : index === 3 ? ["origin/main"] : [] })),
        hasMore: false,
      };
      const requestedTabs = Number(new URLSearchParams(location.search).get("tabs")) || 1;
      const count = Math.min(12, Math.max(1, Math.floor(requestedTabs)));
      const duplicateNames = new URLSearchParams(location.search).has("duplicateNames");
      setTabs(Array.from({ length: count }, (_, index) => index === 0 ? sample : { ...sample, path: `${sample.path}-${index + 1}`, name: duplicateNames ? sample.name : `repository-${index + 1}`, branch: `feature/tab-overflow-${index + 1}` }));
      setActivePath(sample.path);
    }
    try {
      const saved = JSON.parse(localStorage.getItem(recentKey) ?? "[]");
      if (Array.isArray(saved)) setRecent(saved.filter((item): item is string => typeof item === "string"));
    } catch { /* Ignore invalid old settings. */ }
    for (const item of restored.tabs) void restoreRepo(item.path);
    const interval = window.setInterval(() => { if (watchFallback() && document.visibilityState === "visible") void refreshState(); }, 8000);
    const focus = () => void refreshState();
    const visibility = () => { if (document.visibilityState === "visible") void refreshState(); };
    const keys = (event: KeyboardEvent) => {
      if (event.key === "Escape" && sshPrompt()) { answerSshPrompt(null); return; }
      if (event.key === "Escape") { setPaletteOpen(false); setShowOpen(false); setShowSettings(false); setActionDialog(null); closeFileFinder(); setRebasePlan(null); setBranchMenu(false); setTabListOpen(false); setRefMenu(null); setPushMenu(false); setPullMenu(false); setMoreMenu(false); setStashMenu(false); setErrorDetails(false); return; }
      const target = event.target instanceof Element ? event.target : null;
      const modalOpen = Boolean(sshPrompt()) || paletteOpen() || showOpen() || showSettings() || Boolean(actionDialog()) || Boolean(rebasePlan()) || Boolean(refMenu()) || branchMenu() || tabListOpen() || pushMenu() || pullMenu() || moreMenu() || stashMenu();
      const editable = Boolean(target?.closest("input, textarea, select, [contenteditable='true']"));
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !modalOpen) {
        const inCommitEditor = Boolean(target?.closest(".commit-editor textarea"));
        if (!editable || inCommitEditor) {
          if (inCommitEditor) event.preventDefault();
          const button = detailsScroll?.querySelector<HTMLButtonElement>(".commit-editor-actions button:not(:disabled)");
          if (button) { event.preventDefault(); button.click(); }
        }
        return;
      }
      if (event.ctrlKey || event.metaKey) {
        if (event.key.toLowerCase() === "s" && fileView() === "edit" && selected() === "working") { event.preventDefault(); void saveEditedFile(); return; }
        if (event.key.toLowerCase() === "p") { event.preventDefault(); setPaletteInput(""); setPaletteOpen(true); requestAnimationFrame(() => document.querySelector<HTMLInputElement>(".palette input")?.focus()); }
        if (event.key.toLowerCase() === "o") { event.preventDefault(); setShowOpen(true); }
        if (event.key.toLowerCase() === "r") { event.preventDefault(); void refresh(); }
        return;
      }
      if (modalOpen || editable || event.altKey || event.shiftKey || !repoReady()) return;
      const area = target?.closest(".details-pane") ? "files" : target?.closest(".commits-pane") ? "commits" : navigationArea;
      if (event.key === "ArrowRight" && area === "commits" && navigationFiles().length) { event.preventDefault(); moveFile(1); return; }
      if (event.key === "ArrowLeft" && area === "files") { event.preventDefault(); navigationArea = "commits"; revealCommit(selected() === "working" ? -1 : displayedCommits().findIndex(item => item.hash === selected())); return; }
      if (event.key === "Enter" && area === "files" && !target?.closest("button:not(.file-row)")) { event.preventDefault(); expandKeyboardFile(); return; }
      const direction = event.key === "ArrowDown" || event.key.toLowerCase() === "j" ? 1 : event.key === "ArrowUp" || event.key.toLowerCase() === "k" ? -1 : 0;
      if (!direction) return;
      event.preventDefault();
      if (area === "files") moveFile(direction); else void moveCommit(direction);
    };
    window.addEventListener("focus", focus); window.addEventListener("keydown", keys); document.addEventListener("visibilitychange", visibility);
    const resize = () => { if (commitScroll) setViewportHeight(commitScroll.clientHeight); requestAnimationFrame(updateTabScroll); };
    window.addEventListener("resize", resize);
    onCleanup(() => { unlistenMcp?.(); unlistenDrop?.(); unlistenProgress?.(); unlistenSsh.forEach(unlisten => unlisten()); window.clearInterval(interval); window.removeEventListener("focus", focus); window.removeEventListener("keydown", keys); document.removeEventListener("visibilitychange", visibility); window.removeEventListener("resize", resize); });
  });

  return <div class="app-shell" onPointerDown={event => { if (event.target instanceof Element) { if (!event.target.closest(".push-control")) { setPushMenu(false); setPullMenu(false); setMoreMenu(false); } if (!event.target.closest(".status-control")) setErrorDetails(false); if (!event.target.closest(".stash-control")) setStashMenu(false); if (!event.target.closest(".tab-navigation")) setTabListOpen(false); if (!event.target.closest(".ref-action-popover, .ref-action-trigger")) setRefMenu(null); } }}>
    <Show when={draggingFolder()}><div class="drop-overlay"><div><strong>Open repository</strong><span>Drop a Git folder here</span></div></div></Show>
    <header class="tabbar">
      <div class={`tab-strip ${tabDrag() ? "reordering" : ""}`} ref={tabStrip} onScroll={updateTabScroll} onWheel={event => { if (tabOverflow() && Math.abs(event.deltaY) > Math.abs(event.deltaX)) { event.preventDefault(); tabStrip.scrollLeft += event.deltaY; } }}>
      <For each={tabs()}>{(item, index) => <div style={{ transform: tabShift(item.path, index()) }} class={`repo-tab ${activePath() === item.path ? "active" : ""} ${item.loading ? "loading" : ""} ${item.loadError ? "unavailable" : ""} ${tabDrag()?.path === item.path ? `dragging ${tabDrag()!.settling ? "settling" : ""}` : ""}`} onPointerDown={event => startTabDrag(item.path, event)}>
        <button class="tab-main" title={`${item.name} · ${item.branch}`} onClick={() => { if (!suppressTabClick) activateTab(item.path); }}><span class="tab-name">{item.name}</span><Show when={tabBranchVisibility().get(item.path)}><span class="tab-branch">{item.branch}</span></Show></button>
        <button class="tab-close" aria-label={`Close ${tabDisplayName(item)}`} onClick={() => closeTab(item.path)}><Icon name="close" /></button>
      </div>}</For>
      </div><div class="tab-navigation"><Show when={tabOverflow()}><button class="tab-scroll-button" title="Scroll tabs left" aria-label="Scroll tabs left" disabled={!canScrollTabsLeft()} onClick={() => tabStrip.scrollBy({ left: -Math.max(180, tabStrip.clientWidth * .7), behavior: "smooth" })}><Icon name="left" /></button><button class="tab-scroll-button" title="Scroll tabs right" aria-label="Scroll tabs right" disabled={!canScrollTabsRight()} onClick={() => tabStrip.scrollBy({ left: Math.max(180, tabStrip.clientWidth * .7), behavior: "smooth" })}><Icon name="right" /></button><button class="tab-list-button" title="List open repositories" aria-label="List open repositories" aria-expanded={tabListOpen()} onClick={() => setTabListOpen(!tabListOpen())}><Icon name="down" /></button></Show><button class="tab-add" title="Open repository" aria-label="Open repository" onClick={() => setShowOpen(true)}><Icon name="plus" /></button><Show when={tabListOpen()}><div class="tab-list-menu"><For each={tabs()}>{item => <button class={activePath() === item.path ? "active" : ""} title={item.path} onClick={() => activateTab(item.path)}><strong>{item.name}</strong><span>{item.branch}</span></button>}</For></div></Show></div>
      <button class="settings-button" title="Settings" aria-label="Settings" onClick={() => setShowSettings(true)}><Icon name="settings" /></button>
    </header>
    <div class="toolbar">
      <div class="toolbar-side">
        <button class="toolbar-icon" title="Toggle locations" onClick={() => setLocationsOpen(!locationsOpen())}><Icon name="sidebar" /></button>
        <button class="toolbar-icon layout-toggle" title={bottomLayout() ? "Show details beside history" : "Show details below history"} onClick={() => { const next = !bottomLayout(); setBottomLayout(next); localStorage.setItem("gitferry.bottomLayout", String(next)); requestAnimationFrame(() => { if (commitScroll) setViewportHeight(commitScroll.clientHeight); }); }}><Icon name={bottomLayout() ? "rows" : "columns"} /></button>
      </div>
        <div class="toolbar-center">
          <Show when={repoReady()}><button class="toolbar-button" title="Stash" disabled={actionBusy()} onClick={stashChanges}><Icon name="stash" /><span>Stash</span></button><div class="stash-control"><button class="toolbar-button" title="Unstash" aria-expanded={stashMenu()} disabled={actionBusy()} onClick={() => setStashMenu(!stashMenu())}><Icon name="unstash" /><span>Unstash</span><Show when={stashes().length}><small>{stashes().length}</small></Show></button><Show when={stashMenu()}><div class="stash-menu"><div class="eyebrow">SAVED STASHES</div><Show when={stashes().length} fallback={<div class="stash-empty">No saved stashes</div>}><For each={stashes()}>{item => <div class="stash-menu-row"><div class="stash-menu-label" title={item.name}>{item.name}</div><div class="stash-menu-actions"><button disabled={actionBusy()} title="Restore changes and keep this stash" onClick={() => void runAction({ kind: "apply_stash", value: { hash: item.target } })}>Apply</button><button disabled={actionBusy()} title="Restore changes and remove this stash" onClick={() => void runAction({ kind: "pop_stash", value: { hash: item.target } })}>Pop</button></div></div>}</For></Show></div></Show></div></Show>
          <Show when={!busyStatus() && !error()} fallback={<div class="status-control"><Show when={busyStatus()} fallback={<div class="error-bar status-chip" role="alert"><button class="status-chip-text" title="Show the full error" aria-expanded={errorDetails()} onClick={() => setErrorDetails(!errorDetails())}>{error().split("\n")[0]}</button><button title="Dismiss error" aria-label="Dismiss error" onClick={() => setError("")}><Icon name="close" /></button></div>}><div class="progress-bar status-chip" role="status"><span>{progress() || "Starting Git operation…"}</span><Show when={cancelToken()}><button disabled={cancelRequested()} onClick={() => void cancelAction()}>{cancelRequested() ? "Cancelling…" : "Cancel"}</button></Show></div></Show>
            <Show when={errorDetails() && error() && !busyStatus()}><div class="error-details"><pre>{error()}</pre><div class="error-details-actions"><button onClick={() => copyText(error())}>Copy</button><button onClick={() => setError("")}>Dismiss</button></div></div></Show></div>}><Show when={repo()} fallback={<span class="toolbar-title">Open a repository to begin</span>}><Show when={searchOpen() || searchQuery()} fallback={<div class="branch-control"><button class="branch-chip" title={repo()?.branch} disabled={!repoReady()} aria-expanded={branchMenu()} onClick={() => { const opening = !branchMenu(); setBranchMenu(opening); if (opening) { setBranchFilter(""); requestAnimationFrame(() => document.querySelector<HTMLInputElement>(".branch-menu-filter")?.focus()); } }}><span class="branch-icon"><Icon name="branch" /></span><span class="branch-name">{repo()?.branch}</span><span class="branch-arrow"><ChevronDown /></span></button>
          <Show when={branchMenu()}><div class="branch-menu"><input class="branch-menu-filter" type="search" aria-label="Filter branches" placeholder="Filter branches" value={branchFilter()} onInput={event => setBranchFilter(event.currentTarget.value)} />
            <div class="branch-menu-list"><div class="eyebrow">LOCAL BRANCHES</div><For each={matchingLocalBranches()}>{item => <div class="branch-menu-row"><button disabled={actionBusy()} onClick={() => void runAction({ kind: "checkout", value: { branch: item.name } })}>{item.isHead ? "✓ " : ""}{item.name}</button><Show when={!item.isHead}><button title={`Merge ${item.name} into ${repo()?.branch}`} disabled={actionBusy()} onClick={() => void runAction({ kind: "merge", value: { branch: item.name } }, `Merge ${item.name} into ${repo()?.branch}?`)}>Merge</button><button title={`Rebase ${repo()?.branch} onto ${item.name}`} disabled={actionBusy()} onClick={() => void runAction({ kind: "rebase", value: { branch: item.name } }, `Rebase ${repo()?.branch} onto ${item.name}?`)}>Rebase</button><button title={`Plan an interactive rebase onto ${item.name}`} disabled={actionBusy() || rebaseLoading()} onClick={() => void openRebasePlan(item.name)}>Plan…</button><button class="branch-delete" title={`Delete ${item.name}`} disabled={actionBusy()} onClick={() => void runAction({ kind: "delete_branch", value: { branch: item.name } }, `Delete branch ${item.name}?`)}><Icon name="close" /></button></Show><button title={`More actions for ${item.name}`} aria-label={`More actions for ${item.name}`} disabled={actionBusy()} onClick={event => openRefMenu(item, event.currentTarget)}><Icon name="more" /></button></div>}</For>
              <div class="eyebrow branch-menu-section">REMOTE BRANCHES</div><For each={matchingRemoteBranches()}>{item => <div class="branch-menu-row branch-menu-remote"><button title={`Create tracking branch from ${item.name}`} disabled={actionBusy()} onClick={() => { const target = remoteBranch(item); if (target) void runAction({ kind: "track_remote_branch", value: target }); }}>{item.name}</button></div>}</For>
              <Show when={!matchingLocalBranches().length && !matchingRemoteBranches().length}><div class="branch-menu-empty">No matching branches</div></Show></div>
            <form onSubmit={event => { event.preventDefault(); void runAction({ kind: "create_branch", value: { branch: newBranch() } }); setNewBranch(""); }}><input value={newBranch()} onInput={event => setNewBranch(event.currentTarget.value)} placeholder="New branch name" /><button type="submit" disabled={actionBusy()}>Create</button></form></div></Show>
        </div>}><form class="search-box" onSubmit={event => { event.preventDefault(); void performSearch(); }}><Icon name="search" /><input ref={searchInputRef} value={searchInput()} onKeyDown={event => { if (event.key === "Escape") closeSearch(); }} onInput={event => { setSearchInput(event.currentTarget.value); if (!event.currentTarget.value) void performSearch(""); }} placeholder="Search commits" title="Search message, author:name, or path:file" /><Show when={searchQuery()}><button type="button" title="Clear search" onClick={closeSearch}><Icon name="close" /></button></Show></form></Show></Show></Show>
          <Show when={repoReady()}><button class="toolbar-icon" title="Search commits" aria-pressed={searchOpen() || Boolean(searchQuery())} onClick={() => searchOpen() || searchQuery() ? closeSearch() : openSearch()}><Icon name="search" /></button>
            <div class="push-control"><button class="toolbar-icon" title="More actions" aria-label="More actions" aria-expanded={moreMenu()} onClick={() => setMoreMenu(!moreMenu())}><Icon name="more" /></button><Show when={moreMenu()}><div class="push-menu"><button title="Refresh" onClick={() => { setMoreMenu(false); void refresh(); }}>Refresh</button><button onClick={() => { setMoreMenu(false); setShowOpen(true); }}>Open repository…</button></div></Show></div></Show>
        </div>
      <div class="toolbar-side end">
        <Show when={repoReady()}><div class="push-control"><button class="toolbar-button" title="Pull" disabled={actionBusy()} onClick={() => void runAction({ kind: "pull" })}><Icon name="pull" /></button><button class="toolbar-button push-more" title="More pull options" aria-label="More pull options" aria-expanded={pullMenu()} disabled={actionBusy()} onClick={() => setPullMenu(!pullMenu())}><ChevronDown /></button><Show when={pullMenu()}><div class="push-menu"><button title="Fetch" disabled={actionBusy()} onClick={() => void runAction({ kind: "fetch" })}>Fetch</button><button onClick={() => void runAction({ kind: "pull_merge" })}>Pull with merge</button><button onClick={() => void runAction({ kind: "pull_rebase" })}>Pull with rebase</button><p>Choose how to combine diverged branches.</p></div></Show></div><div class="push-control"><button class="toolbar-button" title="Push" disabled={actionBusy()} onClick={() => void runAction({ kind: "push" })}><Icon name="push" /></button><button class="toolbar-button push-more" title="More push options" aria-label="More push options" aria-expanded={pushMenu()} disabled={actionBusy()} onClick={() => setPushMenu(!pushMenu())}><ChevronDown /></button><Show when={pushMenu()}><div class="push-menu"><button title="Force push with lease" disabled={actionBusy()} onClick={forcePushWithLease}>Force push with lease</button><p>Push only if the remote branch still matches your tracking branch.</p></div></Show></div></Show>
      </div>
    </div>
        <Show when={refMenu()}>{menu => <div class="ref-action-popover" style={{ left: `${menu().x}px`, top: `${menu().y}px` }} role="menu" aria-label={`Actions for ${menu().ref.name}`}><div class="ref-action-title" title={menu().ref.name}>{menu().ref.name}</div>
      <button onClick={() => { const name = menu().ref.name; setRefMenu(null); copyText(name); }}>Copy {menu().ref.kind === "tag" ? "tag" : "branch"} name</button>
      <Show when={(menu().ref.kind === "branch" || menu().ref.kind === "remote") && baseBranch() && baseBranch()!.name !== menu().ref.name && !menu().ref.name.endsWith("/HEAD")}><button onClick={() => { const ref = menu().ref; setRefMenu(null); void compareWithBase(ref); }}>Compare with {baseBranch()!.name}</button></Show>
      <Show when={(menu().ref.kind === "branch" && !menu().ref.isHead) || menu().ref.kind === "remote"}><button disabled={actionBusy()} onClick={() => checkoutRef(menu().ref)}>{menu().ref.kind === "remote" ? "Check out as local branch" : "Check out"}</button></Show>
      <Show when={menu().ref.kind === "branch"}><button disabled={actionBusy()} onClick={() => renameBranch(menu().ref.name)}>Rename branch…</button><button disabled={actionBusy()} onClick={() => pushRef(menu().ref)}>Push to remote…</button><Show when={!menu().ref.isHead}><button disabled={actionBusy()} onClick={() => { const branch = menu().ref.name; setRefMenu(null); void runAction({ kind: "delete_branch", value: { branch } }, `Delete merged branch ${branch}?`); }}>Delete branch</button><button class="danger" disabled={actionBusy()} onClick={() => { const branch = menu().ref.name; setRefMenu(null); void runAction({ kind: "force_delete_branch", value: { branch } }, `Force delete branch ${branch}? Unmerged commits may become unreachable.`); }}>Force delete branch</button></Show></Show>
      <Show when={menu().ref.kind === "remote" && !menu().ref.name.endsWith("/HEAD")}><button class="danger" disabled={actionBusy()} onClick={() => { const target = remoteBranch(menu().ref); setRefMenu(null); if (target) void runAction({ kind: "delete_remote_branch", value: target }, `Delete branch ${target.branch} from ${target.remote}?`); }}>Delete remote branch</button></Show>
      <Show when={menu().ref.kind === "tag"}><button disabled={actionBusy()} onClick={() => pushRef(menu().ref)}>Push tag to remote…</button><button disabled={actionBusy()} onClick={() => { const name = menu().ref.name; setRefMenu(null); void runAction({ kind: "delete_tag", value: { name } }, `Delete local tag ${name}?`); }}>Delete local tag</button><button class="danger" disabled={actionBusy()} onClick={() => deleteRemoteTag(menu().ref.name)}>Delete remote tag…</button></Show>
    </div>}</Show>
    <main class={`workspace ${repoReady() && bottomLayout() ? "alt" : ""} ${locationsOpen() ? "" : "no-locations"} ${sideEditor() ? "with-editor" : ""}`} ref={workspaceElement} style={{ "--history-height": `${commitsHeight()}px`, width: workspaceLock() === null ? undefined : `${workspaceLock()}px` }}>
    <Show when={repo()} fallback={<main class="welcome">
      <div class="welcome-symbol">◇</div><div class="eyebrow">YOUR REPOSITORIES, ALL IN ONE PLACE</div>
      <h1>Git, wherever it lives.</h1><p>Open a local repository to browse its history, changes, and diffs.</p>
      <button class="welcome-open" onClick={() => setShowOpen(true)}><Icon name="plus" />Open repository</button>
      <Show when={recent().length}><div class="recent-list"><div class="eyebrow">RECENT</div><For each={recent()}>{path => <button onClick={() => void openRepo(path)}><Icon name="folder" /><span>{path}</span></button>}</For></div></Show>
    </main>}>
      <Show when={repoReady()} fallback={<main class="repo-startup" role="status"><div class="repo-startup-icon">◇</div><strong>{repo()?.loading ? `Opening ${repo()?.name}…` : `Could not open ${repo()?.name}`}</strong><span>{repo()?.loadError || "Your saved repositories are loading."}</span><Show when={repo()?.loadError}><button onClick={() => retryRestoredRepo(repo()!.path)}>Retry</button></Show></main>}>
        <Show when={locationsOpen()}><aside class="locations" style={{ width: `${locationsWidth()}px` }}><div class="pane-heading">LOCATIONS</div><div class="locations-list">
          <For each={["branch", "remote", "tag", "stash", "submodule"]}>{kind => <section class="ref-section">
            <div class="section-heading"><ChevronDown />{kind === "branch" ? "BRANCHES" : kind === "remote" ? "REMOTES" : kind === "tag" ? "TAGS" : kind === "stash" ? "STASHES" : "SUBMODULES"} <span>{repo()?.refs.filter(item => item.kind === kind).length ?? 0}</span><Show when={kind === "remote"}><button class="ref-section-action" title="Delete a remote branch by name" onClick={deleteRemoteBranchByName}>Delete…</button></Show><Show when={kind === "tag"}><button class="ref-section-action" title="Delete a remote tag by name" onClick={() => deleteRemoteTag()}>Remote…</button></Show></div>
            <RefTree nodes={groupRefs(repo()?.refs.filter(item => item.kind === kind) ?? [], kind === "branch" || kind === "remote")} kind={kind} depth={0} overrides={folderOverrides()} onToggle={(key, open) => setFolderOverrides(previous => ({ ...previous, [key]: open }))} onSelect={hash => void jumpToCommit(hash, kind !== "stash")} onMenu={openRefMenu} onCheckout={checkoutRef} colorFor={ref => kind === "branch" || kind === "remote" ? branchColor(branchKey(ref.name, repo()?.remotes ?? [])) : undefined} />
          </section>}</For></div><div class="locations-footer"><span class="connection-dot" /> {repo()?.path.startsWith("ssh://") ? "SSH REPOSITORY" : "LOCAL REPOSITORY"}</div>
        </aside><div class="splitter locations-splitter" onPointerDown={event => startResize("locations", event)} /></Show>
        <section class="commits-pane" style={{ width: `${commitsWidth()}px` }} onPointerDown={() => { navigationArea = "commits"; }}><div class="pane-heading">{searchQuery() ? "SEARCH RESULTS" : "COMMITS"} <span class="heading-count">{displayedCommits().length}{hasMore() ? "+" : ""}</span></div>
          <div class="commit-scroll" ref={commitScroll} tabIndex={0} aria-label="Commit history" onScroll={event => {
            const element = event.currentTarget;
            setScrollTop(element.scrollTop);
            if (element.scrollHeight - element.scrollTop - element.clientHeight < 350) void loadMore();
          }}>
            <Show when={!searchQuery() && comparison()}>{current => <div class={`compare-row ${selected() === "compare" ? "selected" : ""}`} style={{ height: `${compareRowHeight}px` }}>
              <button class="compare-main" onClick={showComparison}><span class="branch-dot" style={{ background: branchColor(branchKey(current().head, repo()?.remotes ?? [])) }} /><span class="commit-main"><strong>{current().head} <span class="compare-vs">vs</span> {current().base}</strong><small>{current().error || (current().result ? `${current().result!.commits} commit${current().result!.commits === 1 ? "" : "s"} · ${current().result!.files.length} file${current().result!.files.length === 1 ? "" : "s"}` : "Comparing…")}</small></span></button>
              <Show when={!current().automatic}><button class="compare-close" title="Close comparison" aria-label="Close comparison" onClick={closeComparison}><Icon name="close" /></button></Show>
            </div>}</Show>
            <Show when={!searchQuery()}><button class={`working-row ${selected() === "working" ? "selected" : ""}`} onClick={selectWorking}><span class="working-node">●</span><span class="commit-main"><strong title={workingSummary()}>{workingSummary() || "Working Directory"}</strong><small>{workingSummary() ? "Commit Changes" : "No changes"}</small></span></button></Show>
            <div class="virtual-commits" style={{ height: `${displayedCommits().length * rowHeight()}px` }}>
              <For each={visibleCommits()}>{(item, position) => <button style={{ top: `${(visibleStart() + position()) * rowHeight()}px`, height: `${rowHeight()}px` }} class={`commit-row ${searchQuery() ? "search-result" : ""} ${selected() === item.hash ? "selected" : ""} ${repo()?.head === item.hash ? "checked-out" : ""}`} onClick={() => void selectCommit(item.hash)}>
                <Show when={!searchQuery()}><GraphRow step={graph()[visibleStart() + position()]} theme={theme()} height={rowHeight()} head={repo()?.head === item.hash} /></Show>
                <span class="commit-main"><span class="commit-subject">{item.subject}</span><span class="commit-meta"><span class="commit-author">{item.author}</span>
                  <Show when={item.decorations.length}><span class="decorations"><For each={item.decorations}>{label => <span class={`decoration ${label.startsWith("HEAD") ? "head" : ""} ${decorationColor(label) ? "branch" : ""}`} style={{ "--branch-color": decorationColor(label) }}>{label.replace(/^HEAD -> /, "")}</span>}</For></span></Show><span class="commit-date">{formatCommitDate(item.timestamp)}</span></span>
                </span>
              </button>}</For>
            </div>
            <Show when={hasMore()}><button class="load-more" disabled={busy() || searchBusy()} onClick={() => void loadMore()}>{busy() || searchBusy() ? "Loading…" : "Load more commits"}</button></Show>
            <Show when={!displayedCommits().length}><div class="empty-note">{searchBusy() ? "Searching…" : searchQuery() ? "No matching commits" : "No commits yet"}</div></Show>
          </div>
        </section><div class="splitter commits-splitter" onPointerDown={event => startResize(bottomLayout() ? "history" : "commits", event)} />
        <section class="details-pane" onPointerDown={() => { navigationArea = "files"; }}><div class="details-tabs"><button class={`details-tab ${!choice() ? "active" : ""}`} onClick={() => { if (choice()) setParkedFile(choice()); setChoice(null); setDiff(null); detailsScroll.scrollTop = 0; }}>SUMMARY</button><Show when={choice() ?? parkedFile()}>{file => <div class={`details-tab file-tab ${choice() ? "active" : ""}`} title={file().path}><button class="details-tab-label" onClick={() => { if (!choice()) void selectFile(file()); }}>{file().path.split("/").pop()?.split("\\").pop()}</button><button class="details-tab-close" title="Close file" aria-label={`Close ${file().path}`} onClick={closeFileTab}><Icon name="close" /></button></div>}</Show></div>
          <div class="details-scroll" ref={detailsScroll} tabIndex={0} aria-label="Changed files" onScroll={scheduleDetailsSave}>
            <Show when={selected() === "compare" && !choice() && comparison()}>{current => <div class="detail-header"><dl class="commit-facts">
                <dt>Comparing</dt><dd>{current().head} <span class="compare-vs">since it left</span> {current().base}</dd>
                <dt>Head</dt><dd class="mono">{current().headHash}</dd>
                <Show when={current().result}>{result => <><dt>Merge base</dt><dd class="mono"><button class="commit-link" title="Show merge base commit" onClick={() => void jumpToCommit(result().mergeBase)}>{result().mergeBase}</button></dd>
                <dt>Commits</dt><dd>{result().commits}</dd>
                <dt>Stats</dt><dd class="commit-stats">{result().files.length} file{result().files.length === 1 ? "" : "s"} changed: <span class="stat-deleted">-{result().deletions}</span><span class="stat-added">+{result().additions}</span></dd></>}</Show>
              </dl><Show when={current().error}><div class="empty-note">{current().error}</div></Show><Show when={!current().result && !current().error}><div class="empty-note">Comparing…</div></Show></div>}</Show>
            <Show when={selected() !== "working" && selected() !== "compare" && !choice()}><Show when={details()} fallback={<div class="empty-note">Loading commit…</div>}>
              <div class="detail-header"><dl class="commit-facts">
                <dt>Commit Hash</dt><dd class="mono">{details()!.hash}</dd>
                <Show when={details()!.tree}><dt>Tree</dt><dd class="mono">{details()!.tree}</dd></Show>
                <dt>Author</dt><dd>{details()!.author} &lt;{details()!.authorEmail}&gt;</dd>
                <dt>Date</dt><dd>{new Date(details()!.timestamp * 1000).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}</dd>
                <Show when={details()!.parents.length}><dt>{details()!.parents.length > 1 ? "Parents" : "Parent"}</dt><dd class="mono"><For each={details()!.parents}>{parent => <button class="commit-link" title="Show parent commit" onClick={() => void selectCommit(parent)}>{parent}</button>}</For></dd></Show>
                <Show when={commitDecorations().length}><dt>Branches</dt><dd class="commit-refs"><For each={commitDecorations()}>{label => <span class={`decoration ${label.startsWith("HEAD") ? "head" : ""} ${decorationColor(label) ? "branch" : ""}`} style={{ "--branch-color": decorationColor(label) }}>{label.replace(/^HEAD -> /, "")}</span>}</For></dd></Show>
                <dt>Stats</dt><dd class="commit-stats">{details()!.files.length} file{details()!.files.length === 1 ? "" : "s"} changed<Show when={details()!.additions != null}>: <span class="stat-deleted">-{details()!.deletions}</span><span class="stat-added">+{details()!.additions}</span></Show></dd>
              </dl><pre class="commit-message">{details()!.subject}{details()!.body ? `

${details()!.body.trimEnd()}` : ""}</pre></div>
            </Show></Show>
            <Show when={selected() !== "working" && selected() !== "compare" && !choice() && details()}><details class="commit-actions"><summary>Commit actions</summary><div class="commit-action-buttons"><button disabled={actionBusy()} onClick={() => void runAction({ kind: "cherry_pick", value: { hash: details()!.hash } })}>Cherry-pick</button><button disabled={actionBusy()} onClick={() => void runAction({ kind: "revert", value: { hash: details()!.hash } }, `Revert commit ${details()!.hash.slice(0, 8)}?`)}>Revert</button><button disabled={actionBusy()} onClick={() => void runAction({ kind: "detach", value: { hash: details()!.hash } }, `Check out ${details()!.hash.slice(0, 8)} in detached HEAD?`)}>Check out commit</button><button disabled={actionBusy()} onClick={tagSelectedCommit}>Create tag</button><button disabled={actionBusy()} onClick={() => void runAction({ kind: "reset", value: { hash: details()!.hash, mode: "soft" } }, `Soft reset ${repo()?.branch} to ${details()!.hash.slice(0, 8)}?`)}>Reset soft</button><button disabled={actionBusy()} onClick={() => void runAction({ kind: "reset", value: { hash: details()!.hash, mode: "mixed" } }, `Mixed reset ${repo()?.branch} to ${details()!.hash.slice(0, 8)}? This will unstage changes.`)}>Reset mixed</button><button class="danger" disabled={actionBusy()} onClick={() => void runAction({ kind: "reset", value: { hash: details()!.hash, mode: "hard" } }, `Hard reset ${repo()?.branch} to ${details()!.hash.slice(0, 8)}? This discards tracked working changes and commits after that point.`)}>Reset hard</button><For each={repo()?.refs.filter(item => item.kind === "tag" && item.target === details()!.hash)}>{item => <button class="danger" disabled={actionBusy()} onClick={() => void runAction({ kind: "delete_tag", value: { name: item.name } }, `Delete local tag ${item.name}?`)}>Delete tag {item.name}</button>}</For></div></details></Show>
            <Show when={repo()?.operation && !choice()}><div class="operation-panel">
              <strong>{repo()!.operation!.replace("_", "-")} in progress</strong>
              <span>{conflicts().length ? `${conflicts().length} conflicted file${conflicts().length === 1 ? "" : "s"}. Edit or choose a side, then stage each file.` : repo()?.rebaseEditPause ? "Edit pause: stage and amend the commit, then continue." : "Continue or abort the operation."}</span>
              <div class="operation-buttons"><button disabled={actionBusy() || !!conflicts().length} onClick={() => void runAction({ kind: "continue_operation" })}>Continue</button><button disabled={actionBusy()} onClick={() => void runAction({ kind: "abort_operation" }, `Abort the ${repo()?.operation?.replace("_", "-")}?`)}>Abort</button></div>
              <Show when={repo()?.rebaseEditPause && !conflicts().length}><div class="rebase-amend"><label>Amend at an Edit pause<textarea aria-label="Amended commit message" placeholder="New message (optional)" value={rebaseAmendMessage()} onInput={event => setRebaseAmendMessage(event.currentTarget.value)} /></label><div class="operation-buttons"><button disabled={actionBusy() || !workingFiles().some(item => item.target === "staged")} onClick={() => void runAction({ kind: "amend_no_edit" })}>Amend staged changes</button><button disabled={actionBusy() || !rebaseAmendMessage().trim()} onClick={() => void runAction({ kind: "commit", value: { message: rebaseAmendMessage(), amend: true } })}>Amend with message</button></div></div></Show>
              <For each={conflicts()}>{item => <div class="conflict-row"><button class="conflict-file" title={`Resolve ${item.path} in the editor`} onClick={() => openSideEditor({ path: item.path, status: "U", target: "working" }, 0, null)}>{item.path}</button><button disabled={actionBusy()} onClick={() => openSideEditor({ path: item.path, status: "U", target: "working" }, 0, null)}>Resolve in editor</button><button disabled={actionBusy()} onClick={() => void runAction({ kind: "resolve_file", value: { path: item.path, side: "ours" } }, `Use Git's ours version of ${item.path} and mark it resolved?`)}>Use ours</button><button disabled={actionBusy()} onClick={() => void runAction({ kind: "resolve_file", value: { path: item.path, side: "theirs" } }, `Use Git's theirs version of ${item.path} and mark it resolved?`)}>Use theirs</button><button disabled={actionBusy()} onClick={() => void runAction({ kind: "stage_file", value: { path: item.path } })}>Mark resolved</button></div>}</For>
            </div></Show>
            <Show when={selected() === "working" && !repo()?.operation && !choice()}><div class="commit-editor"><textarea value={commitMessage()} onInput={event => setCommitMessage(event.currentTarget.value)} placeholder="Commit message" rows="2" /><div class="commit-editor-actions"><label><input type="checkbox" checked={amend()} disabled={!repo()?.head} onChange={event => setAmend(event.currentTarget.checked)} /> Amend previous commit</label><button disabled={!commitMessage().trim() || actionBusy() || (!amend() && !workingFiles().some(item => item.target === "staged"))} onClick={() => void commitChanges()}>{commitLabel()}</button></div></div></Show>
            <Show when={!choice()}><div class={`files-heading multiple-actions ${files().length ? "toggles" : ""}`} onClick={event => { if (files().length && !(event.target as HTMLElement).closest("button:not(.files-disclosure)")) setEveryDiff(!isSummaryGroupExpanded(files())); }}><Show when={files().length} fallback={<strong class="files-title">CHANGED FILES <span>0</span></strong>}><button class="files-title files-disclosure" aria-expanded={isSummaryGroupExpanded(files())} aria-label={`${isSummaryGroupExpanded(files()) ? "Close" : "Open"} all changed files`}><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 4h8L6 8z" fill="currentColor" /></svg>CHANGED FILES <span>{files().length}</span></button></Show><div class="files-heading-spacer" /><button onClick={openFileFinder}>Browse files</button><Show when={selected() === "working" && files().length && !conflicts().length}><button disabled={actionBusy()} onClick={() => void runAction({ kind: "stage_all" })}>Stage All</button></Show></div><Show when={ignoreWhitespace() && files().length}><div class="diff-filter-note">{whitespaceNote()}</div></Show>
            <Show when={files().length} fallback={<div class="empty-note">No files to show</div>}><div class="files-list"><For each={fileGroups()}>{group => <><Show when={group.title}><div class="file-group-heading"><button class="group-disclosure" aria-label={`${isSummaryGroupExpanded(group.items) ? "Close" : "Open"} all ${group.title.toLowerCase()} changes`} aria-expanded={isSummaryGroupExpanded(group.items)} onClick={() => toggleSummaryGroup(group.items)}><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 4h8L6 8z" fill="currentColor" /></svg><span class="file-group-title">{group.title} <span>{group.items.length}</span></span></button><Show when={selected() === "working"}><span class="group-actions">{(() => {
                const paths = () => group.items.map(item => item.path);
                const discardable = () => group.items.filter(item => item.status !== "U").map(item => item.path);
                return <>
                  <Show when={group.title === "UNTRACKED"}><ConfirmButton class="row-action" disabled={actionBusy()} resetKey={paths().join("\0")} onConfirm={() => void runAction({ kind: "delete_untracked", value: { paths: paths() } })}>Delete All</ConfirmButton></Show>
                  <Show when={group.title === "UNSTAGED" && discardable().length}><ConfirmButton class="row-action" disabled={actionBusy()} resetKey={discardable().join("\0")} onConfirm={() => void runAction({ kind: "discard_files", value: { paths: discardable() } })}>Discard All</ConfirmButton></Show>
                  <Show when={group.title === "STAGED"} fallback={<button class="row-action" disabled={actionBusy()} onClick={() => void runAction({ kind: "stage_files", value: { paths: paths() } })}>Stage All</button>}><button class="row-action" disabled={actionBusy()} onClick={() => void runAction({ kind: "unstage_files", value: { paths: paths() } })}>Unstage All</button></Show>
                </>;
              })()}</span></Show></div></Show><For each={group.items}>{item => <DiffCard item={item} repoPath={repo()!.path} working={selected() === "working"} recent={selected() === "working" && item.target === "untracked" && item.modified !== undefined && now() - item.modified < recentlyModifiedMs} eager={files().length <= 20} ignoreWhitespace={ignoreWhitespace()} expanded={isSummaryExpanded(item)} keyboardSelected={keyboardFileKey() === summaryKey(item)} actionBusy={actionBusy()} scrollRoot={detailsScroll} onSelect={() => setKeyboardFileKey(summaryKey(item))} onToggle={() => { setKeyboardFileKey(summaryKey(item)); toggleSummaryDiff(item); }} onOpenTab={() => void selectFile(item)} onOpenEditor={value => void openInEditor(item, value)} onOpenEditorLine={(line, marks) => openSideEditor(item, line, marks)} onAction={(operation, confirmation) => void runAction(operation, confirmation)} onError={setError} />}</For></>}</For></div></Show></Show>
            <Show when={choice()}><div class="diff-heading"><span class="diff-heading-path" title={choice()?.path}>{choice()?.path}</span><Show when={fileView() === "diff" && choice()?.target !== "untracked" && choice()?.target !== "tracked"}><button class={`full-file-toggle ${fullFile() ? "active" : ""}`} aria-pressed={fullFile()} title="Show the whole file around the changes" onClick={() => { setFullFile(value => !value); if (choice()) void selectFile(choice()!); }}>Full file</button></Show><Show when={mcpHighlight()?.repo === activePath() && mcpHighlight()?.file === choice()?.path && mcpHighlight()?.target === choice()?.target}><button title="Clear AI highlights" onClick={() => setMcpHighlight(null)}>Clear AI highlights</button></Show><div class="file-view-switch" aria-label="File view"><Show when={choice()?.target !== "tracked"}><button class={fileView() === "diff" ? "active" : ""} aria-pressed={fileView() === "diff"} onClick={() => openFileView("diff")}>Diff</button></Show><Show when={selected() === "working" && choice()?.status !== "D"}><button class={fileView() === "edit" ? "active" : ""} aria-pressed={fileView() === "edit"} onClick={() => void editFile(choice()!)}>Edit</button></Show><button class={fileView() === "history" ? "active" : ""} aria-pressed={fileView() === "history"} onClick={() => openFileView("history")}>History</button><button class={fileView() === "blame" ? "active" : ""} aria-pressed={fileView() === "blame"} onClick={() => openFileView("blame")}>Blame</button></div><span class="diff-heading-target">{choice()?.target === "untracked" ? "NEW FILE" : choice()?.target === "tracked" ? "TRACKED" : choice()?.target === "working" ? "UNSTAGED" : choice()?.target === "staged" ? "STAGED" : choice()!.target.slice(0, 8)}</span><button class="diff-open-editor" title={`Open ${choice()?.path} in editor`} onClick={() => void openInEditor(choice()!, diff())}>Open in editor</button></div>
              <Show when={fileView() === "diff"}>
                <Show when={selected() === "working"}><div class="file-actions"><Show when={choice()?.target === "staged"} fallback={<button disabled={actionBusy()} onClick={() => void runAction({ kind: "stage_file", value: { path: choice()!.path } })}>{choice()?.target === "working" && choice()?.status === "U" ? "Mark resolved" : "Stage file"}</button>}><button disabled={actionBusy()} onClick={() => void runAction({ kind: "unstage_file", value: { path: choice()!.path } })}>Unstage file</button></Show><Show when={choice()?.target === "working" && choice()?.status !== "U"}><button class="danger" disabled={actionBusy()} onClick={() => void runAction({ kind: "discard_file", value: { path: choice()!.path } }, `Discard changes to ${choice()!.path}?`)}>Discard changes</button></Show></div></Show>
                <Show when={choice()?.target === "working" && choice()?.status === "U"}><div class="diff-filter-note">Conflicted file. Edit the file or choose a side in the conflict panel, then mark it resolved.</div></Show>
                <Show when={ignoreWhitespace() && choice()?.target !== "untracked"}><div class="diff-filter-note">{whitespaceNote()}</div></Show><Show when={fullFile() && !ignoreWhitespace() && selected() === "working" && choice()?.target !== "untracked" && choice()?.target !== "tracked"}><div class="diff-filter-note">Hunk and line staging is off in full-file view. Double-click a line to edit it in the side editor.</div></Show><Show when={diff()} fallback={<div class="empty-note">Loading diff…</div>}>{current => <DiffText value={current()} item={choice()!} working={selected() === "working"} ignoreWhitespace={ignoreWhitespace()} fullContext={fullFile()} actionBusy={actionBusy()} repoPath={repo()!.path} aiRows={mcpHighlight()?.repo === activePath() && mcpHighlight()?.file === choice()?.path && mcpHighlight()?.target === choice()?.target && mcpHighlight()?.text === current().text ? mcpHighlight()?.rows : undefined} onSelection={setDiffSelection} onOpenEditor={(line, marks) => openSideEditor(choice()!, line, marks)} onAction={(operation, confirmation) => void runAction(operation, confirmation)} />}</Show>
              </Show>
              <Show when={fileView() === "edit" && selected() === "working"}><div class="file-edit-view"><Show when={activeFileDraft()} fallback={<div class="empty-note">{fileEditError() || (fileEditLoading() ? "Loading file…" : "No editable file loaded")}</div>}>{draft => <><div class="file-edit-toolbar"><span>{draft().stageOnSave ? "Saving stages the whole file" : "Edits remain unstaged until you stage them"}</span><button disabled={fileEditSaving()} onClick={discardEditedFile}>Cancel</button><button class="file-edit-save" disabled={fileEditSaving() || draft().text === draft().original} onClick={() => void saveEditedFile()}>{fileEditSaving() ? "Saving…" : "Save · Ctrl+S"}</button></div><Show when={fileEditError()}>{message => <div class="file-edit-error">{message()}</div>}</Show><textarea class="file-edit-textarea" aria-label={`Edit ${draft().path}`} spellcheck={false} disabled={fileEditSaving()} value={draft().text} onInput={event => setFileDraft(current => current ? { ...current, text: event.currentTarget.value } : current)} onKeyDown={event => { if (event.key === "Tab") { event.preventDefault(); const input = event.currentTarget; const start = input.selectionStart; const end = input.selectionEnd; input.setRangeText("  ", start, end, "end"); setFileDraft(current => current ? { ...current, text: input.value } : current); } }} /></>}</Show></div></Show>
              <Show when={fileView() === "history"}><div class="file-inspection"><div class="file-inspection-heading">File history · {inspectRevision().slice(0, 8)}</div><Show when={fileInfoError()}>{message => <div class="empty-note">{message()}</div>}</Show><Show when={fileHistory()} fallback={<div class="empty-note">{fileInfoLoading() ? "Loading file history…" : "No file history loaded"}</div>}>{history => <><For each={history().commits}>{entry => <button class="file-history-row" title={`${entry.path} · ${entry.hash}`} onClick={() => void openHistoryCommit(entry)}><span class="file-history-subject">{entry.subject}</span><span class="file-history-meta">{entry.author} · {new Date(entry.timestamp * 1000).toLocaleDateString()} · {entry.hash.slice(0, 8)}</span></button>}</For><Show when={!history().commits.length && !fileInfoLoading()}><div class="empty-note">No committed history for this file.</div></Show><Show when={history().hasMore}><button class="load-more" disabled={fileInfoLoading()} onClick={() => void loadFileHistory(history().commits.length)}>{fileInfoLoading() ? "Loading…" : "Load more history"}</button></Show></>}</Show></div></Show>
              <Show when={fileView() === "blame"}><div class="file-inspection"><div class="file-inspection-heading">Blame · {inspectRevision().slice(0, 8)} · select an attribution to open its commit</div><Show when={fileInfoError()}>{message => <div class="empty-note">{message()}</div>}</Show><Show when={fileBlame()} fallback={<div class="empty-note">{fileInfoLoading() ? "Loading blame…" : "No blame loaded"}</div>}>{result => <><div class="blame-lines"><For each={result().lines}>{line => <div class="blame-row"><span class="blame-number">{line.line}</span><button class="blame-attribution" title={`${line.summary} · ${line.author} · ${new Date(line.timestamp * 1000).toLocaleString()}`} onClick={() => void selectCommit(line.hash)}><span>{line.author}</span><code>{line.hash.slice(0, 8)}</code></button><code class="blame-content">{line.content || " "}</code></div>}</For></div><Show when={!result().lines.length && !fileInfoLoading()}><div class="empty-note">No committed lines to blame.</div></Show><Show when={result().hasMore}><button class="load-more" disabled={fileInfoLoading()} onClick={() => void loadFileBlame(result().lines[result().lines.length - 1].line + 1)}>{fileInfoLoading() ? "Loading…" : "Load more lines"}</button></Show></>}</Show></div></Show>
            </Show>
          </div>
        </section>
      </Show>
    </Show>
        <Show when={sideEditor()}>{target => <FileEditor target={target()} active={repoReady() && target().repo === activePath()} conflicted={target().repo === activePath() && !target().commit && conflicts().some(item => item.path === target().path)} onMarkResolved={remaining => void runAction({ kind: "stage_file", value: { path: target().path } }, remaining ? `${target().path} still has ${remaining} conflict${remaining === 1 ? "" : "s"}. Mark it resolved anyway?` : undefined)} revision={target().repo === activePath() ? repo()?.status.find(item => item.path === target().path)?.worktreeRevision : undefined} width={sideEditorWidth()} load={readSideEditorFile} save={saveSideEditorFile} onDirty={setSideEditorDirty} onClose={closeSideEditor} onResize={event => startResize("editor", event)} />}</Show>
    </main>
    <footer class="statusbar"><span><span class="connection-dot" /> {repo()?.path ?? "Ready"}</span><span class="statusbar-right"><Show when={notice() && !actionBusy()} fallback={<>{actionBusy() ? "RUNNING GIT COMMAND" : repo()?.loading || busy() || searchBusy() ? "LOADING REPOSITORY" : repo()?.loadError ? "REPOSITORY UNAVAILABLE" : "READY"}</>}><span class="notice-bar" title={notice()}>{notice().split("\n").find(line => line.trim()) ?? notice()}</span></Show> <i /> GITFERRY {version}</span></footer>
    <Show when={actionDialog()}>{current => <div class="modal-backdrop" onClick={() => setActionDialog(null)}><div class="action-dialog" role="dialog" aria-modal="true" aria-label={current().title} onClick={event => event.stopPropagation()}>
      <div class="modal-title"><span>{current().title}</span><button aria-label="Close action dialog" onClick={() => setActionDialog(null)}><Icon name="close" /></button></div>
      <form onSubmit={event => { event.preventDefault(); submitActionDialog(); }}>
        <div class="action-dialog-body"><Show when={current().description}><p>{current().description}</p></Show><For each={current().fields}>{(field, index) => <label>{field.label}{field.options
          ? <select autofocus={index() === 0} value={actionDialogValues()[field.key]} onChange={event => setActionDialogValues(values => ({ ...values, [field.key]: event.currentTarget.value }))}><For each={field.options}>{option => <option value={option}>{option}</option>}</For></select>
          : <input autofocus={index() === 0} value={actionDialogValues()[field.key] ?? ""} placeholder={field.placeholder} onInput={event => setActionDialogValues(values => ({ ...values, [field.key]: event.currentTarget.value }))} />}</label>}</For></div>
        <div class="action-dialog-footer"><button type="button" autofocus={!current().fields.length} onClick={() => setActionDialog(null)}>Cancel</button><button class={`action-dialog-submit ${current().danger ? "danger" : ""}`} type="submit" disabled={current().fields.some(field => field.required !== false && !actionDialogValues()[field.key]?.trim())}>{current().submitLabel}</button></div>
      </form>
    </div></div>}</Show>
    <Show when={rebasePlan()}>{plan => <div class="modal-backdrop" onClick={() => setRebasePlan(null)}><div class="rebase-modal" role="dialog" aria-label="Interactive rebase plan" onClick={event => event.stopPropagation()}>
      <div class="modal-title"><span>Interactive rebase</span><button aria-label="Close rebase plan" onClick={() => setRebasePlan(null)}><Icon name="close" /></button></div>
      <div class="rebase-intro"><strong>{plan().branch}</strong> onto <strong>{plan().onto}</strong><p>Reorder commits and choose an action. Reword changes a message; Edit pauses so you can amend; Squash combines messages; Fixup discards the later message.</p></div>
      <div class="rebase-steps"><Index each={plan().steps}>{(item, index) => <div class={`rebase-step ${item().action === "drop" ? "dropped" : ""}`}>
        <div class="rebase-step-main"><div class="rebase-move"><button aria-label={`Move ${item().subject} earlier`} title="Move earlier" disabled={index === 0} onClick={() => moveRebaseStep(index, -1)}><Icon name="up" /></button><button aria-label={`Move ${item().subject} later`} title="Move later" disabled={index === plan().steps.length - 1} onClick={() => moveRebaseStep(index, 1)}><Icon name="arrowDown" /></button></div>
          <div class="rebase-commit"><span title={item().subject}>{item().subject}</span><code>{item().hash.slice(0, 8)}</code></div>
          <select aria-label={`Action for ${item().subject}`} value={item().action} onChange={event => setRebaseAction(item().hash, event.currentTarget.value as RebaseStep["action"])}><option value="pick">Pick</option><option value="reword">Reword</option><option value="edit">Edit</option><option value="squash">Squash</option><option value="fixup">Fixup</option><option value="drop">Drop</option></select></div>
        <Show when={item().action === "reword"}><label class="rebase-message-label">New commit message<textarea aria-label={`New message for ${item().subject}`} value={item().editedMessage ?? item().message} onInput={event => setRebaseMessage(item().hash, event.currentTarget.value)} /></label></Show>
      </div>}</Index></div>
      <Show when={rebasePlanError(plan().steps)}>{problem => <div class="rebase-validation">{problem()}</div>}</Show>
      <div class="rebase-footer"><span>{plan().steps.length} commits · {plan().steps.filter(item => item.action === "drop").length} dropped</span><button onClick={() => setRebasePlan(null)}>Cancel</button><button class="rebase-start" disabled={actionBusy() || Boolean(rebasePlanError(plan().steps))} onClick={startPlannedRebase}>Start rebase</button></div>
    </div></div>}</Show>
    <Show when={paletteOpen()}><div class="modal-backdrop palette-backdrop" onClick={() => setPaletteOpen(false)}><div class="palette" onClick={event => event.stopPropagation()} onKeyDown={paletteKey}><input autofocus value={paletteInput()} onInput={event => setPaletteInput(event.currentTarget.value)} placeholder="Type a command…" /><div class="palette-list"><For each={paletteCommands()}>{command => <button onClick={() => { setPaletteOpen(false); command.run(); }}>{command.label}</button>}</For></div></div></div></Show>
    <Show when={fileFinderOpen()}><div class="modal-backdrop" onClick={closeFileFinder}><div class="file-finder-modal" role="dialog" aria-label="Browse tracked files" onClick={event => event.stopPropagation()}><div class="modal-title"><span>Browse tracked files</span><button aria-label="Close file browser" onClick={closeFileFinder}><Icon name="close" /></button></div><input autofocus aria-label="Find tracked file" value={fileFinderQuery()} onInput={event => searchTrackedFiles(event.currentTarget.value)} onKeyDown={event => { if (event.key === "Enter" && fileFinderResults()[0]) inspectTrackedFile(fileFinderResults()[0]); else if (event.key === "ArrowDown") { event.preventDefault(); document.querySelector<HTMLButtonElement>(".file-finder-list button")?.focus(); } }} placeholder="Search file paths" /><div class="file-finder-list"><For each={fileFinderResults()}>{file => <button title={file} onClick={() => inspectTrackedFile(file)}>{file}</button>}</For><Show when={!fileFinderResults().length}><div class="empty-note">{fileFinderError() || (fileFinderBusy() ? "Searching files…" : "No matching tracked files")}</div></Show></div></div></div></Show>
    <Show when={showSettings()}><div class="modal-backdrop" onClick={() => setShowSettings(false)}><div class="settings-modal" role="dialog" aria-label="Settings" onClick={event => event.stopPropagation()}>
      <div class="modal-title"><span>Settings</span><button aria-label="Close settings" onClick={() => setShowSettings(false)}><Icon name="close" /></button></div>
      <div class="settings-body"><label>THEME<select aria-label="Color theme" value={theme()} onChange={event => setTheme(event.currentTarget.value as ThemeId)}><For each={themeOptions}>{option => <option value={option.id}>{option.label}</option>}</For></select></label>
        <label class="settings-check"><input type="checkbox" checked={showTabBranch()} onChange={event => setShowTabBranch(event.currentTarget.checked)} /> Show branch name in repository tabs</label>
        <label class="settings-check" title="Files ending in .test.* / .spec.*, *_test.*, test_*, or inside test, tests, spec or __tests__ folders"><input type="checkbox" checked={keepTestsClosed()} onChange={event => setKeepTestsClosed(event.currentTarget.checked)} /> Keep test files collapsed when expanding all</label>
        <label class="settings-check"><input type="checkbox" checked={ignoreWhitespace()} onChange={event => changeIgnoreWhitespace(event.currentTarget.checked)} /> Ignore whitespace-only changes in diffs</label>
        <Show when={isTauri()}><div class="mcp-settings">
          <label class="settings-check"><input aria-label="Enable GitFerry MCP" type="checkbox" checked={Boolean(mcpConnection())} disabled={mcpBusy()} onChange={event => void setMcpEnabled(event.currentTarget.checked)} /> Enable MCP for AI navigation</label>
          <label>MCP PORT<input aria-label="MCP port" type="number" min="1" max="65535" value={mcpPort()} disabled={mcpBusy() || Boolean(mcpConnection())} onInput={event => setMcpPort(Number(event.currentTarget.value))} /></label>
          <p>AI clients can read open repositories and navigate this window. SSH sign-in prompts stay in GitFerry.</p>
          <Show when={mcpConnection()}>{connection => <>
            <label>ENDPOINT<input aria-label="MCP endpoint" readonly value={connection().url} /></label>
            <label>BEARER TOKEN<input aria-label="MCP bearer token" readonly type="password" value={connection().token} /></label>
            <button onClick={() => void navigator.clipboard.writeText(mcpConfiguration(connection())).then(() => setNotice("MCP configuration copied"), cause => setMcpError(String(cause)))}>Copy MCP configuration</button>
          </>}</Show>
          <Show when={mcpError()}><p class="modal-error">{mcpError()}</p></Show>
        </div></Show>
        <label>INTERFACE FONT<input aria-label="Interface font" list="ui-font-options" value={uiFont()} onInput={event => setUiFont(event.currentTarget.value)} placeholder="Segoe UI" /></label>
        <div class="settings-row"><label>CODE FONT<input aria-label="Code font" list="code-font-options" value={codeFont()} onInput={event => setCodeFont(event.currentTarget.value)} placeholder="Consolas" /></label><label>SIZE<input aria-label="Code font size" type="number" min="9" max="24" value={codeSize()} onInput={event => { const size = Number(event.currentTarget.value); if (size >= 9 && size <= 24) setCodeSize(size); }} /></label></div>
        <datalist id="ui-font-options"><option value="Segoe UI" /><option value="Inter" /><option value="Arial" /><option value="Calibri" /><option value="Verdana" /></datalist>
        <datalist id="code-font-options"><option value="Consolas" /><option value="Cascadia Code" /><option value="Cascadia Mono" /><option value="JetBrains Mono" /><option value="Fira Code" /><option value="Courier New" /></datalist>
        <label>EDITOR<select aria-label="External editor" value={editor()} onChange={event => setEditor(event.currentTarget.value as EditorId)}><For each={editorOptions}>{option => <option value={option.id}>{option.label}</option>}</For></select></label>
        <label>COMMAND OVERRIDE<input aria-label="Editor command override" value={editorExecutable()} onInput={event => setEditorExecutable(event.currentTarget.value)} placeholder={editor() === "antigravity" ? "antigravity" : editor() === "vscode" ? "code" : "subl"} /></label>
        <p>Leave the command blank to use the editor CLI from PATH. Enter a full executable path if needed. Open in editor jumps to the first changed line. For SSH repositories, Antigravity and VS Code require Remote SSH access to the same host.</p>
        <Show when={savedSsh().length}><div class="settings-ssh"><span class="settings-ssh-heading">SAVED SSH PASSWORDS</span><For each={savedSsh()}>{key => <div class="settings-ssh-row"><span title={key}>{key.startsWith("passphrase:") ? `Key ${key.slice("passphrase:".length)}` : key.slice(key.indexOf(":") + 1)}</span><button onClick={() => forgetSsh(key)}>Forget</button></div>}</For></div></Show>
      </div><div class="settings-footer"><button onClick={() => setShowSettings(false)}>Done</button></div>
    </div></div></Show>
    <Show when={showOpen()}><div class="modal-backdrop" onClick={() => setShowOpen(false)}><div class="open-modal" onClick={event => event.stopPropagation()}>
      <div class="modal-title"><span>Open repository</span><button onClick={() => setShowOpen(false)}><Icon name="close" /></button></div>
      <div class="open-kind"><button class={openKind() === "local" ? "active" : ""} onClick={() => setOpenKind("local")}>Local</button><button class={openKind() === "remote" ? "active" : ""} onClick={() => setOpenKind("remote")}>SSH host</button></div>
      <Show when={error()}><div class="modal-error">{error()}</div></Show>
      <Show when={openKind() === "local"} fallback={<div class="modal-body"><div class="eyebrow">REMOTE REPOSITORY</div><p>Connect through your system SSH configuration. Your keys are tried first; GitFerry asks for a password if the host needs one.</p>
        <form class="remote-form" onSubmit={event => { event.preventDefault(); void openRepo(`ssh://${hostInput()}${remotePathInput()}`); }}>
          <label>HOST<input value={hostInput()} onInput={event => setHostInput(event.currentTarget.value)} placeholder="root@warmer" /></label>
          <label>ABSOLUTE PATH<input value={remotePathInput()} onInput={event => setRemotePathInput(event.currentTarget.value)} placeholder="/srv/my-repo" /></label>
          <button type="submit" disabled={busy() || !hostInput().trim() || !remotePathInput().startsWith("/")}>{busy() ? "Connecting…" : "Connect"}</button>
        </form></div>}>
      <div class="modal-body"><div class="eyebrow">LOCAL REPOSITORY</div><p>Choose a Git working tree on this computer.</p><button class="folder-button" onClick={() => void chooseFolder()}>Browse folders</button><div class="modal-divider">or enter a path</div><form onSubmit={event => { event.preventDefault(); void openRepo(pathInput()); }}><input autofocus value={pathInput()} onInput={event => setPathInput(event.currentTarget.value)} placeholder="C:\\path\\to\\repository" /><button type="submit" disabled={busy()}>Open</button></form></div>
      </Show>
    </div></div></Show>
    <Show when={sshPrompt()}>{prompt => {
      const secret = () => prompt().kind === "password" || prompt().kind === "passphrase";
      return <div class="modal-backdrop"><div class="action-dialog ssh-prompt" role="dialog" aria-modal="true" aria-label="SSH sign-in">
        <div class="modal-title"><span>{prompt().kind === "confirm" ? "Unknown SSH host" : prompt().kind === "passphrase" ? "SSH key passphrase" : "SSH sign-in"}</span><button aria-label="Cancel SSH sign-in" onClick={() => answerSshPrompt(null)}><Icon name="close" /></button></div>
        <form onSubmit={event => { event.preventDefault(); answerSshPrompt(prompt().kind === "confirm" ? "yes" : sshAnswer()); }}>
          <div class="action-dialog-body">
            <Show when={prompt().error}><div class="ssh-prompt-error">{prompt().error}</div></Show>
            <p class="ssh-prompt-text">{prompt().kind === "password" ? `Your SSH keys were not accepted. Enter the password for ${prompt().target}.` : prompt().kind === "passphrase" ? `Enter the passphrase for ${prompt().target}.` : prompt().text}</p>
            <Show when={prompt().kind !== "confirm"}><label>{prompt().kind === "password" ? "Password" : prompt().kind === "passphrase" ? "Passphrase" : "Answer"}<span class="ssh-prompt-field"><input type={sshReveal() ? "text" : "password"} autofocus autocomplete="off" spellcheck={false} value={sshAnswer()} onInput={event => setSshAnswer(event.currentTarget.value)} /><button type="button" aria-label={sshReveal() ? "Hide typed text" : "Show typed text"} title={sshReveal() ? "Hide" : "Show"} aria-pressed={sshReveal()} onClick={() => setSshReveal(!sshReveal())}><Icon name={sshReveal() ? "eyeOff" : "eye"} /></button></span></label></Show>
            <Show when={secret()}><label class="ssh-prompt-remember" title="Saved in the system keychain; remove it in Settings"><input type="checkbox" checked={sshRemember()} onChange={event => setSshRemember(event.currentTarget.checked)} /> Remember {prompt().kind}</label></Show>
          </div>
          <div class="action-dialog-footer"><button type="button" autofocus={prompt().kind === "confirm"} onClick={() => answerSshPrompt(null)}>Cancel</button><button class="action-dialog-submit" type="submit" disabled={prompt().kind !== "confirm" && !sshAnswer()}>{prompt().kind === "confirm" ? "Trust and connect" : "Connect"}</button></div>
        </form>
      </div></div>;
    }}</Show>
  </div>;
}
export default App;
