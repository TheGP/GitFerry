// Passive refreshes keep the first visible code row at its screen position. The
// row's text and neighbours also identify it if the diff changes its DOM node.
// Sticky file headings stay pinned while their code moves, so they cannot be anchors.
const rowsSelector = ".diff-content.has-hunks .diff-line:not(.metadata):not(.hunk), .diff-content:not(.has-hunks) .diff-line";
type Anchor = { element: HTMLElement; container: HTMLElement; path?: string; target?: string; text: string; before: string; after: string; offset: number };
const pending = new WeakMap<HTMLElement, () => void>();
const code = (element: Element | null) => element?.querySelector(".line-text")?.textContent ?? "";
function neighbour(element: Element, direction: "previousElementSibling" | "nextElementSibling") {
  let next = element[direction];
  for (let count = 0; next && count < 12; count++, next = next[direction]) {
    if (next.matches(".diff-line:not(.hunk):not(.metadata)")) {
      const text = code(next);
      if (text.trim()) return text;
    }
  }
  return "";
}

function capture(root: HTMLElement): Anchor[] {
  const box = root.getBoundingClientRect(), rows = root.querySelectorAll<HTMLElement>(rowsSelector);
  let low = 0, high = rows.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (rows[middle].getBoundingClientRect().bottom <= box.top) low = middle + 1;
    else high = middle;
  }
  if (!rows[low] || rows[low].getBoundingClientRect().top >= box.bottom) return [];
  const anchors: Anchor[] = [];
  // Prefer the line being read, then a nearby surviving line if it was removed.
  for (const index of [low, low + 1, low - 1, low + 2, low - 2, low + 3]) {
    const element = rows[index];
    if (!element) continue;
    if (element.matches(".diff-line") && !code(element).trim()) continue;
    const card = element.closest<HTMLElement>(".summary-diff-card");
    anchors.push({ element, container: card ?? element.closest<HTMLElement>(".diff-content") ?? root,
      path: card?.dataset.path, target: card?.dataset.target, text: code(element),
      before: neighbour(element, "previousElementSibling"), after: neighbour(element, "nextElementSibling"),
      offset: element.getBoundingClientRect().top - box.top });
  }
  return anchors;
}

function surviving(root: HTMLElement, anchor: Anchor): HTMLElement | undefined {
  const original = root.contains(anchor.element) && code(anchor.element) === anchor.text ? anchor.element : undefined;
  if (!anchor.text) return original;
  const score = (element: Element) => Number(neighbour(element, "previousElementSibling") === anchor.before) + Number(neighbour(element, "nextElementSibling") === anchor.after);
  if (original && score(original) === 2) return original;
  const container = root.contains(anchor.container) ? anchor.container : anchor.path === undefined ? root.querySelector<HTMLElement>(".diff-content") ?? undefined
    : [...root.querySelectorAll<HTMLElement>(".summary-diff-card")].find(card => card.dataset.path === anchor.path && card.dataset.target === anchor.target);
  if (!container) return undefined;
  const matches = [...container.querySelectorAll<HTMLElement>(".diff-line")].filter(row => code(row) === anchor.text);
  if (matches.length === 1) return matches[0];
  let best = original, bestScore = original ? score(original) : 0;
  for (const row of matches) {
    const value = score(row);
    if (value > bestScore) { best = row; bestScore = value; }
  }
  return best;
}

export function cancelDiffScroll(root: HTMLElement | null | undefined) { if (root) pending.get(root)?.(); }

/** Call immediately before applying refreshed data, rather than before its async read. */
export function preserveDiffScroll<T>(root: HTMLElement | null | undefined, update: () => T): T {
  if (!root?.isConnected || pending.has(root) || !root.clientHeight || !root.clientWidth || root.scrollTop <= 0) return update();
  const anchors = capture(root);
  if (!anchors.length) return update();
  const scope = root.dataset.scrollView, overflowAnchor = root.style.getPropertyValue("overflow-anchor");
  let expectedScroll = root.scrollTop;
  let frame = 0;
  const events = ["pointerdown", "wheel", "touchstart", "keydown"] as const;
  const cancel = () => {
    if (pending.get(root) !== cancel) return;
    cancelAnimationFrame(frame);
    for (const event of events) window.removeEventListener(event, intent, true);
    root.style.setProperty("overflow-anchor", overflowAnchor);
    pending.delete(root);
  };
  const intent = (event: Event) => {
    if (event instanceof KeyboardEvent && (["Shift", "Control", "Meta", "Alt", "CapsLock"].includes(event.key)
      || (event.metaKey || event.ctrlKey) && ["c", "a"].includes(event.key.toLowerCase()))) return;
    cancel();
  };
  const restore = () => {
    if (pending.get(root) !== cancel) return;
    if (!root.isConnected || !root.clientHeight || !root.clientWidth || root.dataset.scrollView !== scope) { cancel(); return; }
    const clamped = Math.min(expectedScroll, Math.max(0, root.scrollHeight - root.clientHeight));
    // Browser clamping after a shorter diff is automatic; focus/navigation scrolling is intentional.
    if (Math.abs(root.scrollTop - expectedScroll) > 2 && Math.abs(root.scrollTop - clamped) > 2) { cancel(); return; }
    for (const anchor of anchors) {
      const element = surviving(root, anchor);
      if (!element) continue;
      root.scrollTop += element.getBoundingClientRect().top - root.getBoundingClientRect().top - anchor.offset;
      expectedScroll = root.scrollTop;
      break;
    }
  };
  pending.set(root, cancel);
  // Avoid competing with Chromium's own scroll anchor. WebKit needs the explicit anchor.
  root.style.setProperty("overflow-anchor", "none");
  for (const event of events) window.addEventListener(event, intent, { capture: true, passive: true });
  try { return update(); }
  finally {
    if (pending.get(root) === cancel) frame = requestAnimationFrame(() => {
      restore();
      // Horizontal-scroll controls can resize cards in ResizeObserver after layout.
      if (pending.get(root) === cancel) frame = requestAnimationFrame(() => { restore(); cancel(); });
    });
  }
}
