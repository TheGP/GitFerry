/* @refresh reload */
import { render } from "solid-js/web";
import { persistSettings, restoreSettings } from "./settingsFile";

// Settings must be restored before App loads, because App reads them while its module initializes.
void (async () => {
  await restoreSettings();
  persistSettings();
  const { default: App } = await import("./App");
  render(() => <App />, document.getElementById("root") as HTMLElement);
})();
