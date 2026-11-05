export type TextMatch = { start: number; end: number };

/** Literal, case-insensitive matches with offsets in the original UTF-16 text. */
export function textMatches(text: string, query: string): TextMatch[] {
  if (!query) return [];
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
  return Array.from(text.matchAll(pattern), match => ({ start: match.index, end: match.index + match[0].length }));
}

type Surface = { anchor: HTMLElement; text: string; nodes?: Text[]; input?: HTMLTextAreaElement };
export type PageMatch = TextMatch & { surface: Surface };
export type MatchRect = { left: number; top: number; width: number; height: number };

export const findIgnored = (node: Node) => Boolean((node instanceof Element ? node : node.parentElement)?.closest("[data-find-ignore]"));

/** Search rendered text once, without counting the editor's syntax layer twice. */
export function pageMatches(root: HTMLElement, query: string): PageMatch[] {
  if (!query) return [];
  const surfaces: Surface[] = [];
  const blocks = new Map<Element, HTMLElement>();
  const block = (element: HTMLElement): HTMLElement => {
    const cached = blocks.get(element);
    if (cached) return cached;
    const display = getComputedStyle(element).display;
    const result = element.parentElement && (display === "inline" || display === "contents") ? block(element.parentElement) : element;
    blocks.set(element, result);
    return result;
  };
  const visible = (element: HTMLElement) => element.getClientRects().length > 0 && getComputedStyle(element).visibility === "visible";
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const element = node instanceof HTMLElement ? node : node.parentElement;
    if (!element || element.closest("[data-find-ignore], script, style, noscript, .editor-rows") || !visible(element)) continue;
    if (node instanceof HTMLTextAreaElement) {
      surfaces.push({ anchor: node, text: node.value, input: node });
    } else if (node instanceof Text && !element.closest("textarea, select")) {
      const anchor = block(element), previous = surfaces[surfaces.length - 1];
      if (previous?.anchor === anchor && previous.nodes) { previous.nodes.push(node); previous.text += node.data; }
      else surfaces.push({ anchor, text: node.data, nodes: [node] });
    }
  }
  return surfaces.flatMap(surface => textMatches(surface.text, query).map(match => ({ ...match, surface })));
}

function textRects(nodes: Text[], start: number, end: number): DOMRect[] {
  const rects: DOMRect[] = [];
  let offset = 0;
  for (const node of nodes) {
    const next = offset + node.length;
    if (end > offset && start < next && node.isConnected) {
      const range = document.createRange();
      range.setStart(node, Math.max(0, start - offset)); range.setEnd(node, Math.min(node.length, end - offset));
      rects.push(...Array.from(range.getClientRects()));
    }
    offset = next;
    if (offset >= end) break;
  }
  return rects.filter(rect => rect.width > 0 && rect.height > 0);
}

function inputRects(input: HTMLTextAreaElement, start: number, end: number): DOMRect[] {
  const editor = input.closest(".editor-body");
  if (editor) {
    const lineStart = input.value.lastIndexOf("\n", start - 1) + 1;
    const line = input.value.slice(0, lineStart).split("\n").length - 1;
    const code = editor.querySelector(".editor-rows")?.children[line]?.querySelector(".editor-code");
    if (!code) return [];
    const nodes: Text[] = [], walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
    return textRects(nodes, start - lineStart, end - lineStart);
  }
  // Plain textareas have no syntax layer. Measure a hidden mirror with the same wrapping,
  // padding and scroll offsets; the real value, undo history and document remain untouched.
  const mirror = document.createElement("div"), style = getComputedStyle(input), box = input.getBoundingClientRect();
  mirror.dataset.findIgnore = "";
  for (const property of ["box-sizing", "font", "line-height", "letter-spacing", "word-spacing", "text-indent", "text-align", "tab-size", "direction", "padding", "border-width", "border-style", "word-break", "overflow-wrap"]) mirror.style.setProperty(property, style.getPropertyValue(property));
  Object.assign(mirror.style, { position: "fixed", visibility: "hidden", pointerEvents: "none", width: `${box.width}px`, left: `${box.left - input.scrollLeft}px`, top: `${box.top - input.scrollTop}px`, whiteSpace: input.wrap === "off" ? "pre" : style.whiteSpace });
  const node = document.createTextNode(input.value);
  mirror.append(node); document.body.append(mirror);
  try { return textRects([node], start, end); }
  finally { mirror.remove(); }
}

const rawRects = (match: PageMatch) => match.surface.input ? inputRects(match.surface.input, match.start, match.end) : textRects(match.surface.nodes ?? [], match.start, match.end);

export function selectPageMatch(match: PageMatch) {
  if (match.surface.input) { match.surface.input.setSelectionRange(match.start, match.end); return; }
  const range = document.createRange();
  let offset = 0, started = false;
  for (const node of match.surface.nodes ?? []) {
    if (!node.isConnected) return;
    const end = offset + node.length;
    if (!started && match.start < end) { range.setStart(node, match.start - offset); started = true; }
    if (started && match.end <= end) {
      range.setEnd(node, match.end - offset);
      const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
      return;
    }
    offset = end;
  }
}

export function revealPageMatch(match: PageMatch) {
  const input = match.surface.input;
  if (input) {
    selectPageMatch(match);
    if (!input.closest(".editor-body")) {
      const rect = rawRects(match)[0], box = input.getBoundingClientRect();
      if (rect) {
        if (rect.top < box.top || rect.bottom > box.bottom) input.scrollTop += rect.top - box.top - input.clientHeight / 3;
        if (rect.left < box.left || rect.right > box.right) input.scrollLeft += rect.left - box.left - input.clientWidth / 3;
      }
    }
  }
  // Selecting a DOM Range can move browser focus away from the find input while it is being
  // typed. The overlay marks ordinary text; close() installs its copyable selection afterwards.
  for (let parent = match.surface.anchor.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent), rect = rawRects(match)[0], box = parent.getBoundingClientRect();
    if (!rect) break;
    if (/auto|scroll/.test(style.overflowY) && (rect.top < box.top || rect.bottom > box.bottom)) parent.scrollTop += rect.top - box.top - parent.clientHeight / 3;
    if (/auto|scroll/.test(style.overflowX) && (rect.left < box.left || rect.right > box.right)) parent.scrollLeft += rect.left - box.left - parent.clientWidth / 3;
  }
}

/** Clip highlights to the same scroll containers as the matched text. */
export function pageMatchRects(match: PageMatch): MatchRect[] {
  if (!match.surface.anchor.isConnected) return [];
  const clip = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  for (let parent: HTMLElement | null = match.surface.anchor; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent), box = parent.getBoundingClientRect();
    if (/auto|scroll|hidden|clip/.test(style.overflowX)) { clip.left = Math.max(clip.left, box.left + parent.clientLeft); clip.right = Math.min(clip.right, box.left + parent.clientLeft + parent.clientWidth); }
    if (/auto|scroll|hidden|clip/.test(style.overflowY)) { clip.top = Math.max(clip.top, box.top + parent.clientTop); clip.bottom = Math.min(clip.bottom, box.top + parent.clientTop + parent.clientHeight); }
  }
  return rawRects(match).map(rect => ({ left: Math.max(rect.left, clip.left), top: Math.max(rect.top, clip.top), width: Math.min(rect.right, clip.right) - Math.max(rect.left, clip.left), height: Math.min(rect.bottom, clip.bottom) - Math.max(rect.top, clip.top) })).filter(rect => rect.width > 0 && rect.height > 0);
}
