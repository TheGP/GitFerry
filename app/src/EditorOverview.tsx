import { createEffect, createSignal, For, onCleanup } from "solid-js";
import type { EditorChange } from "./editorChanges";

/** A separate rail keeps native scrollbars and the textarea/syntax layer in sync, including wrapped lines. */
export function EditorOverview(props: { changes: EditorChange[]; scroller: HTMLDivElement; rows: HTMLDivElement; error: string; onNavigate: (line: number) => void }) {
  const [markers, setMarkers] = createSignal<(EditorChange & { top: number; height: number })[]>([]);
  const [viewport, setViewport] = createSignal({ top: 0, height: 100 });
  let frame = 0;
  function updateViewport() {
    const scroll = props.scroller;
    const total = Math.max(scroll.scrollHeight, 1);
    setViewport({ top: scroll.scrollTop / total * 100, height: scroll.clientHeight / total * 100 });
  }
  function measure() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const scroll = props.scroller, rows = props.rows;
      const total = Math.max(scroll.scrollHeight, 1);
      const minimum = Math.min(100, 3 / Math.max(1, scroll.clientHeight) * 100);
      setMarkers(props.changes.flatMap(change => {
        const first = rows.children[change.startLine - 1] as HTMLElement | undefined;
        const last = rows.children[change.endLine - 1] as HTMLElement | undefined;
        if (!first || !last) return [];
        const height = Math.max(minimum, (change.kind === "removed" ? 0 : last.offsetTop + last.offsetHeight - first.offsetTop) / total * 100);
        return [{ ...change, top: Math.min(100 - height, first.offsetTop / total * 100), height }];
      }));
      updateViewport();
    });
  }
  createEffect(() => {
    const scroll = props.scroller, rows = props.rows;
    const observer = new ResizeObserver(measure);
    observer.observe(scroll); observer.observe(rows);
    scroll.addEventListener("scroll", updateViewport, { passive: true });
    measure();
    onCleanup(() => { observer.disconnect(); scroll.removeEventListener("scroll", updateViewport); cancelAnimationFrame(frame); });
  });
  createEffect(() => { props.changes; measure(); });
  const label = (change: EditorChange) => `${change.kind === "added" ? "Added" : change.kind === "modified" ? "Modified" : "Deleted"} ${change.kind === "removed" ? "near line" : change.startLine === change.endLine ? "line" : "lines"} ${change.startLine}${change.endLine > change.startLine ? `–${change.endLine}` : ""}`;
  return <nav class="editor-overview" aria-label="File changes" title={props.error || "Changes compared with the base revision. Click a marker to scroll to its code."}>
    <div class="editor-overview-viewport" style={{ top: `${viewport().top}%`, height: `${viewport().height}%` }} />
    <For each={markers()}>{marker => <button class={`editor-overview-marker ${marker.kind}`} style={{ top: `${marker.top}%`, height: `${marker.height}%` }} aria-label={label(marker)} title={label(marker)} onMouseDown={event => event.preventDefault()} onClick={() => props.onNavigate(marker.startLine)} />}</For>
  </nav>;
}
