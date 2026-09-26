import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import "./App.css";

type Status = { path: string; index: string; worktree: string };
type Ref = { name: string; kind: string; target: string; isHead: boolean; ahead?: number; behind?: number };
type Commit = { hash: string; parents: string[]; subject: string; author: string; timestamp: number; decorations: string[] };
type Repo = { path: string; name: string; branch: string; head: string | null; status: Status[]; refs: Ref[]; commits: Commit[]; hasMore: boolean };
type RepoState = { branch: string; head: string | null; status: Status[] };
type SearchResult = { commits: Commit[]; hasMore: boolean };
type Details = { hash: string; subject: string; body: string; author: string; authorEmail: string; timestamp: number; parents: string[]; files: { path: string; status: string }[] };
type Choice = { path: string; status: string; target: string };
type Diff = { text: string; truncated: boolean };
type RefNode = { label: string; path: string; ref?: Ref; children: RefNode[]; count: number; containsHead: boolean };
type Operation = { kind: "stage_all" | "fetch" | "pull" | "push" | "force_push_with_lease" } | { kind: "stage_file" | "unstage_file" | "discard_file"; value: { path: string } } | { kind: "stage_hunk"; value: { path: string; index: number; reverse: boolean } } | { kind: "stage_lines"; value: { path: string; lines: number[]; diff: string } } | { kind: "commit"; value: { message: string; amend: boolean } } | { kind: "checkout" | "create_branch" | "delete_branch"; value: { branch: string } } | { kind: "stash"; value: { message: string } } | { kind: "apply_stash" | "pop_stash"; value: { hash: string } };
const recentKey = "gitferry.recent";
const tabsKey = "gitferry.openTabs";
const activeKey = "gitferry.activeTab";
const themeKey = "gitferry.theme";
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
const date = (value: number) => new Date(value * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
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
  return <For each={props.nodes}>{node => <Show when={!node.ref} fallback={<button class={`ref-item ${node.ref?.isHead ? "current" : ""}`} style={{ "padding-left": `${25 + props.depth * 14}px` }} title={node.path} disabled={props.kind === "submodule"} onClick={() => props.onSelect(node.ref!.target)}>
    <span class="ref-icon">{props.kind === "branch" ? "⑂" : props.kind === "remote" ? "☁" : props.kind === "stash" ? "◷" : props.kind === "submodule" ? "▣" : "◇"}</span><span class="ref-name">{node.label}</span><Show when={node.ref?.ahead || node.ref?.behind}><span class="ref-tracking">{node.ref?.ahead ? `↑${node.ref.ahead}` : ""} {node.ref?.behind ? `↓${node.ref.behind}` : ""}</span></Show><Show when={node.ref?.isHead}><span class="ref-head">HEAD</span></Show>
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
      return { line, hunk: ++hunk, kind: "hunk", oldNumber: null, newNumber: null };
    }
    let oldNumber: number | null = null;
    let newNumber: number | null = null;
    let kind = line.startsWith("diff --git ") ? "diff-title" : "";
    if (inHunk) {
      if (line.startsWith(" ")) { oldNumber = oldLine++; newNumber = newLine++; }
      else if (line.startsWith("-")) { oldNumber = oldLine++; kind = "deleted"; }
      else if (line.startsWith("+")) { newNumber = newLine++; kind = "added"; }
    }
    return { line, hunk: -1, kind, oldNumber, newNumber };
  });
}

function DiffText(props: { value: Diff; item: Choice; working: boolean; actionBusy: boolean; onAction: (operation: Operation) => void }) {
  const lines = createMemo(() => parseDiffLines(props.value));
  const [selectedLines, setSelectedLines] = createSignal<number[]>([]);
  const selectedSet = createMemo(() => new Set(selectedLines()));
  const lineStageNote = createMemo(() => props.value.truncated ? "Diff too large for line staging; use Stage file." : props.value.text.includes("\\ No newline at end of file") ? "Stage the whole hunk when a file has no final newline." : /(^|\n)(new file mode|deleted file mode|rename from|rename to|copy from|copy to|old mode|new mode)/.test(props.value.text) ? "Stage the file for rename or mode changes." : "");
  const stageable = createMemo(() => props.working && props.item.target === "working" && !lineStageNote());
  const changed = (index: number) => {
    const kind = lines()[index]?.kind;
    return stageable() && (kind === "added" || kind === "deleted");
  };
  let anchor = -1;
  let dragStart = -1;
  let dragged = false;
  createEffect(() => { void props.value.text; setSelectedLines([]); anchor = -1; });
  const selectRange = (from: number, to: number) => {
    const range: number[] = [];
    for (let index = Math.min(from, to); index <= Math.max(from, to); index++) if (changed(index)) range.push(index);
    return range;
  };
  function selectLine(index: number, event: MouseEvent) {
    if (dragged) { dragged = false; return; }
    if (event.shiftKey && anchor >= 0) setSelectedLines(current => [...new Set([...current, ...selectRange(anchor, index)])]);
    else { setSelectedLines(current => current.includes(index) ? current.filter(item => item !== index) : [...current, index]); anchor = index; }
  }
  return <>
    <Show when={props.working && props.item.target === "working"}><div class="line-selection-toolbar"><span>{lineStageNote() || (selectedLines().length ? `${selectedLines().length} line${selectedLines().length === 1 ? "" : "s"} selected` : "Click changed line numbers to select lines · Shift-click for a range")}</span><Show when={selectedLines().length}><button class="clear-lines" onClick={() => setSelectedLines([])}>Clear</button></Show><button class="stage-lines" disabled={!stageable() || !selectedLines().length || props.actionBusy} onClick={() => props.onAction({ kind: "stage_lines", value: { path: props.item.path, lines: [...selectedLines()].sort((a, b) => a - b), diff: props.value.text } })}>Stage Lines</button></div></Show>
    <div class="diff-content" onPointerUp={() => { dragStart = -1; }}><For each={lines()}>{({ line, hunk, kind, oldNumber, newNumber }, index) => <div class={`diff-line ${kind} ${selectedSet().has(index()) ? "selected" : ""}`}>
      <Show when={changed(index())} fallback={<span class="line-number"><span class="old-line">{oldNumber ?? ""}</span><span class="new-line">{newNumber ?? ""}</span></span>}><button class="line-number selectable" type="button" title="Select line for staging" aria-label={`Select ${kind === "added" ? "new" : "old"} line ${kind === "added" ? newNumber : oldNumber}`} aria-pressed={selectedSet().has(index())} onPointerDown={event => { if (event.button === 0) { dragStart = index(); dragged = false; } }} onPointerEnter={event => { if (dragStart >= 0 && index() !== dragStart && (event.buttons & 1)) { dragged = true; anchor = dragStart; setSelectedLines(selectRange(dragStart, index())); } }} onClick={event => selectLine(index(), event)}><span class="old-line">{oldNumber ?? ""}</span><span class="new-line">{newNumber ?? ""}</span></button></Show>
      <span class="line-text">{line || " "}</span><Show when={hunk >= 0 && props.working && (props.item.target === "working" || props.item.target === "staged")}><button class="hunk-action" disabled={props.actionBusy} onClick={() => props.onAction({ kind: "stage_hunk", value: { path: props.item.path, index: hunk, reverse: props.item.target === "staged" } })}>{props.item.target === "staged" ? "Unstage hunk" : "Stage hunk"}</button></Show>
    </div>}</For></div><Show when={props.value.truncated}><div class="truncated-note">Diff preview limited to 512 KB.</div></Show>
  </>;
}

function demoDiff(item: Choice): Diff {
  return { text: `diff --git a/${item.path} b/${item.path}\nindex 2a6d9f1..a83f140 100644\n--- a/${item.path}\n+++ b/${item.path}\n@@ -12,6 +12,8 @@ function RepositoryView() {\n   const branch = repository.branch;\n-  const loading = false;\n+  const loading = repository.isLoading;\n+  const remote = repository.remoteHost;\n   return renderHistory(branch);\n }\n`, truncated: false };
}

function DiffCard(props: { item: Choice; repoPath: string; working: boolean; expanded: boolean; actionBusy: boolean; scrollRoot: HTMLElement; onToggle: () => void; onAction: (operation: Operation, confirmation?: string) => void; onError: (error: string) => void }) {
  let element!: HTMLDivElement;
  const [value, setValue] = createSignal<Diff | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [loadError, setLoadError] = createSignal("");
  createEffect(() => {
    if (!props.expanded || value() || loading() || loadError()) return;
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      setLoading(true);
      const result = demoMode ? Promise.resolve(demoDiff(props.item)) : invoke<Diff>("repo_diff", { path: props.repoPath, target: props.item.target, file: props.item.path });
      void result.then(setValue).catch(cause => { setLoadError(String(cause)); props.onError(String(cause)); }).finally(() => setLoading(false));
    }, { root: props.scrollRoot, rootMargin: "400px" });
    observer.observe(element);
    onCleanup(() => observer.disconnect());
  });
  return <div class="all-diff-card" ref={element}>
    <button class="all-diff-heading" aria-expanded={props.expanded} onClick={props.onToggle}><span class="ref-disclosure">{props.expanded ? "⌄" : "›"}</span><span class={`file-status ${props.item.status === "A" || props.item.status === "U" ? "added" : props.item.status === "D" ? "deleted" : "modified"}`}>{props.item.status}</span><span class="file-path">{props.item.path}</span><span class="diff-target">{props.item.target === "untracked" ? "NEW FILE" : props.item.target === "working" ? "UNSTAGED" : props.item.target === "staged" ? "STAGED" : "COMMIT"}</span></button>
    <Show when={props.expanded}><Show when={props.working}><div class="file-actions"><Show when={props.item.target === "staged"} fallback={<button disabled={props.actionBusy} onClick={() => props.onAction({ kind: "stage_file", value: { path: props.item.path } })}>Stage file</button>}><button disabled={props.actionBusy} onClick={() => props.onAction({ kind: "unstage_file", value: { path: props.item.path } })}>Unstage file</button></Show><Show when={props.item.target === "working"}><button class="danger" disabled={props.actionBusy} onClick={() => props.onAction({ kind: "discard_file", value: { path: props.item.path } }, `Discard changes to ${props.item.path}?`)}>Discard changes</button></Show></div></Show><Show when={value()} fallback={<div class="empty-note">{loadError() || "Loading diff…"}</div>}>{current => <DiffText value={current()} item={props.item} working={props.working} actionBusy={props.actionBusy} onAction={operation => props.onAction(operation)} />}</Show></Show>
  </div>;
}

function GraphRow(props: { step: GraphStep; theme: ThemeId }) {
  let canvas!: HTMLCanvasElement;
  createEffect(() => {
    const step = props.step;
    const theme = props.theme;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, 74, 61);
    const x = (lane: number) => 21 + lane * 12;
    const stroke = (lane: number, fromX: number, fromY: number, toX: number, toY: number) => {
      context.strokeStyle = graphColors[theme][lane % graphColors[theme].length];
      context.lineWidth = 2;
      context.beginPath(); context.moveTo(fromX, fromY); context.lineTo(toX, toY); context.stroke();
    };
    for (const lane of step.before) stroke(lane, x(lane), 0, x(lane), lane === step.lane ? 23 : 61);
    for (const lane of step.parents) stroke(lane, x(step.lane), 23, x(lane), 61);
    context.fillStyle = graphColors[theme][step.lane % graphColors[theme].length];
    context.beginPath(); context.arc(x(step.lane), 23, 4.5, 0, Math.PI * 2); context.fill();
    context.strokeStyle = graphOutlines[theme]; context.lineWidth = 2; context.stroke();
  });
  return <canvas class="graph-canvas" ref={canvas} width="74" height="61" aria-hidden="true" />;
}

function App() {
  const [theme, setTheme] = createSignal<ThemeId>(initialTheme);
  const [tabs, setTabs] = createSignal<Repo[]>([]);
  const [activePath, setActivePath] = createSignal<string | null>(null);
  const [selected, setSelected] = createSignal("working");
  const [details, setDetails] = createSignal<Details | null>(null);
  const [choice, setChoice] = createSignal<Choice | null>(null);
  const [diff, setDiff] = createSignal<Diff | null>(null);
  const [showAllDiffs, setShowAllDiffs] = createSignal(false);
  const [allExpanded, setAllExpanded] = createSignal(true);
  const [diffOverrides, setDiffOverrides] = createSignal<Record<string, boolean>>({});
  const [folderOverrides, setFolderOverrides] = createSignal<Record<string, boolean>>({});
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [actionBusy, setActionBusy] = createSignal(false);
  const [notice, setNotice] = createSignal("");
  const [commitMessage, setCommitMessage] = createSignal("");
  const [amend, setAmend] = createSignal(false);
  const [branchMenu, setBranchMenu] = createSignal(false);
  const [pushMenu, setPushMenu] = createSignal(false);
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
  let request = 0;
  let stateBusy = false;
  let draggedTab: string | null = null;
  let commitScroll!: HTMLDivElement;
  let detailsScroll!: HTMLDivElement;
  const repo = createMemo(() => tabs().find(item => item.path === activePath()) ?? null);
  const stashes = createMemo(() => repo()?.refs.filter(item => item.kind === "stash") ?? []);
  const displayedCommits = createMemo(() => searchQuery() ? searchResult().commits : repo()?.commits ?? []);
  const hasMore = createMemo(() => searchQuery() ? searchResult().hasMore : repo()?.hasMore ?? false);
  const workingFiles = createMemo<Choice[]>(() => (repo()?.status ?? []).flatMap(item => {
    if (item.index === "?" && item.worktree === "?") return [{ path: item.path, status: "U", target: "untracked" }];
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
  const diffKey = (item: Choice) => `${item.target}:${item.path}`;
  const isDiffExpanded = (item: Choice) => diffOverrides()[diffKey(item)] ?? allExpanded();
  function toggleDiff(item: Choice) { setDiffOverrides(previous => ({ ...previous, [diffKey(item)]: !isDiffExpanded(item) })); }
  function setEveryDiff(open: boolean) { setAllExpanded(open); setDiffOverrides({}); }
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
    const start = Math.max(0, Math.floor(Math.max(0, scrollTop() - (searchQuery() ? 0 : 68)) / 61) - 8);
    const end = Math.min(commits.length, start + Math.ceil(viewportHeight() / 61) + 18);
    return commits.slice(start, end).map((item, offset) => ({ item, index: start + offset }));
  });
  const paletteCommands = createMemo(() => {
    const commands: { label: string; run: () => void }[] = [
      { label: "Open repository", run: () => setShowOpen(true) },
      { label: "Refresh repository", run: () => { void refresh(); } },
      { label: "Search commits", run: () => document.querySelector<HTMLInputElement>(".search-box input")?.focus() },
    ];
    if (repo()) {
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

  function selectWorking() { request++; setSelected("working"); setDetails(null); setChoice(null); setDiff(null); setShowAllDiffs(false); if (detailsScroll) detailsScroll.scrollTop = 0; }
  function saveRecent(path: string) {
    const next = [path, ...recent().filter(item => item !== path)].slice(0, 12);
    setRecent(next);
    localStorage.setItem(recentKey, JSON.stringify(next));
  }
  function saveTabs() {
    localStorage.setItem(tabsKey, JSON.stringify(tabs().map(item => item.path)));
    localStorage.setItem(activeKey, activePath() ?? "");
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
    if (!path) return;
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
    if (!path || !isTauri() || stateBusy) return;
    stateBusy = true;
    try {
      const update = await invoke<RepoState>("repo_state", { path });
      const current = tabs().find(item => item.path === path);
      if (!current) return;
      if (update.head !== current.head || update.branch !== current.branch) {
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
    setSelected(hash); setDetails(null); setChoice(null); setDiff(null);
    setShowAllDiffs(false);
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
    setShowAllDiffs(false); setChoice(item); setDiff(null);
    const id = ++request;
    if (demoMode) {
      setDiff(demoDiff(item));
      requestAnimationFrame(revealDiff);
      return;
    }
    try {
      const result = await invoke<Diff>("repo_diff", { path, target: item.target, file: item.path });
      if (id === request) { setDiff(result); requestAnimationFrame(revealDiff); }
    } catch (cause) { if (id === request) setError(String(cause)); }
  }
  function revealDiff() {
    detailsScroll?.querySelector<HTMLElement>(".diff-heading")?.scrollIntoView({ block: "start", behavior: "auto" });
  }
  async function runAction(operation: Operation, confirmation?: string) {
    const path = activePath();
    if (!path || actionBusy() || (confirmation && !window.confirm(confirmation))) return;
    setActionBusy(true); setError(""); setNotice("");
    try {
      const output = await invoke<string>("repo_action", { path, operation });
      setNotice(output || "Done");
      setChoice(null); setDiff(null); setBranchMenu(false); setPushMenu(false); setStashMenu(false);
      await refresh();
      if (searchQuery()) await performSearch(searchQuery());
    } catch (cause) { setError(String(cause)); }
    finally { setActionBusy(false); }
  }
  function forcePushWithLease() {
    setPushMenu(false);
    void runAction({ kind: "force_push_with_lease" }, `Force push ${repo()?.branch} with lease? This can replace remote commits if the remote still matches your tracking branch.`);
  }
  async function commitChanges() {
    if (!commitMessage().trim()) return;
    await runAction({ kind: "commit", value: { message: commitMessage(), amend: amend() } });
    if (!error()) { setCommitMessage(""); setAmend(false); }
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
    if (isTauri()) {
      try {
        const paths = JSON.parse(localStorage.getItem(tabsKey) ?? "[]");
        const selectedPath = localStorage.getItem(activeKey);
        if (Array.isArray(paths)) void (async () => {
          for (const path of paths.filter((item): item is string => typeof item === "string")) await openRepo(path);
          if (selectedPath && tabs().some(item => item.path === selectedPath)) setActivePath(selectedPath);
        })();
      } catch { /* Ignore invalid old settings. */ }
    }
    const interval = window.setInterval(() => { if (document.hasFocus()) void refreshState(); }, 1500);
    const focus = () => void refresh();
    const keys = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setPaletteOpen(false); setShowOpen(false); setBranchMenu(false); setPushMenu(false); setStashMenu(false); return; }
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() === "p") { event.preventDefault(); setPaletteInput(""); setPaletteOpen(true); requestAnimationFrame(() => document.querySelector<HTMLInputElement>(".palette input")?.focus()); }
      if (event.key.toLowerCase() === "o") { event.preventDefault(); setShowOpen(true); }
      if (event.key.toLowerCase() === "r") { event.preventDefault(); void refresh(); }
    };
    window.addEventListener("focus", focus); window.addEventListener("keydown", keys);
    const resize = () => { if (commitScroll) setViewportHeight(commitScroll.clientHeight); };
    window.addEventListener("resize", resize);
    onCleanup(() => { unlistenDrop?.(); window.clearInterval(interval); window.removeEventListener("focus", focus); window.removeEventListener("keydown", keys); window.removeEventListener("resize", resize); });
  });

  return <div class="app-shell" onPointerDown={event => { if (event.target instanceof Element) { if (!event.target.closest(".push-control")) setPushMenu(false); if (!event.target.closest(".stash-control")) setStashMenu(false); } }}>
    <Show when={draggingFolder()}><div class="drop-overlay"><div><strong>Open repository</strong><span>Drop a Git folder here</span></div></div></Show>
    <header class="tabbar">
      <div class="brand-mark">◇</div>
      <div class="tab-strip">
      <For each={tabs()}>{item => <div class={`repo-tab ${activePath() === item.path ? "active" : ""}`} draggable onDragStart={() => { draggedTab = item.path; }} onDragOver={event => event.preventDefault()} onDrop={() => reorderTab(item.path)} onDragEnd={() => { draggedTab = null; }}>
        <button class="tab-main" onClick={() => { setActivePath(item.path); setNotice(""); setStashMenu(false); setScrollTop(0); setSearchQuery(""); setSearchInput(""); if (commitScroll) commitScroll.scrollTop = 0; selectWorking(); saveTabs(); }}>{item.name}<span>{item.branch}</span></button>
        <button class="tab-close" aria-label={`Close ${item.name}`} onClick={() => closeTab(item.path)}>×</button>
      </div>}</For>
      <button class="tab-add" title="Open repository" onClick={() => setShowOpen(true)}>＋</button>
      </div><div class="app-name">GITFERRY <span>LOCAL + SSH</span></div>
      <label class="theme-control"><span class="theme-caption">THEME</span><span class="theme-swatch" aria-hidden="true" /><select aria-label="Color theme" value={theme()} onChange={event => setTheme(event.currentTarget.value as ThemeId)}><For each={themeOptions}>{option => <option value={option.id}>{option.label}</option>}</For></select></label>
    </header>
    <div class="toolbar">
      <button class="toolbar-icon" title="Toggle locations" onClick={() => setLocationsOpen(!locationsOpen())}>☷</button>
      <button class="toolbar-icon layout-toggle" title={bottomLayout() ? "Show details beside history" : "Show details below history"} onClick={() => { const next = !bottomLayout(); setBottomLayout(next); localStorage.setItem("gitferry.bottomLayout", String(next)); requestAnimationFrame(() => { if (commitScroll) setViewportHeight(commitScroll.clientHeight); }); }}>{bottomLayout() ? "▤" : "◫"}</button>
      <Show when={repo()} fallback={<span class="toolbar-title">Open a repository to begin</span>}>
        <div class="branch-control"><button class="branch-chip" onClick={() => setBranchMenu(!branchMenu())}><span>⑂</span>{repo()?.branch}<span class="branch-arrow">⌄</span></button>
          <Show when={branchMenu()}><div class="branch-menu"><div class="eyebrow">LOCAL BRANCHES</div><For each={repo()?.refs.filter(item => item.kind === "branch")}>{item => <div class="branch-menu-row"><button onClick={() => void runAction({ kind: "checkout", value: { branch: item.name } })}>{item.isHead ? "✓ " : ""}{item.name}</button><Show when={!item.isHead}><button class="branch-delete" title={`Delete ${item.name}`} onClick={() => void runAction({ kind: "delete_branch", value: { branch: item.name } }, `Delete branch ${item.name}?`)}>×</button></Show></div>}</For>
            <form onSubmit={event => { event.preventDefault(); void runAction({ kind: "create_branch", value: { branch: newBranch() } }); setNewBranch(""); }}><input value={newBranch()} onInput={event => setNewBranch(event.currentTarget.value)} placeholder="New branch name" /><button type="submit">Create</button></form></div></Show>
        </div><div class="path-label">{repo()?.path}</div>
      </Show>
      <div class="toolbar-spacer" />
      <Show when={repo()}><form class="search-box" onSubmit={event => { event.preventDefault(); void performSearch(); }}><span>⌕</span><input value={searchInput()} onInput={event => { setSearchInput(event.currentTarget.value); if (!event.currentTarget.value) void performSearch(""); }} placeholder="Search commits" title="Search message, author:name, or path:file" /><Show when={searchQuery()}><button type="button" onClick={() => void performSearch("")}>×</button></Show></form></Show>
      <Show when={repo()}><button class="toolbar-button" title="Refresh" onClick={() => void refresh()}>↻ <span>Refresh</span></button><span class="toolbar-divider" /><button class="toolbar-button" title="Fetch" disabled={actionBusy()} onClick={() => void runAction({ kind: "fetch" })}>↓ <span>Fetch</span></button><button class="toolbar-button" title="Pull" disabled={actionBusy()} onClick={() => void runAction({ kind: "pull" })}>⇣ <span>Pull</span></button><div class="push-control"><button class="toolbar-button" title="Push" disabled={actionBusy()} onClick={() => void runAction({ kind: "push" })}>⇡ <span>Push</span></button><button class="toolbar-button push-more" title="More push options" aria-label="More push options" aria-expanded={pushMenu()} disabled={actionBusy()} onClick={() => setPushMenu(!pushMenu())}>⌄</button><Show when={pushMenu()}><div class="push-menu"><button title="Force push with lease" disabled={actionBusy()} onClick={forcePushWithLease}>Force push with lease</button><p>Push only if the remote branch still matches your tracking branch.</p></div></Show></div><button class="toolbar-button" title="Stash" disabled={actionBusy()} onClick={() => { const message = window.prompt("Stash message", "Work in progress"); if (message !== null) void runAction({ kind: "stash", value: { message } }); }}>▣ <span>Stash</span></button><div class="stash-control"><button class="toolbar-button" title="Unstash" aria-expanded={stashMenu()} disabled={actionBusy()} onClick={() => setStashMenu(!stashMenu())}>↶ <span>Unstash</span><Show when={stashes().length}><small>{stashes().length}</small></Show></button><Show when={stashMenu()}><div class="stash-menu"><div class="eyebrow">SAVED STASHES</div><Show when={stashes().length} fallback={<div class="stash-empty">No saved stashes</div>}><For each={stashes()}>{item => <div class="stash-menu-row"><div class="stash-menu-label" title={item.name}>{item.name}</div><div class="stash-menu-actions"><button disabled={actionBusy()} title="Restore changes and keep this stash" onClick={() => void runAction({ kind: "apply_stash", value: { hash: item.target } })}>Apply</button><button disabled={actionBusy()} title="Restore changes and remove this stash" onClick={() => void runAction({ kind: "pop_stash", value: { hash: item.target } })}>Pop</button></div></div>}</For></Show></div></Show></div></Show>
      <button class="toolbar-button primary" title="Open repository" onClick={() => setShowOpen(true)}>＋ <span>Open repo</span></button>
    </div>
    <Show when={error()}><div class="error-bar">{error()}<button onClick={() => setError("")}>×</button></div></Show>
    <Show when={notice()}><div class="notice-bar">{notice()}<button onClick={() => setNotice("")}>×</button></div></Show>
    <Show when={repo()} fallback={<main class="welcome">
      <div class="welcome-symbol">◇</div><div class="eyebrow">YOUR REPOSITORIES, ALL IN ONE PLACE</div>
      <h1>Git, wherever it lives.</h1><p>Open a local repository to browse its history, changes, and diffs.</p>
      <button class="welcome-open" onClick={() => setShowOpen(true)}>＋ &nbsp; Open repository</button>
      <Show when={recent().length}><div class="recent-list"><div class="eyebrow">RECENT</div><For each={recent()}>{path => <button onClick={() => void openRepo(path)}>⌁ &nbsp; {path}</button>}</For></div></Show>
    </main>}>
      <main class={`workspace ${bottomLayout() ? "alt" : ""} ${locationsOpen() ? "" : "no-locations"}`} style={{ "--history-height": `${commitsHeight()}px` }}>
        <Show when={locationsOpen()}><aside class="locations" style={{ width: `${locationsWidth()}px` }}><div class="pane-heading">LOCATIONS</div><div class="locations-list">
          <For each={["branch", "remote", "tag", "stash", "submodule"]}>{kind => <section class="ref-section">
            <div class="section-heading">⌄ &nbsp; {kind === "branch" ? "BRANCHES" : kind === "remote" ? "REMOTES" : kind === "tag" ? "TAGS" : kind === "stash" ? "STASHES" : "SUBMODULES"} <span>{repo()?.refs.filter(item => item.kind === kind).length ?? 0}</span></div>
            <RefTree nodes={groupRefs(repo()?.refs.filter(item => item.kind === kind) ?? [], kind === "branch" || kind === "remote")} kind={kind} depth={0} overrides={folderOverrides()} onToggle={(key, open) => setFolderOverrides(previous => ({ ...previous, [key]: open }))} onSelect={hash => void selectCommit(hash)} />
          </section>}</For></div><div class="locations-footer"><span class="connection-dot" /> {repo()?.path.startsWith("ssh://") ? "SSH REPOSITORY" : "LOCAL REPOSITORY"}</div>
        </aside><div class="splitter locations-splitter" onPointerDown={event => startResize("locations", event)} /></Show>
        <section class="commits-pane" style={{ width: `${commitsWidth()}px` }}><div class="pane-heading">{searchQuery() ? "SEARCH RESULTS" : "COMMITS"} <span class="heading-count">{displayedCommits().length}{hasMore() ? "+" : ""}</span></div>
          <div class="commit-scroll" ref={commitScroll} onScroll={event => {
            const element = event.currentTarget;
            setScrollTop(element.scrollTop);
            if (element.scrollHeight - element.scrollTop - element.clientHeight < 350) void loadMore();
          }}>
            <Show when={!searchQuery()}><button class={`working-row ${selected() === "working" ? "selected" : ""}`} onClick={selectWorking}><span class="working-node">●</span><span class="commit-main"><strong>Working Directory</strong><small>{repo()?.status.length ? `${repo()?.status.length} changed files` : "No changes"}</small></span><Show when={repo()?.status.length}><span class="count-badge">{repo()?.status.length}</span></Show></button></Show>
            <div class="virtual-commits" style={{ height: `${displayedCommits().length * 61}px` }}>
              <For each={visibleCommits()}>{({ item, index }) => <button style={{ top: `${index * 61}px` }} class={`commit-row ${selected() === item.hash ? "selected" : ""}`} onClick={() => void selectCommit(item.hash)}>
                <GraphRow step={graph()[index]} theme={theme()} />
                <span class="commit-main"><span class="commit-subject">{item.subject}</span><span class="commit-meta">{item.author}<span>{date(item.timestamp)}</span></span>
                  <Show when={item.decorations.length}><span class="decorations"><For each={item.decorations}>{label => <span class={`decoration ${label.startsWith("HEAD") ? "head" : ""}`}>{label.replace(/^HEAD -> /, "")}</span>}</For></span></Show>
                </span>
              </button>}</For>
            </div>
            <Show when={hasMore()}><button class="load-more" disabled={busy() || searchBusy()} onClick={() => void loadMore()}>{busy() || searchBusy() ? "Loading…" : "Load more commits"}</button></Show>
            <Show when={!displayedCommits().length}><div class="empty-note">{searchBusy() ? "Searching…" : searchQuery() ? "No matching commits" : "No commits yet"}</div></Show>
          </div>
        </section><div class="splitter commits-splitter" onPointerDown={event => startResize(bottomLayout() ? "history" : "commits", event)} />
        <section class="details-pane"><div class="details-tabs"><button class={`details-tab ${!showAllDiffs() && !choice() ? "active" : ""}`} onClick={() => { setShowAllDiffs(false); setChoice(null); setDiff(null); detailsScroll.scrollTop = 0; }}>SUMMARY</button><button class={`details-tab ${showAllDiffs() ? "active" : ""}`} onClick={() => { setShowAllDiffs(true); setChoice(null); setDiff(null); detailsScroll.scrollTop = 0; }}>ALL CHANGES</button><Show when={choice() && !showAllDiffs()}><button class="details-tab active" title={choice()?.path}>{choice()?.path.split("/").pop()?.split("\\").pop()}</button></Show></div>
          <div class="details-scroll" ref={detailsScroll}>
            <Show when={selected() === "working"} fallback={<Show when={details()} fallback={<div class="empty-note">Loading commit…</div>}>
              <div class="detail-header"><div class="eyebrow">COMMIT DETAILS <span class="hash">{details()!.hash.slice(0, 8)}</span></div><h2>{details()!.subject}</h2><Show when={details()!.body}><p class="commit-body">{details()!.body}</p></Show><div class="commit-byline"><span class="avatar">{details()!.author.charAt(0).toUpperCase()}</span><span>{details()!.author}<small>{details()!.authorEmail} · {new Date(details()!.timestamp * 1000).toLocaleString()}</small></span></div><Show when={details()!.parents.length}><div class="parent-hashes">PARENT{details()!.parents.length > 1 ? "S" : ""} <For each={details()!.parents}>{parent => <span>{parent.slice(0, 8)}</span>}</For></div></Show></div>
            </Show>}><div class="detail-header working-header"><div class="eyebrow">WORKING DIRECTORY</div><h2>{repo()?.status.length ? "Uncommitted changes" : "Everything is up to date"}</h2><p>{repo()?.status.length ? "Review the files changed in your working tree." : "Your working tree is clean."}</p></div></Show>
            <Show when={selected() === "working"}><div class="commit-editor"><textarea value={commitMessage()} onInput={event => setCommitMessage(event.currentTarget.value)} placeholder="Commit message" rows="2" /><div class="commit-editor-actions"><label><input type="checkbox" checked={amend()} disabled={!repo()?.head} onChange={event => setAmend(event.currentTarget.checked)} /> Amend previous commit</label><button disabled={!commitMessage().trim() || actionBusy() || (!amend() && !workingFiles().some(item => item.target === "staged"))} onClick={() => void commitChanges()}>Commit changes</button></div></div></Show>
            <div class="files-heading">CHANGED FILES <span>{files().length}</span><div class="files-heading-spacer" /><Show when={showAllDiffs() && files().length}><button onClick={() => setEveryDiff(!allExpanded())}>{allExpanded() ? "Collapse all" : "Expand all"}</button></Show><Show when={selected() === "working" && files().length}><button disabled={actionBusy()} onClick={() => void runAction({ kind: "stage_all" })}>Stage All</button></Show></div>
            <Show when={files().length} fallback={<div class="empty-note">No files to show</div>}><Show when={showAllDiffs()} fallback={<div class="files-list"><For each={fileGroups()}>{group => <><Show when={group.title}><div class="file-group-heading">{group.title} <span>{group.items.length}</span></div></Show><For each={group.items}>{item => <button class={`file-row ${choice()?.path === item.path && choice()?.target === item.target ? "selected" : ""}`} onClick={() => void selectFile(item)}>
              <span class={`file-status ${item.status === "A" || item.status === "U" ? "added" : item.status === "D" ? "deleted" : "modified"}`}>{item.status}</span><span class="file-path">{item.path}</span><Show when={item.target === "staged"}><span class="file-tag">STAGED</span></Show><span class="file-chevron">›</span>
            </button>}</For></>}</For></div>}><div class="all-diffs"><For each={fileGroups()}>{group => <><Show when={group.title}><div class="all-diff-group">{group.title} <span>{group.items.length}</span></div></Show><For each={group.items}>{item => <DiffCard item={item} repoPath={repo()!.path} working={selected() === "working"} expanded={isDiffExpanded(item)} actionBusy={actionBusy()} scrollRoot={detailsScroll} onToggle={() => toggleDiff(item)} onAction={(operation, confirmation) => void runAction(operation, confirmation)} onError={setError} />}</For></>}</For></div></Show></Show>
            <Show when={choice() && !showAllDiffs()}><div class="diff-heading"><span>{choice()?.path}</span><span>{choice()?.target === "untracked" ? "NEW FILE" : choice()?.target === "working" ? "UNSTAGED" : choice()?.target === "staged" ? "STAGED" : choice()!.target.slice(0, 8)}</span></div>
              <Show when={selected() === "working"}><div class="file-actions"><Show when={choice()?.target === "staged"} fallback={<button disabled={actionBusy()} onClick={() => void runAction({ kind: "stage_file", value: { path: choice()!.path } })}>Stage file</button>}><button disabled={actionBusy()} onClick={() => void runAction({ kind: "unstage_file", value: { path: choice()!.path } })}>Unstage file</button></Show><Show when={choice()?.target === "working"}><button class="danger" disabled={actionBusy()} onClick={() => void runAction({ kind: "discard_file", value: { path: choice()!.path } }, `Discard changes to ${choice()!.path}?`)}>Discard changes</button></Show></div></Show>
              <Show when={diff()} fallback={<div class="empty-note">Loading diff…</div>}>{current => <DiffText value={current()} item={choice()!} working={selected() === "working"} actionBusy={actionBusy()} onAction={operation => void runAction(operation)} />}</Show>
            </Show>
          </div>
        </section>
      </main>
    </Show>
    <footer class="statusbar"><span><span class="connection-dot" /> {repo()?.path ?? "Ready"}</span><span>{actionBusy() ? "RUNNING GIT COMMAND" : busy() || searchBusy() ? "LOADING REPOSITORY" : "READY"} <i /> GITFERRY 0.1</span></footer>
    <Show when={paletteOpen()}><div class="modal-backdrop palette-backdrop" onClick={() => setPaletteOpen(false)}><div class="palette" onClick={event => event.stopPropagation()} onKeyDown={paletteKey}><input autofocus value={paletteInput()} onInput={event => setPaletteInput(event.currentTarget.value)} placeholder="Type a command…" /><div class="palette-list"><For each={paletteCommands()}>{command => <button onClick={() => { setPaletteOpen(false); command.run(); }}>{command.label}</button>}</For></div></div></div></Show>
    <Show when={showOpen()}><div class="modal-backdrop" onClick={() => setShowOpen(false)}><div class="open-modal" onClick={event => event.stopPropagation()}>
      <div class="modal-title"><span>Open repository</span><button onClick={() => setShowOpen(false)}>×</button></div>
      <div class="open-kind"><button class={openKind() === "local" ? "active" : ""} onClick={() => setOpenKind("local")}>▣ &nbsp; Local</button><button class={openKind() === "remote" ? "active" : ""} onClick={() => setOpenKind("remote")}>⌁ &nbsp; SSH host</button></div>
      <Show when={error()}><div class="modal-error">{error()}</div></Show>
      <Show when={openKind() === "local"} fallback={<div class="modal-body"><div class="eyebrow">REMOTE REPOSITORY</div><p>Connect through your system SSH configuration.</p>
        <form class="remote-form" onSubmit={event => { event.preventDefault(); void openRepo(`ssh://${hostInput()}${remotePathInput()}`); }}>
          <label>HOST<input value={hostInput()} onInput={event => setHostInput(event.currentTarget.value)} placeholder="root@warmer" /></label>
          <label>ABSOLUTE PATH<input value={remotePathInput()} onInput={event => setRemotePathInput(event.currentTarget.value)} placeholder="/srv/my-repo" /></label>
          <button type="submit" disabled={busy() || !hostInput().trim() || !remotePathInput().startsWith("/")}>{busy() ? "Connecting…" : "Connect"}</button>
        </form></div>}>
      <div class="modal-body"><div class="eyebrow">LOCAL REPOSITORY</div><p>Choose a Git working tree on this computer.</p><button class="folder-button" onClick={() => void chooseFolder()}>▣ &nbsp; Browse folders</button><div class="modal-divider">or enter a path</div><form onSubmit={event => { event.preventDefault(); void openRepo(pathInput()); }}><input autofocus value={pathInput()} onInput={event => setPathInput(event.currentTarget.value)} placeholder="C:\\path\\to\\repository" /><button type="submit" disabled={busy()}>Open</button></form></div>
      </Show>
    </div></div></Show>
  </div>;
}
export default App;
