import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { findIgnored, pageMatches, pageMatchRects, revealPageMatch, selectPageMatch, type MatchRect, type PageMatch } from "./findInPage";

export function FindBar() {
  const [open, setOpen] = createSignal(false), [query, setQuery] = createSignal("");
  const [matches, setMatches] = createSignal<PageMatch[]>([]), [index, setIndex] = createSignal(0), [rects, setRects] = createSignal<MatchRect[]>([]);
  let input!: HTMLInputElement, origin: HTMLElement | null = null, originOffset = 0;
  let timer: ReturnType<typeof setTimeout> | undefined, frame = 0;
  const selected = () => matches()[index()];
  const draw = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => setRects(open() && selected() ? pageMatchRects(selected()) : [])); };
  function refresh(navigate = false) {
    clearTimeout(timer);
    if (!open()) return;
    const previous = selected(), next = pageMatches(document.body, query());
    const kept = previous ? next.findIndex(item => item.surface.anchor === previous.surface.anchor && item.start === previous.start && item.end === previous.end) : -1;
    const nearby = next.findIndex(item => item.surface.anchor === origin && item.start >= originOffset);
    setMatches(next); setIndex(navigate ? Math.max(0, nearby) : kept >= 0 ? kept : Math.min(index(), Math.max(0, next.length - 1)));
    if (navigate && selected()) revealPageMatch(selected());
    draw();
  }
  function move(direction: number) {
    refresh();
    if (matches().length) { setIndex(value => (value + direction + matches().length) % matches().length); revealPageMatch(selected()); draw(); }
  }
  function close() {
    const match = selected();
    setOpen(false); setRects([]); clearTimeout(timer);
    if (match) selectPageMatch(match);
    if (match?.surface.input) match.surface.input.focus({ preventScroll: true });
    else if (!match && origin?.isConnected) origin.focus({ preventScroll: true });
  }
  function show() {
    if (!open()) {
      origin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      originOffset = origin instanceof HTMLTextAreaElement ? origin.selectionStart : 0;
      const selection = origin instanceof HTMLTextAreaElement ? origin.value.slice(origin.selectionStart, origin.selectionEnd) : origin instanceof HTMLInputElement ? "" : window.getSelection()?.toString() ?? "";
      if (selection && !/[\r\n]/.test(selection) && selection.length <= 512) setQuery(selection);
      setOpen(true); refresh(true);
    }
    requestAnimationFrame(() => { input.focus(); input.select(); });
  }
  onMount(() => {
    const keys = (event: KeyboardEvent) => {
      if (event.isComposing || event.altKey) return;
      const command = event.ctrlKey || event.metaKey, key = event.key.toLowerCase();
      if (command && key === "f") { event.preventDefault(); event.stopPropagation(); show(); return; }
      if (!open()) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
      else if (event.key === "F3" || command && key === "g" || event.key === "Enter" && findIgnored(event.target as Node)) { event.preventDefault(); event.stopPropagation(); move(event.shiftKey ? -1 : 1); }
    };
    const changed = () => { if (open()) { clearTimeout(timer); timer = setTimeout(() => refresh(), 80); } };
    const observer = new MutationObserver(records => {
      if (records.some(record => !findIgnored(record.target) && !(record.type === "childList" && [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)].every(findIgnored)))) changed();
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["class", "style", "hidden"] });
    const edited = (event: Event) => { if (!findIgnored(event.target as Node)) changed(); };
    window.addEventListener("keydown", keys, true); window.addEventListener("scroll", draw, true); window.addEventListener("resize", draw); document.addEventListener("input", edited, true);
    onCleanup(() => { observer.disconnect(); clearTimeout(timer); cancelAnimationFrame(frame); window.removeEventListener("keydown", keys, true); window.removeEventListener("scroll", draw, true); window.removeEventListener("resize", draw); document.removeEventListener("input", edited, true); });
  });
  return <div class="find-layer" data-find-ignore>
    <Show when={open()}>
      <section class="find-bar" role="search" aria-label="Find in view">
        <input ref={input} type="search" aria-label="Find in view" placeholder="Find in view" value={query()} onInput={event => { setQuery(event.currentTarget.value); refresh(true); }} />
        <span class="find-count" role="status" aria-live="polite">{matches().length ? `${index() + 1} of ${matches().length}` : query() ? "No matches" : ""}</span>
        <button disabled={!matches().length} aria-label="Previous match" title="Previous match (Shift+Enter)" onClick={() => move(-1)}>↑</button>
        <button disabled={!matches().length} aria-label="Next match" title="Next match (Enter)" onClick={() => move(1)}>↓</button>
        <button aria-label="Close find" title="Close find (Esc)" onClick={close}>×</button>
      </section>
      <For each={rects()}>{rect => <div class="find-highlight" aria-hidden="true" style={{ left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` }} />}</For>
    </Show>
  </div>;
}
