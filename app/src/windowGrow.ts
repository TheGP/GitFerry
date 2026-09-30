import { isTauri } from "@tauri-apps/api/core";
import { currentMonitor, getCurrentWindow, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/window";

// How much the window was widened (and moved left to stay on screen), so shrinking can undo exactly that.
let grown = { width: 0, shift: 0 };
// Grow and shrink calls run one after another so a quick open/close cannot interleave.
let queue = Promise.resolve();
const enqueue = (task: () => Promise<void>) => { queue = queue.then(task).catch(() => {}); return queue; };

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
    await appWindow.setSize(new PhysicalSize(inner.width + width, inner.height));
    grown = { width, shift: position.x - x };
  });
}

/** Undoes growWindow: narrows the window again and moves it back if it had to shift left. */
export function shrinkWindow(): Promise<void> {
  return enqueue(async () => {
    if (!isTauri() || !grown.width) return;
    const { width, shift } = grown;
    grown = { width: 0, shift: 0 };
    const appWindow = getCurrentWindow();
    if (await appWindow.isMaximized() || await appWindow.isFullscreen()) return;
    const [inner, position] = await Promise.all([appWindow.innerSize(), appWindow.outerPosition()]);
    await appWindow.setSize(new PhysicalSize(Math.max(400, inner.width - width), inner.height));
    if (shift) await appWindow.setPosition(new PhysicalPosition(position.x + shift, position.y));
  });
}

/** Shrinks a widened window before it closes, so the saved window size does not include the side content. */
export function shrinkWindowOnClose(): Promise<() => void> {
  if (!isTauri()) return Promise.resolve(() => {});
  return getCurrentWindow().onCloseRequested(() => shrinkWindow());
}
