import { createEffect, createMemo, createSignal, Index, on, onCleanup, Show } from "solid-js";
import { highlightFileLines } from "./diffHighlight";
import "./fileEditor.css";

/** A hunk's changes in the new file, as 1-based lines: added lines, and lines that removed lines sat directly above. */
export type HunkMarks = { added: number[]; removed: number[] };
/** What to open: a file, the line to put the caret on and optionally the hunk to highlight. Without `commit` it is the
 * editable working-tree file; with it, the file as of that diff target (a commit or a comparison), read-only. An empty path is an empty editor. */
export type EditorTarget = { repo: string; path: string; commit?: string; line: number; marks: HunkMarks | null; nonce: number; focus?: boolean; readOnly?: boolean; revisionLabel?: string; content?: string; annotation?: { startLine: number; endLine: number; comment?: string | null } };
type EditorDoc = { source: string; original: string; text: string; newline: "\n" | "\r\n" | "\r" };

const newlineOf = (content: string): EditorDoc["newline"] => content.includes("\r\n") ? "\r\n" : content.includes("\r") ? "\r" : "\n";
const docOf = (content: string): EditorDoc => {
  const text = content.replace(/\r\n?/g, "\n");
  return { source: content, original: text, text, newline: newlineOf(content) };
};
// The file's own indentation unit: a tab, or the smallest leading run of spaces (2 by default).
function indentUnit(text: string): string {
  if (/^\t/m.test(text)) return "\t";
  let smallest = 0;
  for (const match of text.matchAll(/^( +)\S/gm)) {
    const size = match[1].length;
    if (size >= 2 && (!smallest || size < smallest)) smallest = size;
    if (smallest === 2) break;
  }
  return " ".repeat(smallest || 2);
}
/** A merge conflict as 0-based line indexes of its markers: <<<<<<< (start), optional ||||||| (base), ======= (separator), >>>>>>> (end). */
type Conflict = { start: number; base: number | null; separator: number; end: number };
function findConflicts(text: string): Conflict[] {
  const conflicts: Conflict[] = [];
  let open: Omit<Conflict, "end"> | null = null;
  text.split("\n").forEach((line, index) => {
    if (/^<{7}( |$)/.test(line)) open = { start: index, base: null, separator: -1 };
    else if (open && open.separator < 0 && /^\|{7}( |$)/.test(line)) open.base = index;
    else if (open && open.separator < 0 && /^={7}$/.test(line)) open.separator = index;
    else if (open && open.separator >= 0 && /^>{7}( |$)/.test(line)) { conflicts.push({ ...open, end: index }); open = null; }
  });
  return conflicts;
}
// execCommand keeps the textarea's native undo history; setRangeText is the fallback.
function insertText(input: HTMLTextAreaElement, text: string) {
  if (document.execCommand(text ? "insertText" : "delete", false, text)) return;
  input.setRangeText(text, input.selectionStart, input.selectionEnd, "end");
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

export function FileEditor(props: { target: EditorTarget; revision?: string; width: number; active: boolean; conflicted: boolean; onMarkResolved: (remaining: number) => void; load: (repo: string, path: string, commit?: string) => Promise<string>; save: (repo: string, path: string, content: string, expected: string) => Promise<void>; onDirty: (dirty: boolean) => void; onClose: () => void; onClearAnnotation: () => void; onResize: (event: PointerEvent) => void }) {
  let scroller!: HTMLDivElement;
  let rowsElement!: HTMLDivElement;
  let input!: HTMLTextAreaElement;
  const [doc, setDoc] = createSignal<EditorDoc | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal("");
  const [caretLine, setCaretLine] = createSignal(0);
  const [marks, setMarks] = createSignal<{ added: Set<number>; removed: Set<number> } | null>(null);
  const dirty = createMemo(() => { const current = doc(); return Boolean(current && current.text !== current.original); });
  createEffect(() => props.onDirty(dirty()));
  onCleanup(() => props.onDirty(false));
  const lines = createMemo(() => highlightFileLines(doc()?.text ?? "", props.target.path));
  const gutter = createMemo(() => `${String(lines().length).length + 3}ch`);
  const fileName = () => props.target.path.split(/[\\/]/).pop() ?? props.target.path;
  const readOnly = () => Boolean(props.target.commit) || props.target.readOnly === true;
  const revisionLabel = () => props.target.revisionLabel ?? props.target.commit?.split("..").map(part => part.slice(0, 8)).join("..") ?? "Working tree";
  // The editor stays open across repository tabs; a tab other than the file's own shows it empty (the file stays loaded).
  const shown = () => props.active && Boolean(props.target.path);
  const conflicts = createMemo(() => findConflicts(doc()?.text ?? ""));
  const conflictAt = createMemo(() => new Map(conflicts().map(item => [item.start, item])));
  // Per line: which part of a conflict it is (markers, the current side, the common base, the incoming side).
  const conflictClasses = createMemo(() => {
    const classes: string[] = [];
    for (const { start, base, separator, end } of conflicts()) {
      for (let index = start + 1; index < (base ?? separator); index++) classes[index] = "conflict-current";
      if (base !== null) for (let index = base + 1; index < separator; index++) classes[index] = "conflict-base";
      for (let index = separator + 1; index < end; index++) classes[index] = "conflict-incoming";
      classes[start] = "conflict-marker conflict-marker-current";
      if (base !== null) classes[base] = "conflict-marker";
      classes[separator] = "conflict-marker";
      classes[end] = "conflict-marker conflict-marker-incoming";
    }
    return classes;
  });
  const crumbs = () => props.target.path.split(/[\\/]/);
  let loadId = 0;
  onCleanup(() => { loadId++; });

  async function load(keepView: boolean) {
    const { repo, path, commit } = props.target;
    const id = ++loadId;
    if (!path) { setDoc(null); setLoading(false); setError(""); return; }
    setLoading(!keepView); setError("");
    try {
      const content = !keepView && props.target.content !== undefined ? props.target.content : await props.load(repo, path, commit);
      // Edits typed while a background reload was in flight win over the reloaded content.
      if (id !== loadId || (keepView && dirty())) return;
      if (!keepView) { setDoc(docOf(content)); reveal(); return; }
      const top = scroller.scrollTop;
      const caret = [input.selectionStart, input.selectionEnd] as const;
      setDoc(docOf(content));
      input.setSelectionRange(...caret);
      scroller.scrollTop = top;
    } catch (cause) { if (id === loadId) setError(String(cause)); }
    finally { if (id === loadId) setLoading(false); }
  }
  // Scrolls the target line to the upper third, puts the caret at its start and highlights the hunk.
  function reveal() {
    const text = doc()?.text;
    if (text === undefined) return;
    // Line 0 asks for the first conflict (or the top of the file).
    const line = Math.max(1, Math.min(props.target.line || (conflicts()[0]?.start ?? 0) + 1, lines().length));
    const target = props.target.marks;
    // A removal at the very end of the file marks the last line.
    setMarks(target && { added: new Set(target.added), removed: new Set(target.removed.map(item => Math.min(item, lines().length))) });
    const firstLine = target ? Math.min(...target.added, ...target.removed) : Infinity;
    requestAnimationFrame(() => {
      const row = rowsElement.children[line - 1] as HTMLElement | undefined;
      const first = Number.isFinite(firstLine) ? rowsElement.children[firstLine - 1] as HTMLElement | undefined : undefined;
      if (row) {
        // Keep the whole hunk in view when it fits, otherwise start at the double-clicked line.
        const anchor = first && row.offsetTop - first.offsetTop < scroller.clientHeight * 0.6 ? first : row;
        scroller.scrollTop = Math.max(0, anchor.offsetTop - scroller.clientHeight / 4);
      }
      let offset = 0;
      for (let index = 1; index < line; index++) offset = text.indexOf("\n", offset) + 1;
      // Opening from a diff double-click keeps the word selected there for copying.
      if (props.target.focus !== false) input.focus({ preventScroll: true });
      input.setSelectionRange(offset, offset);
      updateCaret();
    });
  }
  createEffect(on(() => `${props.target.repo}\u0000${props.target.path}\u0000${props.target.commit ?? ""}\u0000${props.target.content === undefined ? "" : props.target.nonce}`, () => { setDoc(null); setMarks(null); void load(false); }));
  createEffect(on(() => props.target.nonce, () => { if (doc()) reveal(); }, { defer: true }));
  // The file changed on disk (a discard, a checkout, another editor): pick it up unless there are unsaved edits.
  createEffect(on(() => props.revision, () => { if (doc() && !readOnly() && !dirty() && !saving()) void load(true); }, { defer: true }));

  function updateCaret() {
    const text = doc()?.text ?? "";
    let line = 0;
    for (let index = text.indexOf("\n"); index >= 0 && index < input.selectionStart; index = text.indexOf("\n", index + 1)) line++;
    setCaretLine(line);
  }
  const onSelectionChange = () => { if (document.activeElement === input) updateCaret(); };
  document.addEventListener("selectionchange", onSelectionChange);
  onCleanup(() => document.removeEventListener("selectionchange", onSelectionChange));

  async function save() {
    const current = doc();
    if (!current || !dirty() || saving() || readOnly()) return;
    const id = loadId;
    const { repo, path } = props.target;
    setSaving(true); setError("");
    const content = current.newline === "\n" ? current.text : current.text.replace(/\n/g, current.newline);
    try {
      await props.save(repo, path, content, current.source);
      if (id === loadId) setDoc(value => value && { ...value, source: content, original: current.text });
    } catch (cause) { if (id === loadId) setError(String(cause)); }
    finally { setSaving(false); }
  }

  // Replaces a conflict (markers included) with one side or both, as one undoable edit.
  function resolveConflict(conflict: Conflict, choice: "current" | "incoming" | "both") {
    const text = input.value;
    const fileLines = text.split("\n");
    const current = fileLines.slice(conflict.start + 1, conflict.base ?? conflict.separator);
    const incoming = fileLines.slice(conflict.separator + 1, conflict.end);
    const kept = choice === "current" ? current : choice === "incoming" ? incoming : [...current, ...incoming];
    let start = 0;
    for (let index = 0; index < conflict.start; index++) start += fileLines[index].length + 1;
    let end = start;
    for (let index = conflict.start; index <= conflict.end; index++) end += fileLines[index].length + 1;
    const last = end > text.length;
    input.focus({ preventScroll: true });
    input.setSelectionRange(start, Math.min(end, text.length));
    insertText(input, kept.length ? kept.join("\n") + (last ? "" : "\n") : "");
  }
  function nextConflict() {
    const next = conflicts().find(item => item.start > caretLine()) ?? conflicts()[0];
    if (!next) return;
    const row = rowsElement.children[next.start] as HTMLElement | undefined;
    if (row) scroller.scrollTop = Math.max(0, row.offsetTop - scroller.clientHeight / 4);
    const text = input.value;
    let offset = 0;
    for (let index = 0; index < next.start; index++) offset = text.indexOf("\n", offset) + 1;
    input.focus({ preventScroll: true });
    input.setSelectionRange(offset, offset);
    updateCaret();
  }
  // Saves pending edits first; the caller stages the file (and asks first if conflict markers remain).
  async function markResolved() {
    const id = loadId;
    if (dirty()) { await save(); if (dirty()) return; }
    if (id !== loadId || !props.active) return;
    props.onMarkResolved(conflicts().length);
  }

  function indent(outdent: boolean) {
    const text = input.value;
    const unit = indentUnit(text);
    const start = input.selectionStart, end = input.selectionEnd;
    if (!outdent && !text.slice(start, end).includes("\n")) { insertText(input, unit); return; }
    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    const lineEnd = end > start && text[end - 1] === "\n" ? end - 1 : end;
    const block = text.slice(lineStart, lineEnd);
    const changed = block.split("\n").map(line => outdent ? line.replace(unit === "\t" ? /^\t/ : new RegExp(`^ {1,${unit.length}}`), "") : line ? unit + line : line).join("\n");
    if (changed === block) return;
    input.setSelectionRange(lineStart, lineEnd);
    insertText(input, changed);
    input.setSelectionRange(lineStart, lineStart + changed.length);
  }
  function onKeyDown(event: KeyboardEvent) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); event.stopPropagation(); void save(); return; }
    if (event.key === "Escape" && !dirty()) { event.preventDefault(); props.onClose(); return; }
    if (readOnly()) return;
    if (event.key === "Tab" && !event.ctrlKey && !event.altKey) { event.preventDefault(); indent(event.shiftKey); return; }
    if (event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing) {
      const text = input.value;
      const lineStart = text.lastIndexOf("\n", input.selectionStart - 1) + 1;
      const leading = /^[ \t]*/.exec(text.slice(lineStart, input.selectionStart))?.[0] ?? "";
      event.preventDefault();
      insertText(input, `\n${leading}`);
    }
  }

  const isAdded = (index: number) => Boolean(marks()?.added.has(index + 1));
  const removedAbove = (index: number) => Boolean(marks()?.removed.has(index + 1));
  const isHighlighted = (index: number) => Boolean(props.target.annotation && index + 1 >= props.target.annotation.startLine && index + 1 <= props.target.annotation.endLine);
  return <>
    <div class="splitter editor-splitter" onPointerDown={event => props.onResize(event)} />
    <aside class="editor-pane" style={{ width: `${props.width}px` }} aria-label={shown() ? `Editor for ${props.target.path}` : "Editor"}>
      <div class="editor-tabs"><div class={`editor-tab ${shown() ? "" : "empty"}`} title={shown() ? props.target.path : undefined}><span class="editor-tab-name">{shown() ? fileName() : "No file"}</span><Show when={dirty()} fallback={<button class="editor-tab-close" title="Close editor (Esc)" aria-label="Close editor" onClick={props.onClose}>×</button>}><button class="editor-tab-close dirty" title="Unsaved changes. Close editor" aria-label="Close editor" onClick={props.onClose}><span class="dirty-dot" /></button></Show></div>
        <div class="editor-tabs-actions"><Show when={shown() && !readOnly() && conflicts().length}><button class="editor-conflict-count" title="Go to the next conflict" onClick={nextConflict}>{conflicts().length} conflict{conflicts().length === 1 ? "" : "s"}</button></Show><Show when={shown() && props.conflicted && !readOnly()}><button class="editor-mark-resolved" disabled={saving()} title="Save and stage the file as resolved" onClick={() => void markResolved()}>Mark resolved</button></Show><Show when={shown()}><Show when={readOnly()} fallback={<button class="editor-save" disabled={!dirty() || saving()} title="Save (Ctrl+S)" onClick={() => void save()}>{saving() ? "Saving…" : "Save"}</button>}><span class="editor-commit" title={`As of ${props.target.commit ?? "working tree"}`}>{revisionLabel()} · read-only</span></Show></Show></div></div>
      <Show when={!shown()}><div class="editor-empty">Double-click a line in a diff to open its file here.<Show when={dirty() && props.target.path}><span class="editor-empty-dirty">Unsaved edits to {fileName()} in another repository tab.</span></Show></div></Show>
      <div class="editor-breadcrumbs" style={{ display: shown() ? undefined : "none" }} title={props.target.path}><Index each={crumbs()}>{(part, index) => <><Show when={index}><span class="editor-crumb-separator">›</span></Show><span class={index === crumbs().length - 1 ? "editor-crumb-file" : ""}>{part()}</span></>}</Index></div>
      <Show when={shown() && props.target.annotation}>{annotation => <section class="editor-annotation" aria-label="AI explanation"><div class="editor-annotation-heading"><span>AI · Lines {annotation().startLine}{annotation().endLine !== annotation().startLine ? `–${annotation().endLine}` : ""}</span><button title="Clear AI highlights" onClick={props.onClearAnnotation}>×</button></div><Show when={annotation().comment}><p>{annotation().comment}</p></Show></section>}</Show>
      <Show when={shown() && error()}>{message => <div class="editor-error">{message()}</div>}</Show>
      <div class="editor-scroll" ref={scroller} style={{ display: shown() ? undefined : "none" }}>
        <Show when={doc()} fallback={<div class="empty-note">{loading() ? "Loading file…" : error() ? "" : "No file loaded"}</div>}>
          <div class="editor-body" style={{ "--editor-gutter": gutter() }}>
            <div class="editor-rows" ref={rowsElement}><Index each={lines()}>{(html, index) => <div class={`editor-row ${index === caretLine() ? "caret" : ""} ${isAdded(index) ? "added" : ""} ${removedAbove(index) ? "removed-above" : ""} ${isHighlighted(index) ? "ai-highlight" : ""} ${conflictClasses()[index] ?? ""}`}><span class="editor-line-number">{index + 1}</span><span class="editor-code" innerHTML={html()} /><Show when={!readOnly() && conflictAt().get(index)}>{conflict => <span class="editor-conflict-actions"><button onMouseDown={event => event.preventDefault()} onClick={() => resolveConflict(conflict(), "current")}>Accept current</button><button onMouseDown={event => event.preventDefault()} onClick={() => resolveConflict(conflict(), "incoming")}>Accept incoming</button><button onMouseDown={event => event.preventDefault()} onClick={() => resolveConflict(conflict(), "both")}>Accept both</button></span>}</Show></div>}</Index></div>
            <textarea class="editor-input" ref={input} aria-label={`Edit ${props.target.path}`} spellcheck={false} autocapitalize="off" autocomplete="off" wrap="soft" rows={1} cols={1} readOnly={saving() || readOnly()} value={doc()?.text ?? ""} onInput={event => {
              const text = event.currentTarget.value;
              const before = lines().length;
              setDoc(value => value && { ...value, text });
              // Added or removed lines shift the highlighted hunk off its lines.
              if (lines().length !== before) setMarks(null);
              updateCaret();
            }} onKeyDown={onKeyDown} onFocus={updateCaret} />
          </div>
        </Show>
      </div>
      <div class="editor-status" style={{ display: shown() ? undefined : "none" }}><span>Ln {caretLine() + 1}</span><span>{readOnly() ? "Read-only" : saving() ? "Saving…" : dirty() ? "Unsaved · Ctrl+S to save" : "Saved to working tree"}</span></div>
    </aside>
  </>;
}
