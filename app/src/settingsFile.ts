import { invoke, isTauri } from "@tauri-apps/api/core";

// WebView localStorage commits lazily and has come back empty after Windows restarts, so every
// "gitferry.*" setting is mirrored to a JSON file owned by the Rust side. The file wins on startup.
const prefix = "gitferry.";

export async function restoreSettings() {
  if (!isTauri()) return;
  try {
    const saved = await invoke<Record<string, string> | null>("load_settings");
    for (const [key, value] of Object.entries(saved ?? {})) {
      if (key.startsWith(prefix) && typeof value === "string") localStorage.setItem(key, value);
    }
  } catch { /* Fall back to whatever localStorage still has. */ }
}

export function persistSettings() {
  if (!isTauri()) return;
  let timer = 0;
  const flush = () => {
    timer = 0;
    const settings: Record<string, string> = {};
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key?.startsWith(prefix)) settings[key] = localStorage.getItem(key) ?? "";
    }
    void invoke("save_settings", { settings }).catch(() => {});
  };
  const schedule = () => { if (!timer) timer = window.setTimeout(flush, 300); };
  // The app writes settings straight to localStorage in many places; mirror those writes here.
  const setItem = Storage.prototype.setItem;
  const removeItem = Storage.prototype.removeItem;
  Storage.prototype.setItem = function (key: string, value: string) {
    setItem.call(this, key, value);
    if (this === localStorage && key.startsWith(prefix)) schedule();
  };
  Storage.prototype.removeItem = function (key: string) {
    removeItem.call(this, key);
    if (this === localStorage && key.startsWith(prefix)) schedule();
  };
  window.addEventListener("pagehide", () => { if (timer) { window.clearTimeout(timer); flush(); } });
  schedule();
}
