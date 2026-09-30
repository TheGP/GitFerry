import { createEffect, createMemo, createSignal, Index, on, onCleanup, Show } from "solid-js";
import { highlightFileLines } from "./diffHighlight";
import "./fileEditor.css";

/** A hunk's changes in the new file, as 1-based lines: added lines, and lines that removed lines sat directly above. */
export type HunkMarks = { added: number[]; removed: number[] };
/** What to open: a working-tree file, the line to put the caret on and optionally the hunk to highlight. */
export type EditorTarget = { repo: string; path: string; line: number; marks: HunkMarks | null; nonce: number };
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
// execCommand keeps the textarea's native undo history; setRangeText is the fallback.
function insertText(input: HTMLTextAreaElement, text: string) {
  if (document.execCommand("insertText", false, text)) return;
  input.setRangeText(text, input.selectionStart, input.selectionEnd, "end");
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

export function FileEditor(props: { target: EditorTarget; revision?: string; width: number; hidden: boolean; load: (repo: string, path: string) => Promise<string>; save: (repo: string, path: string, content: string, expected: string) => Promise<void>; onDirty: (dirty: boolean) => void; onClose: () => void; onResize: (event: PointerEvent) => void }) {
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
  const crumbs = () => props.target.path.split(/[\\/]/);
  let loadId = 0;

  async function load(keepView: boolean) {
    const { repo, path } = props.target;
    const id = ++loadId;
    setLoading(!keepView); setError("");
    try {
      const content = await props.load(repo, path);
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
    const line = Math.max(1, Math.min(props.target.line, lines().length));
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
      input.focus({ preventScroll: true });
      input.setSelectionRange(offset, offset);
      updateCaret();
    });
  }
  createEffect(on(() => `${props.target.repo}\u0000${props.target.path}`, () => { setDoc(null); void load(false); }));
  createEffect(on(() => props.target.nonce, () => { if (doc()) reveal(); }, { defer: true }));
  // The file changed on disk (a discard, a checkout, another editor): pick it up unless there are unsaved edits.
  createEffect(on(() => props.revision, () => { if (doc() && !dirty() && !saving()) void load(true); }, { defer: true }));

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
    if (!current || !dirty() || saving()) return;
    setSaving(true); setError("");
    const content = current.newline === "\n" ? current.text : current.text.replace(/\n/g, current.newline);
    try {
      await props.save(props.target.repo, props.target.path, content, current.source);
      setDoc(value => value && { ...value, source: content, original: current.text });
    } catch (cause) { setError(String(cause)); }
    finally { setSaving(false); }
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
  return <>
    <div class="splitter editor-splitter" style={{ display: props.hidden ? "none" : undefined }} onPointerDown={event => props.onResize(event)} />
    <aside class="editor-pane" style={{ width: `${props.width}px`, display: props.hidden ? "none" : undefined }} aria-label={`Editor for ${props.target.path}`}>
      <div class="editor-tabs"><div class="editor-tab" title={props.target.path}><span class="editor-tab-name">{fileName()}</span><Show when={dirty()} fallback={<button class="editor-tab-close" title="Close editor (Esc)" aria-label="Close editor" onClick={props.onClose}>×</button>}><button class="editor-tab-close dirty" title="Unsaved changes. Close editor" aria-label="Close editor" onClick={props.onClose}><span class="dirty-dot" /></button></Show></div>
        <div class="editor-tabs-actions"><button class="editor-save" disabled={!dirty() || saving()} title="Save (Ctrl+S)" onClick={() => void save()}>{saving() ? "Saving…" : "Save"}</button></div></div>
      <div class="editor-breadcrumbs" title={props.target.path}><Index each={crumbs()}>{(part, index) => <><Show when={index}><span class="editor-crumb-separator">›</span></Show><span class={index === crumbs().length - 1 ? "editor-crumb-file" : ""}>{part()}</span></>}</Index></div>
      <Show when={error()}>{message => <div class="editor-error">{message()}</div>}</Show>
      <div class="editor-scroll" ref={scroller}>
        <Show when={doc()} fallback={<div class="empty-note">{loading() ? "Loading file…" : error() ? "" : "No file loaded"}</div>}>
          <div class="editor-body" style={{ "--editor-gutter": gutter() }}>
            <div class="editor-rows" ref={rowsElement} aria-hidden="true"><Index each={lines()}>{(html, index) => <div class={`editor-row ${index === caretLine() ? "caret" : ""} ${isAdded(index) ? "added" : ""} ${removedAbove(index) ? "removed-above" : ""}`}><span class="editor-line-number">{index + 1}</span><span class="editor-code" innerHTML={html()} /></div>}</Index></div>
            <textarea class="editor-input" ref={input} aria-label={`Edit ${props.target.path}`} spellcheck={false} autocapitalize="off" autocomplete="off" wrap="soft" rows={1} cols={1} readOnly={saving()} value={doc()?.text ?? ""} onInput={event => {
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
      <div class="editor-status"><span>Ln {caretLine() + 1}</span><span>{saving() ? "Saving…" : dirty() ? "Unsaved · Ctrl+S to save" : "Saved to working tree"}</span></div>
    </aside>
  </>;
}
