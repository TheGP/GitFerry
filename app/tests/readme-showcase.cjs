// Synthetic repositories only. Run through the real-agent headless harness:
// GITFERRY_README_SHOWCASE=1 node tests/headless-smoke.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

module.exports = async function showcase({ page, sandbox, screenshots, git, click, openRepo, mcp }) {
  const repository = path.join(sandbox, "harbor");
  fs.mkdirSync(path.join(repository, "src"), { recursive: true });
  git(repository, "init", "-b", "master");
  git(repository, "config", "user.name", "Mira Chen");
  git(repository, "config", "user.email", "mira@example.test");
  const write = (file, text) => fs.writeFileSync(path.join(repository, file), text);
  let sequence = 0;
  const commit = (subject, author = "Mira Chen") => {
    const date = new Date(Date.UTC(2026, 9, 2, 9, sequence++ * 35)).toISOString();
    const previous = process.env.GIT_COMMITTER_DATE;
    process.env.GIT_COMMITTER_DATE = date;
    try {
      git(repository, "add", "src", "README.md");
      git(repository, "commit", `--date=${date}`, `--author=${author} <${author === "Mira Chen" ? "mira" : "noah"}@example.test>`, "-m", subject);
    } finally {
      if (previous === undefined) delete process.env.GIT_COMMITTER_DATE;
      else process.env.GIT_COMMITTER_DATE = previous;
    }
  };
  const original = [
    'import { delay } from "./timing";',
    'import { publishStatus } from "./status";',
    '',
    'export async function syncWorkspace(',
    '  endpoint: string,',
    '  signal?: AbortSignal,',
    '): Promise<void> {',
    '  publishStatus("Connecting…");',
    '  const response = await fetch(endpoint, { signal });',
    '',
    '  if (!response.ok) {',
    '    throw new Error(`Sync failed: ${response.status}`);',
    '  }',
    '',
    '  publishStatus("Everything is up to date");',
    '}',
    '',
  ].join("\n");
  write("README.md", "# Harbor\n\nA fictional workspace sync service for GitFerry screenshots.\n");
  write("src/sync.ts", original);
  write("src/status.ts", 'export function publishStatus(message: string): void {\n  console.info(`[harbor] ${message}`);\n}\n');
  write("src/timing.ts", [
    'export function delay(ms: number, signal?: AbortSignal): Promise<void> {',
    '  return new Promise((resolve, reject) => {',
    '    const timer = setTimeout(resolve, ms);',
    '    signal?.addEventListener("abort", () => {',
    '      clearTimeout(timer);',
    '      reject(signal.reason);',
    '    }, { once: true });',
    '  });',
    '}',
    '',
  ].join("\n"));
  commit("feat: create the Harbor workspace");
  for (const [file, subject, content] of [
    ["settings", "feat: remember workspace preferences", 'export const defaults = { theme: "dark", syncOnFocus: true };\n'],
    ["workspace", "feat: index workspace files", 'export const ignored = ["node_modules", ".git", "dist"];\n'],
    ["health", "feat: report connection health", 'export const healthCheckInterval = 30_000;\n'],
  ]) {
    write(`src/${file}.ts`, content);
    commit(subject, "Noah Lane");
  }
  git(repository, "switch", "-c", "feature/status-panel");
  write("src/status.ts", 'export function publishStatus(message: string): void {\n  console.info(`[harbor] ${message}`);\n  window.dispatchEvent(new CustomEvent("sync-status", { detail: message }));\n}\n');
  commit("feat: stream connection status to the UI", "Noah Lane");
  write("src/palette.ts", 'export const palette = { ready: "#8bc69b", busy: "#e9b36e" };\n');
  commit("style: soften the status indicator colors", "Noah Lane");
  git(repository, "switch", "master");
  write("src/health.ts", 'export const healthCheckInterval = 15_000;\n');
  commit("fix: refresh connection health sooner");
  git(repository, "merge", "--no-ff", "feature/status-panel", "-m", "Merge connection status panel");
  git(repository, "tag", "v1.4.0");
  // This remote is a disposable local bare repository, never a real service.
  git(repository, "remote", "add", "origin", path.join(sandbox, "remote.git"));
  git(repository, "push", "origin", "master", "feature/status-panel");
  git(repository, "branch", "--set-upstream-to=origin/master", "master");
  git(repository, "switch", "-c", "feature/resilient-sync");
  const resilient = [
    'import { delay } from "./timing";',
    'import { publishStatus } from "./status";',
    '',
    'const retryDelays = [250, 1_000, 3_000];',
    '',
    'export async function syncWorkspace(',
    '  endpoint: string,',
    '  signal?: AbortSignal,',
    '): Promise<void> {',
    '  for (let attempt = 0; ; attempt++) {',
    '    try {',
    '      publishStatus(attempt ? "Reconnecting…" : "Connecting…");',
    '      const response = await fetch(endpoint, { signal });',
    '      if (!response.ok) throw new Error(`Sync failed: ${response.status}`);',
    '',
    '      publishStatus("Everything is up to date");',
    '      return;',
    '    } catch (error) {',
    '      if (signal?.aborted || attempt === retryDelays.length) throw error;',
    '      await delay(retryDelays[attempt], signal);',
    '    }',
    '  }',
    '}',
    '',
  ].join("\n");
  write("src/sync.ts", resilient);
  commit("feat: reconnect with a bounded retry budget");
  write("src/settings.ts", 'export const defaults = { theme: "dark", syncOnFocus: true, retries: 3 };\n');
  commit("feat: expose reconnect preferences", "Noah Lane");
  fs.appendFileSync(path.join(repository, ".git/info/exclude"), "\n.gitferry/\n");
  fs.mkdirSync(path.join(repository, ".gitferry"));
  write(".gitferry/notes.jsonl", [
    { id: "retry-budget", file: "src/sync.ts", quote: "const retryDelays = [250, 1_000, 3_000];", note: "Back off between attempts so a slow host has room to recover." },
    { id: "cancel-sync", file: "src/sync.ts", quote: "if (signal?.aborted || attempt === retryDelays.length) throw error;", note: "Stop on cancellation or after three retries. A closed workspace must not keep reconnecting." },
  ].map(note => JSON.stringify(note)).join("\n") + "\n");
  const uiRepository = path.join(sandbox, "harbor-ui");
  fs.mkdirSync(uiRepository);
  git(uiRepository, "init", "-b", "master");
  git(uiRepository, "config", "user.name", "Noah Lane");
  git(uiRepository, "config", "user.email", "noah@example.test");
  fs.writeFileSync(path.join(uiRepository, "README.md"), "# Harbor UI\n\nFictional companion interface.\n");
  git(uiRepository, "add", "README.md");
  git(uiRepository, "commit", "-m", "feat: start the Harbor interface");

  // Isolated browser storage: these settings never touch the desktop app's data.
  await page.evaluate(() => {
    localStorage.clear();
    for (const [key, value] of Object.entries({
      "gitferry.theme": "claude", "gitferry.showTabBranch": "true",
      "gitferry.codeSize": "15", "gitferry.locationsWidth": "210",
      "gitferry.commitsWidth": "360", "gitferry.editorWidth": "760",
    })) localStorage.setItem(key, value);
  });
  await page.setViewport({ width: 1680, height: 1040, deviceScaleFactor: 1 });
  await page.reload();
  await page.waitForSelector(".statusbar");
  await openRepo(page, uiRepository);
  await openRepo(page, repository);
  await page.waitForFunction(() => document.querySelector(".compare-main strong")?.textContent === "feature/resilient-sync vs origin/master");
  await click(page, ".compare-main");
  await page.waitForSelector('.summary-diff-card[data-path="src/sync.ts"] .hunk-note');
  await page.evaluate(() => document.querySelector(".details-scroll").scrollTop = 145);
  await page.screenshot({ path: path.join(screenshots, "gitferry-overview.png") });

  // A closer, genuine UI capture makes the note format and changed words readable on GitHub.
  await page.locator('.summary-diff-card[data-path="src/sync.ts"] .summary-open-tab').click();
  await page.waitForSelector(".details-pane .hunk-note");
  await (await page.$(".details-pane")).screenshot({ path: path.join(screenshots, "gitferry-change-notes.png") });

  // reveal_file targets timing.ts, which this feature branch has never changed.
  await page.setViewport({ width: 1840, height: 980, deviceScaleFactor: 1 });
  await click(page, 'button[title="Toggle locations"]');
  const result = await mcp(page, "reveal_file", {
    repository, revision: git(repository, "rev-parse", "feature/resilient-sync"), file: "src/timing.ts",
    startLine: 4, endLine: 7, quote: 'signal?.addEventListener("abort"',
    comment: "Cancellation clears the pending timer and rejects the wait immediately. The retry loop can stop without waiting for the next backoff interval.",
  });
  assert.equal(result.error, null);
  assert.equal(result.result.confirmed, true);
  await page.waitForSelector(".editor-row.ai-highlight");
  const editorBounds = await (await page.$(".editor-pane")).boundingBox();
  await page.screenshot({ path: path.join(screenshots, "gitferry-ai-navigation.png"), clip: { ...editorBounds, height: 430 } });

  await click(page, 'button[aria-label="Close editor"]');
  await click(page, 'button[title="Toggle locations"]');
  await page.setViewport({ width: 1680, height: 980, deviceScaleFactor: 1 });
  write("src/sync.ts", resilient.replace('[250, 1_000, 3_000]', '[500, 1_500, 5_000]').replace('"Reconnecting…"', '`Reconnecting (attempt ${attempt})…`'));
  write("src/settings.ts", 'export const defaults = { theme: "dark", syncOnFocus: true, retries: 3, showProgress: true };\n');
  await click(page, ".working-row");
  await click(page, 'button[title="More actions"]');
  await click(page, '.push-menu button[title="Refresh"]');
  await page.waitForFunction(() => [...document.querySelectorAll(".summary-diff-card .line-text")].some(line => line.textContent.includes("const retryDelays = [500")));
  const syncCard = '.summary-diff-card[data-path="src/sync.ts"]';
  await click(page, `${syncCard} .diff-line.added .line-number`);
  await page.waitForFunction(() => document.querySelector(".diff-line.selected"));
  await page.locator(".commit-editor textarea").fill("Polish reconnect feedback\n\nShow the attempt count and give slower hosts more time.");
  await (await page.$(".details-pane")).screenshot({ path: path.join(screenshots, "gitferry-line-staging.png") });
  await page.locator(".commit-editor textarea").fill("");
  assert.equal(git(repository, "diff", "--cached", "--name-only"), "", "The showcase must only select lines, not stage them");
};
