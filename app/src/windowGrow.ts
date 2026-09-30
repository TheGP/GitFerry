import { isTauri } from "@tauri-apps/api/core";
import { currentMonitor, getCurrentWindow, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/window";

// How much the window was widened (and moved left to stay on screen), so shrinking can undo exactly that. It is saved
// because the window keeps its widened size across restarts (the editor reopens with it) and can still be narrowed later.
const grownKey = "gitferry.windowGrown";
let grown = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(grownKey) ?? "null");
    if (Number.isFinite(saved?.width) && Number.isFinite(saved?.shift)) return { width: Number(saved.width), shift: Number(saved.shift) };
  } catch { /* Ignore an invalid saved value. */ }
  return { width: 0, shift: 0 };
})();
function setGrown(value: { width: number; shift: number }) {
  grown = value;
  if (value.width) localStorage.setItem(grownKey, JSON.stringify(value)); else localStorage.removeItem(grownKey);
}
// Grow and shrink calls run one after another so a quick open/close cannot interleave.
let queue = Promise.resolve();
const enqueue = (task: () => Promise<void>) => { queue = queue.then(task).catch(() => {}); return queue; };
// Resolves once the page has laid out at the new window size (or after a short timeout if no resize arrives).
function nextResize(): Promise<void> {
  return new Promise(resolve => {
    const done = () => { window.clearTimeout(timer); window.removeEventListener("resize", done); requestAnimationFrame(() => resolve()); };
    const timer = window.setTimeout(done, 300);
    window.addEventListener("resize", done);
  });
}

/** Forgets a saved widening when the editor it was for did not come back (e.g. after a crash), so the next open widens again. */
export function forgetWindowGrowth() { setGrown({ width: 0, shift: 0 }); }

/** Widens the window to the right by `extra` CSS pixels so side content can open without squeezing the rest. A maximized window stays as it is. */
export function growWindow(extra: number): Promise<void> {
  return enqueue(async () => {
    if (!isTauri() || grown.width) return;
    const appWindow = getCurrentWindow();
    if (await appWindow.isMaximized() || await appWindow.isFullscreen()) return;
    const [scale, inner, outer, position, monitor] = await Promise.all([appWindow.scaleFactor(), appWindow.innerSize(), appWindow.outerSize(), appWindow.outerPosition(), currentMonitor()]);
    let width = Math.round(extra * scale);
    let x = position.x;
    if (monitor) {
      const area = monitor.workArea;
      width = Math.max(0, Math.min(width, area.size.width - outer.width));
      const right = area.position.x + area.size.width;
      if (x + outer.width + width > right) x = Math.max(area.position.x, right - outer.width - width);
    }
    if (!width) return;
    if (x !== position.x) await appWindow.setPosition(new PhysicalPosition(x, position.y));
    const resized = nextResize();
    await appWindow.setSize(new PhysicalSize(inner.width + width, inner.height));
    await resized;
    setGrown({ width, shift: position.x - x });
  });
}

/** Undoes growWindow: narrows the window again and moves it back if it had to shift left. */
export function shrinkWindow(): Promise<void> {
  return enqueue(async () => {
    if (!isTauri() || !grown.width) return;
    const { width, shift } = grown;
    setGrown({ width: 0, shift: 0 });
    const appWindow = getCurrentWindow();
    if (await appWindow.isMaximized() || await appWindow.isFullscreen()) return;
    const [inner, position] = await Promise.all([appWindow.innerSize(), appWindow.outerPosition()]);
    const resized = nextResize();
    await appWindow.setSize(new PhysicalSize(Math.max(400, inner.width - width), inner.height));
    await resized;
    if (shift) await appWindow.setPosition(new PhysicalPosition(position.x + shift, position.y));
  });
}
