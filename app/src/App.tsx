import { batch, createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { highlightDiff } from "./diffHighlight";
import "./App.css";

type Status = { path: string; index: string; worktree: string };
type Ref = { name: string; kind: string; target: string; isHead: boolean; ahead?: number; behind?: number };
type Commit = { hash: string; parents: string[]; subject: string; author: string; timestamp: number; decorations: string[] };
type Repo = { path: string; name: string; branch: string; head: string | null; status: Status[]; refs: Ref[]; commits: Commit[]; hasMore: boolean; operation?: string | null; loading?: boolean; loadError?: string };
type RepoState = { branch: string; head: string | null; status: Status[]; operation?: string | null };
type SearchResult = { commits: Commit[]; hasMore: boolean };
type Details = { hash: string; subject: string; body: string; author: string; authorEmail: string; timestamp: number; parents: string[]; files: { path: string; status: string }[] };
type Choice = { path: string; status: string; target: string };
type Diff = { text: string; truncated: boolean };
type RebaseCommit = { hash: string; subject: string };
type RebaseStep = RebaseCommit & { action: "pick" | "fixup" | "drop" };
type RefNode = { label: string; path: string; ref?: Ref; children: RefNode[]; count: number; containsHead: boolean };
type Operation = { kind: "stage_all" | "fetch" | "pull" | "pull_merge" | "pull_rebase" | "push" | "force_push_with_lease" | "abort_operation" | "continue_operation" } | { kind: "stage_file" | "unstage_file" | "discard_file"; value: { path: string } } | { kind: "stage_hunk"; value: { path: string; index: number; reverse: boolean } } | { kind: "discard_hunk"; value: { path: string; index: number; diff: string } } | { kind: "stage_lines" | "unstage_lines" | "discard_lines"; value: { path: string; lines: number[]; diff: string } } | { kind: "commit"; value: { message: string; amend: boolean } } | { kind: "checkout" | "create_branch" | "delete_branch" | "merge" | "rebase"; value: { branch: string } } | { kind: "interactive_rebase"; value: { branch: string; onto: string; steps: { hash: string; action: RebaseStep["action"] }[] } } | { kind: "stash"; value: { message: string } } | { kind: "apply_stash" | "pop_stash" | "cherry_pick" | "revert" | "detach"; value: { hash: string } } | { kind: "reset"; value: { hash: string; mode: "soft" | "mixed" | "hard" } } | { kind: "create_tag"; value: { name: string; hash: string } } | { kind: "delete_tag"; value: { name: string } } | { kind: "resolve_file"; value: { path: string; side: "ours" | "theirs" } };
const recentKey = "gitferry.recent";
const tabsKey = "gitferry.openTabs";
const activeKey = "gitferry.activeTab";
const themeKey = "gitferry.theme";
const editorKey = "gitferry.editor";
const editorExecutableKey = "gitferry.editorExecutable";
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
function savedSession(): { tabs: Repo[]; activePath: string | null } {
  if (!isTauri() || demoMode) return { tabs: [], activePath: null };
  try {
    const stored = JSON.parse(localStorage.getItem(tabsKey) ?? "[]");
    if (!Array.isArray(stored)) return { tabs: [], activePath: null };
    const paths = [...new Set(stored.filter((path): path is string => typeof path === "string" && Boolean(path.trim())))];
    const tabs = paths.map(path => ({
      path, name: path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path,
      branch: "Loading…", head: null, status: [], refs: [], commits: [], hasMore: false, loading: true,
    }));
    const selected = localStorage.getItem(activeKey);
    return { tabs, activePath: selected && paths.includes(selected) ? selected : paths[0] ?? null };
  } catch { return { tabs: [], activePath: null }; }
}
const date = (value: number) => new Date(value * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const commitRowHeight = 76;
const workingRowHeight = 68;
type GraphStep = { lane: number; before: number[]; parents: number[] };
const graphColors: Record<ThemeId, string[]> = {
  antigravity: ["#4d9bd8", "#b89bd7", "#d4ae73", "#83bd95", "#8aafd8"],
  vscode: ["#4fc1ff", "#c586c0", "#d7ba7d", "#89c996", "#9bb7ed"],
  sublime: ["#e8a866", "#b6a0d2", "#74b9c0", "#97c58f", "#d5b87c"],
  claude: ["#df8065", "#c5a5d3", "#d3b579", "#92b9a3", "#a3b4ce"],
};
const graphOutlines: Record<ThemeId, string> = { antigravity: "#242424", vscode: "#252526", sublime: "#293039", claude: "#242424" };

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

function RefTree(props: { nodes: RefNode[]; kind: string; depth: number; overrides: Record<string, boolean>; onToggle: (key: string, open: boolean) => void; onSelect: (hash: string) => void }) {
  return <For each={props.nodes}>{node => <Show when={!node.ref} fallback={<button class={`ref-item ${node.ref?.isHead ? "current" : ""}`} style={{ "padding-left": `${(props.kind === "branch" ? 34 : 25) + props.depth * 14}px` }} title={node.path} disabled={props.kind === "submodule"} onClick={() => props.onSelect(node.ref!.target)}>
    <Show when={props.kind !== "branch"}><span class="ref-icon">{props.kind === "remote" ? "☁" : props.kind === "stash" ? "◷" : props.kind === "submodule" ? "▣" : "◇"}</span></Show><span class="ref-name">{node.label}</span><Show when={node.ref?.ahead || node.ref?.behind}><span class="ref-tracking">{node.ref?.ahead ? `↑${node.ref.ahead}` : ""} {node.ref?.behind ? `↓${node.ref.behind}` : ""}</span></Show><Show when={node.ref?.isHead}><span class="ref-head">HEAD</span></Show>
  </button>}>
    {(() => {
      const key = `${props.kind}:${node.path}`;
      const open = () => props.overrides[key] ?? node.containsHead;
      return <><button class="ref-folder" style={{ "padding-left": `${14 + props.depth * 14}px` }} aria-expanded={open()} onClick={() => props.onToggle(key, !open())}><span class="ref-disclosure">{open() ? "⌄" : "›"}</span><span class="ref-folder-name">{node.label}</span><span class="ref-folder-count">{node.count}</span></button><Show when={open()}><RefTree nodes={node.children} kind={props.kind} depth={props.depth + 1} overrides={props.overrides} onToggle={props.onToggle} onSelect={props.onSelect} /></Show></>;
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
  for (const row of container.querySelectorAll<HTMLElement>(".diff-line")) {
    const text = row.querySelector<HTMLElement>(".line-text");
    if (!text || getComputedStyle(text).visibility === "hidden" || !selectedRange.intersectsNode(text)) continue;
    const lineRange = document.createRange();
    lineRange.selectNodeContents(text);
    const part = selectedRange.cloneRange();
    if (part.compareBoundaryPoints(Range.START_TO_START, lineRange) < 0) part.setStart(lineRange.startContainer, lineRange.startOffset);
    if (part.compareBoundaryPoints(Range.END_TO_END, lineRange) > 0) part.setEnd(lineRange.endContainer, lineRange.endOffset);
    const value = part.toString();
    if (value || (lineRange.collapsed && row.dataset.copyPrefix)) copied.push(`${part.compareBoundaryPoints(Range.START_TO_START, lineRange) === 0 ? row.dataset.copyPrefix ?? "" : ""}${value}`);
  }
  if (!copied.length) return;
  event.clipboardData.setData("text/plain", copied.join("\n"));
  event.preventDefault();
}

function DiffText(props: { value: Diff; item: Choice; working: boolean; ignoreWhitespace: boolean; actionBusy: boolean; onAction: (operation: Operation, confirmation?: string) => void }) {
  const lines = createMemo(() => parseDiffLines(props.value));
  const highlighted = createMemo(() => highlightDiff(lines(), props.item.path, props.value.text.length));
  const hunkCount = createMemo(() => lines().filter(line => line.kind === "hunk").length);
  const [selectedLines, setSelectedLines] = createSignal<number[]>([]);
  const [selectedHunk, setSelectedHunk] = createSignal(0);
  const selectedSet = createMemo(() => new Set(selectedLines()));
  const fileOnlyChange = createMemo(() => /(^|\n)(new file mode|deleted file mode|rename from|rename to|copy from|copy to|old mode|new mode)/.test(props.value.text));
  const lineStageNote = createMemo(() => props.value.truncated ? "Diff too large for line actions; use the file action." : props.value.text.includes("\\ No newline at end of file") ? "Use the hunk action when a file has no final newline." : fileOnlyChange() ? "Use the file action for rename or mode changes." : "");
  const actionable = createMemo(() => props.working && props.item.status !== "U" && !props.ignoreWhitespace && (props.item.target === "working" || props.item.target === "staged"));
  const lineActionable = createMemo(() => actionable() && !lineStageNote());
  const changed = (index: number) => {
    const kind = lines()[index]?.kind;
    return lineActionable() && (kind === "added" || kind === "deleted");
  };
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
      props.onAction({ kind, value: { path, lines: [...selectedLines()].sort((a, b) => a - b), diff: props.value.text } }, discard ? `Discard ${selectedLines().length} selected line${selectedLines().length === 1 ? "" : "s"} in ${path}?` : undefined);
    } else {
      const index = selectedHunk();
      const operation: Operation = discard ? { kind: "discard_hunk", value: { path, index, diff: props.value.text } } : { kind: "stage_hunk", value: { path, index, reverse: props.item.target === "staged" } };
      props.onAction(operation, discard ? `Discard hunk ${index + 1} in ${path}?` : undefined);
    }
  }
  return <>
    <Show when={actionable() && hunkCount()}><div class="line-selection-toolbar" data-mode={selectedLines().length ? "lines" : "hunk"}><span>{lineStageNote() || (selectedLines().length ? `${selectedLines().length} line${selectedLines().length === 1 ? "" : "s"} selected` : `Hunk ${selectedHunk() + 1} of ${hunkCount()} · click a line number to select lines`)}</span><Show when={props.item.target === "working"}><button class="discard-selection" disabled={props.actionBusy || props.value.truncated || fileOnlyChange()} onClick={() => applySelection(true)}>{selectedLines().length ? "Discard Lines" : "Discard Hunk"}</button></Show><button class={selectedLines().length ? "stage-lines" : "hunk-action"} disabled={props.actionBusy || props.value.truncated || fileOnlyChange()} onClick={() => applySelection(false)}>{props.item.target === "staged" ? "Unstage" : "Stage"} {selectedLines().length ? "Lines" : "Hunk"}</button></div></Show>
    <div class={`diff-content ${actionable() ? "actionable" : ""} ${hunkCount() ? "has-hunks" : ""}`} onCopy={copyDiffSelection} onPointerUp={() => { dragStart = -1; }}><For each={lines()}>{({ line, hunkIndex, kind, oldNumber, newNumber }, index) => <div class={`diff-line ${kind} ${selectedSet().has(index()) ? "selected" : ""}`} data-copy-prefix={hunkIndex >= 0 && (kind === "added" || kind === "deleted" || line.startsWith(" ")) ? line.charAt(0) : ""} onClick={event => { if (actionable() && hunkIndex >= 0 && !(event.target as HTMLElement).closest("button")) selectHunk(hunkIndex); }}>
      <Show when={changed(index())} fallback={<span class="line-number"><span class="old-line">{oldNumber ?? ""}</span><span class="new-line">{newNumber ?? ""}</span></span>}><button class="line-number selectable" type="button" title="Select line for staging" aria-label={`Select ${kind === "added" ? "new" : "old"} line ${kind === "added" ? newNumber : oldNumber}`} aria-pressed={selectedSet().has(index())} onPointerDown={event => { if (event.button === 0) { dragStart = index(); dragged = false; } }} onPointerEnter={event => { if (dragStart >= 0 && index() !== dragStart && (event.buttons & 1)) { dragged = true; anchor = dragStart; setSelectedLines(selectRange(dragStart, index())); } }} onClick={event => selectLine(index(), event)}><span class="old-line">{oldNumber ?? ""}</span><span class="new-line">{newNumber ?? ""}</span></button></Show>
      <span class="line-text"><For each={highlighted()[index()]}>{part => <span class={`${part.types.map(type => `syntax-${type}`).join(" ")} ${part.changed ? "word-change" : ""}`}>{part.text}</span>}</For></span>
    </div>}</For></div><Show when={props.value.truncated}><div class="truncated-note">Diff preview limited to 512 KB.</div></Show>
  </>;
}

function demoDiff(item: Choice): Diff {
  return { text: `diff --git a/${item.path} b/${item.path}\nindex 2a6d9f1..a83f140 100644\n--- a/${item.path}\n+++ b/${item.path}\n@@ -12,6 +12,9 @@ function RepositoryView() {\n   const branch = repository.branch;\n-  const loading = false;\n+  const loading = repository.isLoading;\n+  const remote = repository.remoteHost;\n+  const preview = "This long sample line checks that changed code wraps inside the diff pane instead of disappearing beyond its right edge, even when the file contains a full sentence with many words and a long identifier like RepositoryPreviewConfigurationWithRemoteTrackingEnabled";\n   return renderHistory(branch);\n }\n`, truncated: false };
}

function DiffCard(props: { item: Choice; repoPath: string; working: boolean; expanded: boolean; keyboardSelected: boolean; ignoreWhitespace: boolean; actionBusy: boolean; scrollRoot: HTMLElement; onSelect: () => void; onToggle: () => void; onOpenTab: () => void; onOpenEditor: (diff: Diff | null) => void; onAction: (operation: Operation, confirmation?: string) => void; onError: (error: string) => void }) {
  let element!: HTMLDivElement;
  const [value, setValue] = createSignal<Diff | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [loadError, setLoadError] = createSignal("");
  let loadId = 0;
  createEffect(() => {
    void props.ignoreWhitespace; void props.repoPath; void props.item.target; void props.item.path;
    loadId++;
    setValue(null); setLoading(false); setLoadError("");
  });
  createEffect(() => {
    if (!props.expanded || value() || loading() || loadError()) return;
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      setLoading(true);
      const id = loadId;
      const result = demoMode ? Promise.resolve(demoDiff(props.item)) : invoke<Diff>("repo_diff", { path: props.repoPath, target: props.item.target, file: props.item.path, ignoreWhitespace: props.ignoreWhitespace });
      void result.then(diff => { if (id === loadId) setValue(diff); }).catch(cause => { if (id === loadId) { setLoadError(String(cause)); props.onError(String(cause)); } }).finally(() => { if (id === loadId) setLoading(false); });
    }, { root: props.scrollRoot, rootMargin: "400px" });
    observer.observe(element);
    onCleanup(() => observer.disconnect());
  });
  return <div class="all-diff-card summary-diff-card" ref={element}>
    <div class="summary-diff-heading"><button class={`file-row ${props.keyboardSelected ? "keyboard-selected" : ""}`} aria-expanded={props.expanded} aria-current={props.keyboardSelected ? "true" : undefined} onFocus={props.onSelect} onClick={props.onToggle}><span class={`file-status ${props.item.status === "A" || props.item.status === "U" ? "added" : props.item.status === "D" ? "deleted" : "modified"}`}>{props.item.status}</span><span class="file-path">{props.item.path}</span><Show when={props.item.target === "staged"}><span class="file-tag">STAGED</span></Show><span class="file-chevron">{props.expanded ? "⌄" : "›"}</span></button><button class="summary-open-tab" title={`Open ${props.item.path} in a tab`} aria-label={`Open ${props.item.path} in a tab`} onClick={props.onOpenTab}>↗</button><button class="open-editor-button" title={`Open ${props.item.path} in editor`} aria-label={`Open ${props.item.path} in editor`} onClick={() => props.onOpenEditor(value())}>Edit</button></div>
    <Show when={props.expanded}><Show when={props.working}><div class="file-actions"><Show when={props.item.target === "staged"} fallback={<button disabled={props.actionBusy} onClick={() => props.onAction({ kind: "stage_file", value: { path: props.item.path } })}>{props.item.status === "U" ? "Mark resolved" : "Stage file"}</button>}><button disabled={props.actionBusy} onClick={() => props.onAction({ kind: "unstage_file", value: { path: props.item.path } })}>Unstage file</button></Show><Show when={props.item.target === "working" && props.item.status !== "U"}><button class="danger" disabled={props.actionBusy} onClick={() => props.onAction({ kind: "discard_file", value: { path: props.item.path } }, `Discard changes to ${props.item.path}?`)}>Discard changes</button></Show></div></Show><Show when={props.item.status === "U"}><div class="diff-filter-note">Conflicted file. Edit the file or choose a side in the conflict panel, then mark it resolved.</div></Show><Show when={props.ignoreWhitespace && props.working && props.item.target !== "untracked"}><div class="diff-filter-note">Line and hunk actions are unavailable while whitespace is ignored.</div></Show><Show when={value()} fallback={<div class="empty-note">{loadError() || "Loading diff…"}</div>}>{current => <DiffText value={current()} item={props.item} working={props.working} ignoreWhitespace={props.ignoreWhitespace} actionBusy={props.actionBusy} onAction={(operation, confirmation) => props.onAction(operation, confirmation)} />}</Show></Show>
  </div>;
}

function GraphRow(props: { step: GraphStep; theme: ThemeId }) {
  let canvas!: HTMLCanvasElement;
  createEffect(() => {
    const step = props.step;
    const theme = props.theme;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, 74, commitRowHeight);
    const x = (lane: number) => 21 + lane * 12;
    const stroke = (lane: number, fromX: number, fromY: number, toX: number, toY: number) => {
      context.strokeStyle = graphColors[theme][lane % graphColors[theme].length];
      context.lineWidth = 2;
      context.beginPath(); context.moveTo(fromX, fromY); context.lineTo(toX, toY); context.stroke();
    };
    for (const lane of step.before) stroke(lane, x(lane), 0, x(lane), lane === step.lane ? 27 : commitRowHeight);
    for (const lane of step.parents) stroke(lane, x(step.lane), 27, x(lane), commitRowHeight);
    context.fillStyle = graphColors[theme][step.lane % graphColors[theme].length];
    context.beginPath(); context.arc(x(step.lane), 27, 4.5, 0, Math.PI * 2); context.fill();
    context.strokeStyle = graphOutlines[theme]; context.lineWidth = 2; context.stroke();
  });
  return <canvas class="graph-canvas" ref={canvas} width="74" height={commitRowHeight} aria-hidden="true" />;
}

function ChevronDown() {
  return <svg class="chevron-icon" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="m2.5 4.5 3.5 3 3.5-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>;
}

function App() {
  const restored = savedSession();
  const [theme, setTheme] = createSignal<ThemeId>(initialTheme);
  const [editor, setEditor] = createSignal<EditorId>(initialEditor);
  const [editorExecutable, setEditorExecutable] = createSignal(localStorage.getItem(editorExecutableKey) ?? "");
  const [showSettings, setShowSettings] = createSignal(false);
  const [tabs, setTabs] = createSignal<Repo[]>(restored.tabs);
  const [activePath, setActivePath] = createSignal<string | null>(restored.activePath);
  const [selected, setSelected] = createSignal("working");
  const [details, setDetails] = createSignal<Details | null>(null);
  const [choice, setChoice] = createSignal<Choice | null>(null);
  const [diff, setDiff] = createSignal<Diff | null>(null);
  const [ignoreWhitespace, setIgnoreWhitespace] = createSignal(false);
  const [allExpanded, setAllExpanded] = createSignal(true);
  const [summaryDiffs, setSummaryDiffs] = createSignal<Record<string, boolean>>({});
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
  const [rebasePlan, setRebasePlan] = createSignal<{ onto: string; branch: string; steps: RebaseStep[] } | null>(null);
  const [rebaseLoading, setRebaseLoading] = createSignal(false);
  const [pushMenu, setPushMenu] = createSignal(false);
  const [pullMenu, setPullMenu] = createSignal(false);
  const [stashMenu, setStashMenu] = createSignal(false);
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
  const [locationsOpen, setLocationsOpen] = createSignal(true);
  const [bottomLayout, setBottomLayout] = createSignal(localStorage.getItem("gitferry.bottomLayout") === "true");
  const [locationsWidth, setLocationsWidth] = createSignal(Number(localStorage.getItem("gitferry.locationsWidth")) || 205);
  const [commitsWidth, setCommitsWidth] = createSignal(Number(localStorage.getItem("gitferry.commitsWidth")) || 365);
  const [commitsHeight, setCommitsHeight] = createSignal(Number(localStorage.getItem("gitferry.commitsHeight")) || 320);
  const [recent, setRecent] = createSignal<string[]>([]);
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewportHeight, setViewportHeight] = createSignal(600);
  createEffect(() => {
    document.documentElement.dataset.theme = theme();
    localStorage.setItem(themeKey, theme());
  });
  createEffect(() => {
    localStorage.setItem(editorKey, editor());
    localStorage.setItem(editorExecutableKey, editorExecutable());
  });
  let request = 0;
  let stateBusy = false;
  let navigationArea: "commits" | "files" = "commits";
  let draggedTab: string | null = null;
  let commitScroll!: HTMLDivElement;
  let detailsScroll!: HTMLDivElement;
  const repo = createMemo(() => tabs().find(item => item.path === activePath()) ?? null);
  const repoReady = createMemo(() => Boolean(repo() && !repo()?.loading && !repo()?.loadError));
  const stashes = createMemo(() => repo()?.refs.filter(item => item.kind === "stash") ?? []);
  const conflicts = createMemo(() => repo()?.status.filter(item => item.index === "U" || item.worktree === "U" || ["AA", "DD"].includes(item.index + item.worktree)) ?? []);
  const displayedCommits = createMemo(() => searchQuery() ? searchResult().commits : repo()?.commits ?? []);
  const hasMore = createMemo(() => searchQuery() ? searchResult().hasMore : repo()?.hasMore ?? false);
  const workingFiles = createMemo<Choice[]>(() => (repo()?.status ?? []).flatMap(item => {
    if (item.index === "?" && item.worktree === "?") return [{ path: item.path, status: "U", target: "untracked" }];
    if (item.index === "U" || item.worktree === "U" || ["AA", "DD"].includes(item.index + item.worktree)) return [{ path: item.path, status: "U", target: "working" }];
    const files: Choice[] = [];
    if (item.worktree !== " " && item.worktree !== "?") files.push({ path: item.path, status: item.worktree, target: "working" });
    if (item.index !== " " && item.index !== "?") files.push({ path: item.path, status: item.index, target: "staged" });
    return files;
  }));
  const files = createMemo<Choice[]>(() => selected() === "working" ? workingFiles() : (details()?.files ?? []).map(item => ({ ...item, target: selected() })));
  const fileGroups = createMemo(() => selected() === "working"
    ? [
      { title: "STAGED", items: files().filter(item => item.target === "staged") },
      { title: "UNSTAGED", items: files().filter(item => item.target === "working") },
      { title: "UNTRACKED", items: files().filter(item => item.target === "untracked") },
    ].filter(group => group.items.length)
    : [{ title: "", items: files() }]);
  const navigationFiles = createMemo(() => fileGroups().flatMap(group => group.items));
  const diffKey = (item: Choice) => `${item.target}:${item.path}`;
  const summaryKey = (item: Choice) => `${activePath()}:${selected()}:${diffKey(item)}`;
  const isSummaryExpanded = (item: Choice) => summaryDiffs()[summaryKey(item)] ?? allExpanded();
  function toggleSummaryDiff(item: Choice) { setSummaryDiffs(previous => ({ ...previous, [summaryKey(item)]: !isSummaryExpanded(item) })); }
  const isSummaryGroupExpanded = (items: Choice[]) => items.every(isSummaryExpanded);
  function toggleSummaryGroup(items: Choice[]) {
    const open = !isSummaryGroupExpanded(items);
    setSummaryDiffs(previous => {
      const next = { ...previous };
      for (const item of items) next[summaryKey(item)] = open;
      return next;
    });
  }
  function setEveryDiff(open: boolean) { setAllExpanded(open); setSummaryDiffs({}); }
  const graph = createMemo<GraphStep[]>(() => {
    const pending: (string | null)[] = [];
    return displayedCommits().map(item => {
      let lane = pending.indexOf(item.hash);
      if (lane < 0) { lane = pending.indexOf(null); if (lane < 0) lane = pending.length; pending[lane] = item.hash; }
      const before = pending.flatMap((hash, index) => hash === null ? [] : [index]);
      pending[lane] = null;
      const parents = item.parents.map((hash, index) => {
        let target = pending.indexOf(hash);
        if (target < 0) {
          target = index === 0 ? lane : pending.indexOf(null);
          if (target < 0) target = pending.length;
          pending[target] = hash;
        }
        return target;
      });
      return { lane, before, parents };
    });
  });
  const visibleCommits = createMemo(() => {
    const commits = displayedCommits();
    const start = Math.max(0, Math.floor(Math.max(0, scrollTop() - (searchQuery() ? 0 : workingRowHeight)) / commitRowHeight) - 8);
    const end = Math.min(commits.length, start + Math.ceil(viewportHeight() / commitRowHeight) + 18);
    return commits.slice(start, end).map((item, offset) => ({ item, index: start + offset }));
  });
  const paletteCommands = createMemo(() => {
    const commands: { label: string; run: () => void }[] = [
      { label: "Open repository", run: () => setShowOpen(true) },
      { label: "Settings", run: () => setShowSettings(true) },
      { label: "Refresh repository", run: () => { void refresh(); } },
      { label: "Search commits", run: () => document.querySelector<HTMLInputElement>(".search-box input")?.focus() },
    ];
    if (repoReady()) {
      commands.push(
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
    const loop = async () => {
      while (!stopped) {
        try {
          const changed = await invoke<boolean>("repo_watch", { path, timeoutMs: 60_000 });
          if (stopped) return;
          if (changed && document.hasFocus()) await refresh();
        } catch {
          if (!stopped) setWatchFallback(true);
          return;
        }
      }
    };
    void loop();
    onCleanup(() => { stopped = true; });
  });

  function selectWorking() { navigationArea = "commits"; request++; setSelected("working"); setDetails(null); setChoice(null); setDiff(null); setKeyboardFileKey(null); if (detailsScroll) detailsScroll.scrollTop = 0; }
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
      setActivePath(result.path); setScrollTop(0); setSearchQuery(""); setSearchInput(""); if (commitScroll) commitScroll.scrollTop = 0;
      selectWorking(); setShowOpen(false); saveRecent(result.path); saveTabs();
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }
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
        return { ...update, commits: overlap >= 0 ? [...update.commits, ...item.commits.slice(overlap + 1)] : update.commits };
      }));
      setError("");
    } catch (cause) { setError(String(cause)); }
  }
  async function refreshState() {
    const path = activePath();
    if (!path || !repoReady() || !isTauri() || stateBusy) return;
    stateBusy = true;
    try {
      const update = await invoke<RepoState>("repo_state", { path });
      const current = tabs().find(item => item.path === path);
      if (!current) return;
      if (update.head !== current.head || update.branch !== current.branch || update.operation !== current.operation) {
        if (activePath() === path) await refresh();
      } else if (JSON.stringify(update.status) !== JSON.stringify(current.status)) {
        setTabs(items => items.map(item => item.path === path ? { ...item, status: update.status } : item));
        const selectedFile = choice();
        if (activePath() === path && selected() === "working" && selectedFile) void selectFile(selectedFile);
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
  async function selectCommit(hash: string) {
    const path = activePath();
    if (!path) return;
    navigationArea = "commits";
    setSelected(hash); setDetails(null); setChoice(null); setDiff(null); setKeyboardFileKey(null);
    if (detailsScroll) detailsScroll.scrollTop = 0;
    const id = ++request;
    if (demoMode) {
      const commit = repo()?.commits.find(item => item.hash === hash);
      if (commit) setDetails({ hash, subject: commit.subject, body: "A focused update to the repository experience.\n\nThe implementation keeps navigation responsive while the history grows.", author: commit.author, authorEmail: "sam@example.com", timestamp: commit.timestamp, parents: commit.parents, files: [{ path: "src/components/RepositoryView.tsx", status: "M" }, { path: "src/styles/diff.css", status: "M" }, { path: "docs/notes.md", status: "A" }] });
      return;
    }
    try {
      const result = await invoke<Details>("repo_commit", { path, hash });
      if (id === request) setDetails(result);
    } catch (cause) { if (id === request) setError(String(cause)); }
  }
  async function selectFile(item: Choice) {
    const path = activePath();
    if (!path) return;
    navigationArea = "files";
    setChoice(item); setDiff(null); setKeyboardFileKey(summaryKey(item));
    const id = ++request;
    if (demoMode) {
      setDiff(demoDiff(item));
      requestAnimationFrame(revealDiff);
      return;
    }
    try {
      const result = await invoke<Diff>("repo_diff", { path, target: item.target, file: item.path, ignoreWhitespace: ignoreWhitespace() });
      if (id === request) { setDiff(result); requestAnimationFrame(revealDiff); }
    } catch (cause) { if (id === request) setError(String(cause)); }
  }
  async function openInEditor(item: Choice, loadedDiff: Diff | null = null) {
    const path = activePath();
    if (!path) return;
    setError("");
    try {
      const value = loadedDiff ?? (demoMode ? demoDiff(item) : await invoke<Diff>("repo_diff", { path, target: item.target, file: item.path, ignoreWhitespace: false }));
      const line = item.target === "untracked" ? 1 : firstChangedLine(value);
      if (demoMode) { setNotice(`Open ${item.path}:${line} in ${editorOptions.find(option => option.id === editor())?.label}`); return; }
      await invoke("open_in_editor", { repo: path, file: item.path, line, editor: editor(), executable: editorExecutable() });
    } catch (cause) { setError(String(cause)); }
  }
  function toggleWhitespace() {
    setIgnoreWhitespace(value => !value);
    if (choice()) void selectFile(choice()!);
  }
  function revealDiff() {
    detailsScroll?.querySelector<HTMLElement>(".diff-heading")?.scrollIntoView({ block: "start", behavior: "auto" });
  }
  async function runAction(operation: Operation, confirmation?: string) {
    const path = activePath();
    if (!path || actionBusy() || (confirmation && !window.confirm(confirmation))) return;
    const scopedAction = ["stage_lines", "unstage_lines", "discard_lines", "stage_hunk", "discard_hunk"].includes(operation.kind);
    const previousFile = scopedAction ? choice() : null;
    const token = ["fetch", "pull", "pull_merge", "pull_rebase", "push", "force_push_with_lease"].includes(operation.kind) ? crypto.randomUUID() : null;
    setActionBusy(true); setError(""); setNotice(""); setProgress(""); setCancelToken(token); setCancelRequested(false);
    try {
      const output = await invoke<string>("repo_action", { path, operation, cancelToken: token });
      setNotice(output || "Done");
      if (["merge", "rebase", "interactive_rebase", "pull", "pull_merge", "pull_rebase", "cherry_pick", "revert", "reset", "detach", "continue_operation", "abort_operation"].includes(operation.kind)) selectWorking();
      if (!previousFile) setChoice(null);
      setDiff(null); setBranchMenu(false); setPushMenu(false); setPullMenu(false); setStashMenu(false);
      await refresh();
      if (previousFile) {
        const nextFile = workingFiles().find(item => item.path === previousFile.path && item.target === previousFile.target)
          ?? workingFiles().find(item => item.path === previousFile.path);
        if (nextFile) await selectFile(nextFile);
        else setChoice(null);
      }
      if (searchQuery()) await performSearch(searchQuery());
    } catch (cause) {
      setBranchMenu(false); setPullMenu(false); setPushMenu(false); setStashMenu(false);
      if (["merge", "rebase", "interactive_rebase", "pull_merge", "pull_rebase", "cherry_pick", "revert", "continue_operation"].includes(operation.kind)) selectWorking();
      await refresh();
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
  function startPlannedRebase() {
    const plan = rebasePlan();
    if (!plan) return;
    const firstKept = plan.steps.find(item => item.action !== "drop");
    if (firstKept?.action === "fixup") return;
    setRebasePlan(null);
    void runAction({ kind: "interactive_rebase", value: { branch: plan.branch, onto: plan.onto, steps: plan.steps.map(({ hash, action }) => ({ hash, action })) } });
  }
  async function commitChanges() {
    if (!commitMessage().trim()) return;
    await runAction({ kind: "commit", value: { message: commitMessage(), amend: amend() } });
    if (!error()) { setCommitMessage(""); setAmend(false); }
  }
  function revealCommit(index: number) {
    const top = index < 0 ? 0 : (searchQuery() ? 0 : workingRowHeight) + index * commitRowHeight;
    const bottom = top + (index < 0 ? workingRowHeight : commitRowHeight);
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
    const name = window.prompt("Tag name", "");
    if (name?.trim()) void runAction({ kind: "create_tag", value: { name: name.trim(), hash } });
  }
  function closeTab(path: string) {
    const next = tabs().filter(item => item.path !== path);
    setTabs(next);
    if (activePath() === path) { setActivePath(next.length ? next[next.length - 1].path : null); setScrollTop(0); selectWorking(); }
    saveTabs();
  }
  function reorderTab(target: string) {
    if (!draggedTab || draggedTab === target) return;
    const next = [...tabs()];
    const from = next.findIndex(item => item.path === draggedTab);
    if (from < 0 || !next.some(item => item.path === target)) return;
    const moved = next.splice(from, 1)[0];
    next.splice(next.findIndex(item => item.path === target), 0, moved);
    setTabs(next); saveTabs(); draggedTab = null;
  }
  function startResize(which: "locations" | "commits" | "history", event: PointerEvent) {
    event.preventDefault();
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
  onMount(() => {
    let unlistenDrop: (() => void) | undefined;
    let unlistenProgress: (() => void) | undefined;
    if (isTauri()) void listen<{ path: string; message: string }>("git-progress", event => {
      if (event.payload.path === activePath()) setProgress(event.payload.message);
    }).then(unlisten => { unlistenProgress = unlisten; }).catch(cause => setError(String(cause)));
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
        refs: [{ name: "feature/remote-git", kind: "branch", target: hashes[0], isHead: true }, { name: "main", kind: "branch", target: hashes[3], isHead: false }, { name: "origin/main", kind: "remote", target: hashes[3], isHead: false }, { name: "v0.9.0", kind: "tag", target: hashes[6], isHead: false }],
        commits: ["Refine repository overview layout", "Add persistent SSH transport", "Handle binary file previews", "Merge branch feature/graph", "Improve diff readability", "Create agent protocol", "Initialize project scaffold"].map((subject, index) => ({ hash: hashes[index], parents: index === 3 ? [hashes[4], hashes[5]] : index < 6 ? [hashes[index + 1]] : [], subject, author: index % 2 ? "Alex Morgan" : "Sam Rivera", timestamp: Date.now() / 1000 - index * 86400, decorations: index === 0 ? ["HEAD -> feature/remote-git"] : index === 3 ? ["origin/main"] : [] })),
        hasMore: false,
      };
      setTabs([sample]); setActivePath(sample.path);
    }
    try {
      const saved = JSON.parse(localStorage.getItem(recentKey) ?? "[]");
      if (Array.isArray(saved)) setRecent(saved.filter((item): item is string => typeof item === "string"));
    } catch { /* Ignore invalid old settings. */ }
    for (const item of restored.tabs) void restoreRepo(item.path);
    const interval = window.setInterval(() => { if (watchFallback() && document.hasFocus()) void refreshState(); }, 8000);
    const focus = () => void refresh();
    const keys = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setPaletteOpen(false); setShowOpen(false); setShowSettings(false); setRebasePlan(null); setBranchMenu(false); setPushMenu(false); setPullMenu(false); setStashMenu(false); return; }
      const target = event.target instanceof Element ? event.target : null;
      const modalOpen = paletteOpen() || showOpen() || showSettings() || Boolean(rebasePlan()) || branchMenu() || pushMenu() || pullMenu() || stashMenu();
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
    window.addEventListener("focus", focus); window.addEventListener("keydown", keys);
    const resize = () => { if (commitScroll) setViewportHeight(commitScroll.clientHeight); };
    window.addEventListener("resize", resize);
    onCleanup(() => { unlistenDrop?.(); unlistenProgress?.(); window.clearInterval(interval); window.removeEventListener("focus", focus); window.removeEventListener("keydown", keys); window.removeEventListener("resize", resize); });
  });

  return <div class="app-shell" onPointerDown={event => { if (event.target instanceof Element) { if (!event.target.closest(".push-control")) { setPushMenu(false); setPullMenu(false); } if (!event.target.closest(".stash-control")) setStashMenu(false); } }}>
    <Show when={draggingFolder()}><div class="drop-overlay"><div><strong>Open repository</strong><span>Drop a Git folder here</span></div></div></Show>
    <header class="tabbar">
      <div class="brand-mark">◇</div>
      <div class="tab-strip">
      <For each={tabs()}>{item => <div class={`repo-tab ${activePath() === item.path ? "active" : ""} ${item.loading ? "loading" : ""} ${item.loadError ? "unavailable" : ""}`} draggable onDragStart={() => { draggedTab = item.path; }} onDragOver={event => event.preventDefault()} onDrop={() => reorderTab(item.path)} onDragEnd={() => { draggedTab = null; }}>
        <button class="tab-main" onClick={() => { setActivePath(item.path); setNotice(""); setStashMenu(false); setScrollTop(0); setSearchQuery(""); setSearchInput(""); if (commitScroll) commitScroll.scrollTop = 0; selectWorking(); saveTabs(); }}>{item.name}<span>{item.branch}</span></button>
        <button class="tab-close" aria-label={`Close ${item.name}`} onClick={() => closeTab(item.path)}>×</button>
      </div>}</For>
      <button class="tab-add" title="Open repository" onClick={() => setShowOpen(true)}>＋</button>
      </div><div class="app-name">GITFERRY <span>LOCAL + SSH</span></div>
      <label class="theme-control"><span class="theme-caption">THEME</span><span class="theme-swatch" aria-hidden="true" /><select aria-label="Color theme" value={theme()} onChange={event => setTheme(event.currentTarget.value as ThemeId)}><For each={themeOptions}>{option => <option value={option.id}>{option.label}</option>}</For></select></label><button class="settings-button" title="Settings" aria-label="Settings" onClick={() => setShowSettings(true)}>⚙</button>
    </header>
    <div class="toolbar">
      <button class="toolbar-icon" title="Toggle locations" onClick={() => setLocationsOpen(!locationsOpen())}>☷</button>
      <button class="toolbar-icon layout-toggle" title={bottomLayout() ? "Show details beside history" : "Show details below history"} onClick={() => { const next = !bottomLayout(); setBottomLayout(next); localStorage.setItem("gitferry.bottomLayout", String(next)); requestAnimationFrame(() => { if (commitScroll) setViewportHeight(commitScroll.clientHeight); }); }}>{bottomLayout() ? "▤" : "◫"}</button>
      <Show when={repo()} fallback={<span class="toolbar-title">Open a repository to begin</span>}>
        <div class="branch-control"><button class="branch-chip" title={repo()?.branch} disabled={!repoReady()} onClick={() => setBranchMenu(!branchMenu())}><span class="branch-icon">⑂</span><span class="branch-name">{repo()?.branch}</span><span class="branch-arrow"><ChevronDown /></span></button>
          <Show when={branchMenu()}><div class="branch-menu"><div class="eyebrow">LOCAL BRANCHES</div><For each={repo()?.refs.filter(item => item.kind === "branch")}>{item => <div class="branch-menu-row"><button onClick={() => void runAction({ kind: "checkout", value: { branch: item.name } })}>{item.isHead ? "✓ " : ""}{item.name}</button><Show when={!item.isHead}><button title={`Merge ${item.name} into ${repo()?.branch}`} onClick={() => void runAction({ kind: "merge", value: { branch: item.name } }, `Merge ${item.name} into ${repo()?.branch}?`)}>Merge</button><button title={`Rebase ${repo()?.branch} onto ${item.name}`} onClick={() => void runAction({ kind: "rebase", value: { branch: item.name } }, `Rebase ${repo()?.branch} onto ${item.name}?`)}>Rebase</button><button title={`Plan an interactive rebase onto ${item.name}`} disabled={rebaseLoading()} onClick={() => void openRebasePlan(item.name)}>Plan…</button><button class="branch-delete" title={`Delete ${item.name}`} onClick={() => void runAction({ kind: "delete_branch", value: { branch: item.name } }, `Delete branch ${item.name}?`)}>×</button></Show></div>}</For>
            <form onSubmit={event => { event.preventDefault(); void runAction({ kind: "create_branch", value: { branch: newBranch() } }); setNewBranch(""); }}><input value={newBranch()} onInput={event => setNewBranch(event.currentTarget.value)} placeholder="New branch name" /><button type="submit">Create</button></form></div></Show>
        </div><div class="path-label" title={repo()?.path}>{repo()?.path}</div>
      </Show>
      <div class="toolbar-spacer" />
      <Show when={repoReady()}><form class="search-box" onSubmit={event => { event.preventDefault(); void performSearch(); }}><span>⌕</span><input value={searchInput()} onInput={event => { setSearchInput(event.currentTarget.value); if (!event.currentTarget.value) void performSearch(""); }} placeholder="Search commits" title="Search message, author:name, or path:file" /><Show when={searchQuery()}><button type="button" onClick={() => void performSearch("")}>×</button></Show></form></Show>
      <Show when={repoReady()}><button class="toolbar-button" title="Refresh" onClick={() => void refresh()}>↻ <span>Refresh</span></button><span class="toolbar-divider" /><button class="toolbar-button" title="Fetch" disabled={actionBusy()} onClick={() => void runAction({ kind: "fetch" })}>↓ <span>Fetch</span></button><div class="push-control"><button class="toolbar-button" title="Pull" disabled={actionBusy()} onClick={() => void runAction({ kind: "pull" })}>⇣ <span>Pull</span></button><button class="toolbar-button push-more" title="More pull options" aria-label="More pull options" aria-expanded={pullMenu()} disabled={actionBusy()} onClick={() => setPullMenu(!pullMenu())}><ChevronDown /></button><Show when={pullMenu()}><div class="push-menu"><button onClick={() => void runAction({ kind: "pull_merge" })}>Pull with merge</button><button onClick={() => void runAction({ kind: "pull_rebase" })}>Pull with rebase</button><p>Choose how to combine diverged branches.</p></div></Show></div><div class="push-control"><button class="toolbar-button" title="Push" disabled={actionBusy()} onClick={() => void runAction({ kind: "push" })}>⇡ <span>Push</span></button><button class="toolbar-button push-more" title="More push options" aria-label="More push options" aria-expanded={pushMenu()} disabled={actionBusy()} onClick={() => setPushMenu(!pushMenu())}><ChevronDown /></button><Show when={pushMenu()}><div class="push-menu"><button title="Force push with lease" disabled={actionBusy()} onClick={forcePushWithLease}>Force push with lease</button><p>Push only if the remote branch still matches your tracking branch.</p></div></Show></div><button class="toolbar-button" title="Stash" disabled={actionBusy()} onClick={() => { const message = window.prompt("Stash message", "Work in progress"); if (message !== null) void runAction({ kind: "stash", value: { message } }); }}>▣ <span>Stash</span></button><div class="stash-control"><button class="toolbar-button" title="Unstash" aria-expanded={stashMenu()} disabled={actionBusy()} onClick={() => setStashMenu(!stashMenu())}>↶ <span>Unstash</span><Show when={stashes().length}><small>{stashes().length}</small></Show></button><Show when={stashMenu()}><div class="stash-menu"><div class="eyebrow">SAVED STASHES</div><Show when={stashes().length} fallback={<div class="stash-empty">No saved stashes</div>}><For each={stashes()}>{item => <div class="stash-menu-row"><div class="stash-menu-label" title={item.name}>{item.name}</div><div class="stash-menu-actions"><button disabled={actionBusy()} title="Restore changes and keep this stash" onClick={() => void runAction({ kind: "apply_stash", value: { hash: item.target } })}>Apply</button><button disabled={actionBusy()} title="Restore changes and remove this stash" onClick={() => void runAction({ kind: "pop_stash", value: { hash: item.target } })}>Pop</button></div></div>}</For></Show></div></Show></div></Show>
      <button class="toolbar-button primary" title="Open repository" onClick={() => setShowOpen(true)}>＋ <span>Open repo</span></button>
    </div>
    <Show when={error()}><div class="error-bar">{error()}<button onClick={() => setError("")}>×</button></div></Show>
    <Show when={actionBusy() && (progress() || cancelToken())}><div class="progress-bar" role="status"><span>{progress() || "Starting Git operation…"}</span><Show when={cancelToken()}><button disabled={cancelRequested()} onClick={() => void cancelAction()}>{cancelRequested() ? "Cancelling…" : "Cancel"}</button></Show></div></Show>
    <Show when={notice()}><div class="notice-bar">{notice()}<button onClick={() => setNotice("")}>×</button></div></Show>
    <Show when={repo()} fallback={<main class="welcome">
      <div class="welcome-symbol">◇</div><div class="eyebrow">YOUR REPOSITORIES, ALL IN ONE PLACE</div>
      <h1>Git, wherever it lives.</h1><p>Open a local repository to browse its history, changes, and diffs.</p>
      <button class="welcome-open" onClick={() => setShowOpen(true)}>＋ &nbsp; Open repository</button>
      <Show when={recent().length}><div class="recent-list"><div class="eyebrow">RECENT</div><For each={recent()}>{path => <button onClick={() => void openRepo(path)}>⌁ &nbsp; {path}</button>}</For></div></Show>
    </main>}>
      <Show when={repoReady()} fallback={<main class="repo-startup" role="status"><div class="repo-startup-icon">◇</div><strong>{repo()?.loading ? `Opening ${repo()?.name}…` : `Could not open ${repo()?.name}`}</strong><span>{repo()?.loadError || "Your saved repositories are loading."}</span><Show when={repo()?.loadError}><button onClick={() => retryRestoredRepo(repo()!.path)}>Retry</button></Show></main>}>
      <main class={`workspace ${bottomLayout() ? "alt" : ""} ${locationsOpen() ? "" : "no-locations"}`} style={{ "--history-height": `${commitsHeight()}px` }}>
        <Show when={locationsOpen()}><aside class="locations" style={{ width: `${locationsWidth()}px` }}><div class="pane-heading">LOCATIONS</div><div class="locations-list">
          <For each={["branch", "remote", "tag", "stash", "submodule"]}>{kind => <section class="ref-section">
            <div class="section-heading">⌄ &nbsp; {kind === "branch" ? "BRANCHES" : kind === "remote" ? "REMOTES" : kind === "tag" ? "TAGS" : kind === "stash" ? "STASHES" : "SUBMODULES"} <span>{repo()?.refs.filter(item => item.kind === kind).length ?? 0}</span></div>
            <RefTree nodes={groupRefs(repo()?.refs.filter(item => item.kind === kind) ?? [], kind === "branch" || kind === "remote")} kind={kind} depth={0} overrides={folderOverrides()} onToggle={(key, open) => setFolderOverrides(previous => ({ ...previous, [key]: open }))} onSelect={hash => void selectCommit(hash)} />
          </section>}</For></div><div class="locations-footer"><span class="connection-dot" /> {repo()?.path.startsWith("ssh://") ? "SSH REPOSITORY" : "LOCAL REPOSITORY"}</div>
        </aside><div class="splitter locations-splitter" onPointerDown={event => startResize("locations", event)} /></Show>
        <section class="commits-pane" style={{ width: `${commitsWidth()}px` }} onPointerDown={() => { navigationArea = "commits"; }}><div class="pane-heading">{searchQuery() ? "SEARCH RESULTS" : "COMMITS"} <span class="heading-count">{displayedCommits().length}{hasMore() ? "+" : ""}</span></div>
          <div class="commit-scroll" ref={commitScroll} tabIndex={0} aria-label="Commit history" onScroll={event => {
            const element = event.currentTarget;
            setScrollTop(element.scrollTop);
            if (element.scrollHeight - element.scrollTop - element.clientHeight < 350) void loadMore();
          }}>
            <Show when={!searchQuery()}><button class={`working-row ${selected() === "working" ? "selected" : ""}`} onClick={selectWorking}><span class="working-node">●</span><span class="commit-main"><strong>Working Directory</strong><small>{repo()?.status.length ? `${repo()?.status.length} changed files` : "No changes"}</small></span><Show when={repo()?.status.length}><span class="count-badge">{repo()?.status.length}</span></Show></button></Show>
            <div class="virtual-commits" style={{ height: `${displayedCommits().length * commitRowHeight}px` }}>
              <For each={visibleCommits()}>{({ item, index }) => <button style={{ top: `${index * commitRowHeight}px`, height: `${commitRowHeight}px` }} class={`commit-row ${searchQuery() ? "search-result" : ""} ${selected() === item.hash ? "selected" : ""}`} onClick={() => void selectCommit(item.hash)}>
                <Show when={!searchQuery()}><GraphRow step={graph()[index]} theme={theme()} /></Show>
                <span class="commit-main"><span class="commit-subject">{item.subject}</span><span class="commit-meta">{item.author}<span>{date(item.timestamp)}</span></span>
                  <Show when={item.decorations.length}><span class="decorations"><For each={item.decorations}>{label => <span class={`decoration ${label.startsWith("HEAD") ? "head" : ""}`}>{label.replace(/^HEAD -> /, "")}</span>}</For></span></Show>
                </span>
              </button>}</For>
            </div>
            <Show when={hasMore()}><button class="load-more" disabled={busy() || searchBusy()} onClick={() => void loadMore()}>{busy() || searchBusy() ? "Loading…" : "Load more commits"}</button></Show>
            <Show when={!displayedCommits().length}><div class="empty-note">{searchBusy() ? "Searching…" : searchQuery() ? "No matching commits" : "No commits yet"}</div></Show>
          </div>
        </section><div class="splitter commits-splitter" onPointerDown={event => startResize(bottomLayout() ? "history" : "commits", event)} />
        <section class="details-pane" onPointerDown={() => { navigationArea = "files"; }}><div class="details-tabs"><button class={`details-tab ${!choice() ? "active" : ""}`} onClick={() => { setChoice(null); setDiff(null); detailsScroll.scrollTop = 0; }}>SUMMARY</button><Show when={choice()}><button class="details-tab active" title={choice()?.path}>{choice()?.path.split("/").pop()?.split("\\").pop()}</button></Show></div>
          <div class="details-scroll" ref={detailsScroll} tabIndex={0} aria-label="Changed files">
            <Show when={selected() !== "working" && !choice()}><Show when={details()} fallback={<div class="empty-note">Loading commit…</div>}>
              <div class="detail-header"><div class="eyebrow">COMMIT DETAILS <span class="hash">{details()!.hash.slice(0, 8)}</span></div><h2>{details()!.subject}</h2><Show when={details()!.body}><p class="commit-body">{details()!.body}</p></Show><div class="commit-byline"><span class="avatar">{details()!.author.charAt(0).toUpperCase()}</span><span>{details()!.author}<small>{details()!.authorEmail} · {new Date(details()!.timestamp * 1000).toLocaleString()}</small></span></div><Show when={details()!.parents.length}><div class="parent-hashes">PARENT{details()!.parents.length > 1 ? "S" : ""} <For each={details()!.parents}>{parent => <span>{parent.slice(0, 8)}</span>}</For></div></Show></div>
            </Show></Show>
            <Show when={selected() !== "working" && !choice() && details()}><details class="commit-actions"><summary>Commit actions</summary><div class="commit-action-buttons"><button disabled={actionBusy()} onClick={() => void runAction({ kind: "cherry_pick", value: { hash: details()!.hash } })}>Cherry-pick</button><button disabled={actionBusy()} onClick={() => void runAction({ kind: "revert", value: { hash: details()!.hash } }, `Revert commit ${details()!.hash.slice(0, 8)}?`)}>Revert</button><button disabled={actionBusy()} onClick={() => void runAction({ kind: "detach", value: { hash: details()!.hash } }, `Check out ${details()!.hash.slice(0, 8)} in detached HEAD?`)}>Check out commit</button><button disabled={actionBusy()} onClick={tagSelectedCommit}>Create tag</button><button disabled={actionBusy()} onClick={() => void runAction({ kind: "reset", value: { hash: details()!.hash, mode: "soft" } }, `Soft reset ${repo()?.branch} to ${details()!.hash.slice(0, 8)}?`)}>Reset soft</button><button disabled={actionBusy()} onClick={() => void runAction({ kind: "reset", value: { hash: details()!.hash, mode: "mixed" } }, `Mixed reset ${repo()?.branch} to ${details()!.hash.slice(0, 8)}? This will unstage changes.`)}>Reset mixed</button><button class="danger" disabled={actionBusy()} onClick={() => void runAction({ kind: "reset", value: { hash: details()!.hash, mode: "hard" } }, `Hard reset ${repo()?.branch} to ${details()!.hash.slice(0, 8)}? This discards tracked working changes and commits after that point.`)}>Reset hard</button><For each={repo()?.refs.filter(item => item.kind === "tag" && item.target === details()!.hash)}>{item => <button class="danger" disabled={actionBusy()} onClick={() => void runAction({ kind: "delete_tag", value: { name: item.name } }, `Delete local tag ${item.name}?`)}>Delete tag {item.name}</button>}</For></div></details></Show>
            <Show when={repo()?.operation && !choice()}><div class="operation-panel"><strong>{repo()!.operation!.replace("_", "-")} in progress</strong><span>{conflicts().length ? `${conflicts().length} conflicted file${conflicts().length === 1 ? "" : "s"}. Edit or choose a side, then stage each file.` : "All conflicts resolved. Continue or abort the operation."}</span><div class="operation-buttons"><button disabled={actionBusy() || !!conflicts().length} onClick={() => void runAction({ kind: "continue_operation" })}>Continue</button><button disabled={actionBusy()} onClick={() => void runAction({ kind: "abort_operation" }, `Abort the ${repo()?.operation?.replace("_", "-")}?`)}>Abort</button></div><For each={conflicts()}>{item => <div class="conflict-row"><span title={item.path}>{item.path}</span><button disabled={actionBusy()} onClick={() => void runAction({ kind: "resolve_file", value: { path: item.path, side: "ours" } }, `Use Git's ours version of ${item.path} and mark it resolved?`)}>Use ours</button><button disabled={actionBusy()} onClick={() => void runAction({ kind: "resolve_file", value: { path: item.path, side: "theirs" } }, `Use Git's theirs version of ${item.path} and mark it resolved?`)}>Use theirs</button><button disabled={actionBusy()} onClick={() => void runAction({ kind: "stage_file", value: { path: item.path } })}>Mark resolved</button></div>}</For></div></Show>
            <Show when={selected() === "working" && !repo()?.operation && !choice()}><div class="commit-editor"><textarea value={commitMessage()} onInput={event => setCommitMessage(event.currentTarget.value)} placeholder="Commit message" rows="2" /><div class="commit-editor-actions"><label><input type="checkbox" checked={amend()} disabled={!repo()?.head} onChange={event => setAmend(event.currentTarget.checked)} /> Amend previous commit</label><button disabled={!commitMessage().trim() || actionBusy() || (!amend() && !workingFiles().some(item => item.target === "staged"))} onClick={() => void commitChanges()}>Commit changes</button></div></div></Show>
            <Show when={!choice()}><div class="files-heading multiple-actions"><strong class="files-title">CHANGED FILES <span>{files().length}</span></strong><div class="files-heading-spacer" /><button class="whitespace-toggle" type="button" aria-pressed={ignoreWhitespace()} title="Hide whitespace-only changes" onClick={toggleWhitespace}>Ignore whitespace {ignoreWhitespace() ? "✓" : ""}</button><Show when={files().length}><button onClick={() => setEveryDiff(!files().every(isSummaryExpanded))}>{files().every(isSummaryExpanded) ? "Collapse all" : "Expand all"}</button></Show><Show when={selected() === "working" && files().length && !conflicts().length}><button disabled={actionBusy()} onClick={() => void runAction({ kind: "stage_all" })}>Stage All</button></Show></div>
            <Show when={files().length} fallback={<div class="empty-note">No files to show</div>}><div class="files-list"><For each={fileGroups()}>{group => <><Show when={group.title}><div class="file-group-heading"><button class="group-disclosure" aria-label={`${isSummaryGroupExpanded(group.items) ? "Close" : "Open"} all ${group.title.toLowerCase()} changes`} aria-expanded={isSummaryGroupExpanded(group.items)} onClick={() => toggleSummaryGroup(group.items)}><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 4h8L6 8z" fill="currentColor" /></svg></button><div class="file-group-title">{group.title} <span>{group.items.length}</span></div></div></Show><For each={group.items}>{item => <DiffCard item={item} repoPath={repo()!.path} working={selected() === "working"} ignoreWhitespace={ignoreWhitespace()} expanded={isSummaryExpanded(item)} keyboardSelected={keyboardFileKey() === summaryKey(item)} actionBusy={actionBusy()} scrollRoot={detailsScroll} onSelect={() => setKeyboardFileKey(summaryKey(item))} onToggle={() => { setKeyboardFileKey(summaryKey(item)); toggleSummaryDiff(item); }} onOpenTab={() => void selectFile(item)} onOpenEditor={value => void openInEditor(item, value)} onAction={(operation, confirmation) => void runAction(operation, confirmation)} onError={setError} />}</For></>}</For></div></Show></Show>
            <Show when={choice()}><div class="diff-heading"><span class="diff-heading-path" title={choice()?.path}>{choice()?.path}</span><button class="whitespace-toggle" type="button" aria-pressed={ignoreWhitespace()} title="Hide whitespace-only changes" onClick={toggleWhitespace}>Ignore whitespace {ignoreWhitespace() ? "✓" : ""}</button><span class="diff-heading-target">{choice()?.target === "untracked" ? "NEW FILE" : choice()?.target === "working" ? "UNSTAGED" : choice()?.target === "staged" ? "STAGED" : choice()!.target.slice(0, 8)}</span><button class="diff-open-editor" title={`Open ${choice()?.path} in editor`} onClick={() => void openInEditor(choice()!, diff())}>Open in editor</button></div>
              <Show when={selected() === "working"}><div class="file-actions"><Show when={choice()?.target === "staged"} fallback={<button disabled={actionBusy()} onClick={() => void runAction({ kind: "stage_file", value: { path: choice()!.path } })}>{choice()?.status === "U" ? "Mark resolved" : "Stage file"}</button>}><button disabled={actionBusy()} onClick={() => void runAction({ kind: "unstage_file", value: { path: choice()!.path } })}>Unstage file</button></Show><Show when={choice()?.target === "working" && choice()?.status !== "U"}><button class="danger" disabled={actionBusy()} onClick={() => void runAction({ kind: "discard_file", value: { path: choice()!.path } }, `Discard changes to ${choice()!.path}?`)}>Discard changes</button></Show></div></Show>
              <Show when={choice()?.status === "U"}><div class="diff-filter-note">Conflicted file. Edit the file or choose a side in the conflict panel, then mark it resolved.</div></Show>
              <Show when={ignoreWhitespace() && selected() === "working" && choice()?.target !== "untracked"}><div class="diff-filter-note">Line and hunk actions are unavailable while whitespace is ignored.</div></Show><Show when={diff()} fallback={<div class="empty-note">Loading diff…</div>}>{current => <DiffText value={current()} item={choice()!} working={selected() === "working"} ignoreWhitespace={ignoreWhitespace()} actionBusy={actionBusy()} onAction={(operation, confirmation) => void runAction(operation, confirmation)} />}</Show>
            </Show>
          </div>
        </section>
      </main>
      </Show>
    </Show>
    <footer class="statusbar"><span><span class="connection-dot" /> {repo()?.path ?? "Ready"}</span><span>{actionBusy() ? "RUNNING GIT COMMAND" : repo()?.loading || busy() || searchBusy() ? "LOADING REPOSITORY" : repo()?.loadError ? "REPOSITORY UNAVAILABLE" : "READY"} <i /> GITFERRY 0.1</span></footer>
    <Show when={rebasePlan()}>{plan => <div class="modal-backdrop" onClick={() => setRebasePlan(null)}><div class="rebase-modal" role="dialog" aria-label="Interactive rebase plan" onClick={event => event.stopPropagation()}>
      <div class="modal-title"><span>Interactive rebase</span><button aria-label="Close rebase plan" onClick={() => setRebasePlan(null)}>×</button></div>
      <div class="rebase-intro"><strong>{plan().branch}</strong> onto <strong>{plan().onto}</strong><p>Commits replay from top to bottom. Move them, then choose Pick, Fixup, or Drop. Fixup combines a commit with the preceding picked commit.</p></div>
      <div class="rebase-steps"><For each={plan().steps}>{(item, index) => <div class={`rebase-step ${item.action === "drop" ? "dropped" : ""}`}>
        <div class="rebase-move"><button aria-label={`Move ${item.subject} earlier`} title="Move earlier" disabled={index() === 0} onClick={() => moveRebaseStep(index(), -1)}>↑</button><button aria-label={`Move ${item.subject} later`} title="Move later" disabled={index() === plan().steps.length - 1} onClick={() => moveRebaseStep(index(), 1)}>↓</button></div>
        <div class="rebase-commit"><span title={item.subject}>{item.subject}</span><code>{item.hash.slice(0, 8)}</code></div>
        <select aria-label={`Action for ${item.subject}`} value={item.action} onChange={event => setRebaseAction(item.hash, event.currentTarget.value as RebaseStep["action"])}><option value="pick">Pick</option><option value="fixup">Fixup</option><option value="drop">Drop</option></select>
      </div>}</For></div>
      <Show when={plan().steps.find(item => item.action !== "drop")?.action === "fixup"}><div class="rebase-validation">The first kept commit must be Pick. Fixup needs an earlier commit.</div></Show>
      <div class="rebase-footer"><span>{plan().steps.length} commits · {plan().steps.filter(item => item.action === "drop").length} dropped</span><button onClick={() => setRebasePlan(null)}>Cancel</button><button class="rebase-start" disabled={actionBusy() || plan().steps.find(item => item.action !== "drop")?.action === "fixup"} onClick={startPlannedRebase}>Start rebase</button></div>
    </div></div>}</Show>
    <Show when={paletteOpen()}><div class="modal-backdrop palette-backdrop" onClick={() => setPaletteOpen(false)}><div class="palette" onClick={event => event.stopPropagation()} onKeyDown={paletteKey}><input autofocus value={paletteInput()} onInput={event => setPaletteInput(event.currentTarget.value)} placeholder="Type a command…" /><div class="palette-list"><For each={paletteCommands()}>{command => <button onClick={() => { setPaletteOpen(false); command.run(); }}>{command.label}</button>}</For></div></div></div></Show>
    <Show when={showSettings()}><div class="modal-backdrop" onClick={() => setShowSettings(false)}><div class="settings-modal" role="dialog" aria-label="Settings" onClick={event => event.stopPropagation()}>
      <div class="modal-title"><span>Settings</span><button aria-label="Close settings" onClick={() => setShowSettings(false)}>×</button></div>
      <div class="settings-body"><label>EDITOR<select aria-label="External editor" value={editor()} onChange={event => setEditor(event.currentTarget.value as EditorId)}><For each={editorOptions}>{option => <option value={option.id}>{option.label}</option>}</For></select></label>
        <label>COMMAND OVERRIDE<input aria-label="Editor command override" value={editorExecutable()} onInput={event => setEditorExecutable(event.currentTarget.value)} placeholder={editor() === "antigravity" ? "antigravity" : editor() === "vscode" ? "code" : "subl"} /></label>
        <p>Leave the command blank to use the editor CLI from PATH. Enter a full executable path if needed. Open in editor jumps to the first changed line. For SSH repositories, Antigravity and VS Code require Remote SSH access to the same host.</p>
      </div><div class="settings-footer"><button onClick={() => setShowSettings(false)}>Done</button></div>
    </div></div></Show>
    <Show when={showOpen()}><div class="modal-backdrop" onClick={() => setShowOpen(false)}><div class="open-modal" onClick={event => event.stopPropagation()}>
      <div class="modal-title"><span>Open repository</span><button onClick={() => setShowOpen(false)}>×</button></div>
      <div class="open-kind"><button class={openKind() === "local" ? "active" : ""} onClick={() => setOpenKind("local")}>Local</button><button class={openKind() === "remote" ? "active" : ""} onClick={() => setOpenKind("remote")}>SSH host</button></div>
      <Show when={error()}><div class="modal-error">{error()}</div></Show>
      <Show when={openKind() === "local"} fallback={<div class="modal-body"><div class="eyebrow">REMOTE REPOSITORY</div><p>Connect through your system SSH configuration.</p>
        <form class="remote-form" onSubmit={event => { event.preventDefault(); void openRepo(`ssh://${hostInput()}${remotePathInput()}`); }}>
          <label>HOST<input value={hostInput()} onInput={event => setHostInput(event.currentTarget.value)} placeholder="root@warmer" /></label>
          <label>ABSOLUTE PATH<input value={remotePathInput()} onInput={event => setRemotePathInput(event.currentTarget.value)} placeholder="/srv/my-repo" /></label>
          <button type="submit" disabled={busy() || !hostInput().trim() || !remotePathInput().startsWith("/")}>{busy() ? "Connecting…" : "Connect"}</button>
        </form></div>}>
      <div class="modal-body"><div class="eyebrow">LOCAL REPOSITORY</div><p>Choose a Git working tree on this computer.</p><button class="folder-button" onClick={() => void chooseFolder()}>Browse folders</button><div class="modal-divider">or enter a path</div><form onSubmit={event => { event.preventDefault(); void openRepo(pathInput()); }}><input autofocus value={pathInput()} onInput={event => setPathInput(event.currentTarget.value)} placeholder="C:\\path\\to\\repository" /><button type="submit" disabled={busy()}>Open</button></form></div>
      </Show>
    </div></div></Show>
  </div>;
}
export default App;
