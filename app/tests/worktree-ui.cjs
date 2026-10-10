// Focused browser coverage for repository/worktree presentation and session migration.
// Real Git metadata is covered by agent/tests/worktrees.rs; this bridge supplies fixed snapshots.
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const puppeteer = require("puppeteer-core");

const primary = "C:/repos/app", topic = "C:/trees/topic", unopened = "C:/trees/unopened", independent = "C:/elsewhere/app";
const worktrees = [primary, topic, unopened].map((path, index) => ({ path, branch: ["main", "topic", "unopened"][index], head: "1".repeat(40), bare: false, prunable: false }));
const snapshot = repo => ({ path: repo, name: repo.split("/").pop(), repositoryName: "app", branch: worktrees.find(tree => tree.path === repo)?.branch ?? "independent", commonGitDir: repo === independent ? `${independent}/.git` : `${primary}/.git`, worktrees: repo === independent ? [{ ...worktrees[0], path: independent, branch: "independent" }] : worktrees, head: "1".repeat(40), status: [], refs: [], remotes: [], commits: [], hasMore: false });
let vite, browser;
let releaseSnapshots = null;

async function main() {
  const app = path.resolve(__dirname, "..");
  vite = spawn(process.execPath, [path.join(app, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", "1424"], { cwd: app, stdio: "ignore", windowsHide: true });
  const url = "http://127.0.0.1:1424";
  for (let attempt = 0; attempt < 50; attempt++) {
    try { if ((await fetch(url)).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 850 });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.exposeFunction("__testInvoke", async (command, args) => {
    if (command === "repo_snapshot") {
      if (releaseSnapshots) await releaseSnapshots.promise;
      return snapshot(args.path);
    }
    if (command === "repo_state") return snapshot(args.path);
    if (command === "repo_watch") return new Promise(() => {});
    if (command === "repo_notes" || command === "repo_read_notes") return [];
    if (command === "ssh_current_prompt") return null;
    if (command === "repo_diff") return { text: "", truncated: false };
    return null;
  });
  await page.evaluateOnNewDocument(({ primary, topic, independent }) => {
    window.isTauri = true;
    window.__callbacks = new Map(); window.__events = {}; window.__nextCallback = 0;
    window.__mcpWaiters = new Map();
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: callback => { const id = ++window.__nextCallback; window.__callbacks.set(id, callback); return id; },
      unregisterCallback: () => {},
      invoke: async (command, args) => {
        if (command === "plugin:event|listen") { window.__events[args.event] = window.__callbacks.get(args.handler); return args.handler; }
        if (command === "mcp_request_active") return window.__mcpWaiters.has(args.id);
        if (command === "mcp_reply") { window.__mcpWaiters.get(args.id)?.(args); window.__mcpWaiters.delete(args.id); return; }
        return window.__testInvoke(command, args);
      },
    };
    if (!localStorage.getItem("worktree-test-initialized")) {
      localStorage.setItem("gitferry.openTabs", JSON.stringify([primary, independent, topic]));
      localStorage.setItem("gitferry.activeTab", topic);
      localStorage.setItem("worktree-test-initialized", "true");
    }
  }, { primary, topic, independent });
  await page.goto(url);
  await page.waitForFunction(() => document.querySelectorAll(".repo-tab").length === 2 && document.querySelectorAll(".worktree-tab").length === 3);
  assert.equal(await page.$eval(".worktree-tab.active", button => button.title), topic);
  assert.deepEqual(await page.$$eval(".repo-tab .tab-name", spans => spans.map(span => span.textContent)), ["app", "app"]);
  assert.deepEqual(await page.$$eval(".worktree-tab", buttons => buttons.map(button => button.textContent.trim())), ["main", "topic", "unopened"], "Only branch names are visible; folders remain in tooltips");
  const beforeTabs = await page.evaluate(() => localStorage.getItem("gitferry.openTabs"));
  const first = await page.$eval(".worktree-tab:first-child", button => { const rect = button.getBoundingClientRect(); return { x: rect.x + 5, y: rect.y + rect.height / 2 }; });
  const last = await page.$eval(".worktree-tab:last-child", button => { const rect = button.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; });
  await page.mouse.move(last.x, last.y); await page.mouse.down();
  await page.mouse.move(first.x, first.y, { steps: 10 }); await page.mouse.up();
  await page.waitForFunction(() => [...document.querySelectorAll(".worktree-tab")].map(button => button.textContent.trim()).join(",") === "unopened,main,topic");
  assert.equal(await page.$eval(".worktree-tab.active", button => button.title), topic, "Dragging must not activate or open the dragged checkout");
  assert.equal(await page.evaluate(() => localStorage.getItem("gitferry.openTabs")), beforeTabs, "Worktree sorting does not reorder repository tabs or open new checkouts");
  await page.locator(".repo-tab:nth-child(2) .tab-main").click();
  await page.waitForFunction(() => localStorage.getItem("gitferry.activeTab") === "C:/elsewhere/app");
  assert.equal(await page.$$eval(".worktree-tabbar", nodes => nodes.length), 0);
  await page.locator(".repo-tab:first-child .tab-main").click();
  await page.waitForFunction(() => document.querySelector(".worktree-tab.active")?.title === "C:/trees/topic");
  await page.locator(`.worktree-tab[title='${unopened}']`).click();
  await page.waitForFunction(() => document.querySelector(".worktree-tab.active")?.title === "C:/trees/unopened");
  assert.equal(await page.$$eval(".repo-tab", nodes => nodes.length), 2);
  const result = await page.evaluate(() => new Promise(resolve => {
    window.__mcpWaiters.set(1, resolve);
    window.__events["mcp-request"]({ payload: { id: 1, tool: "list_repositories", deadline: Date.now() + 10000, arguments: {} } });
  }));
  assert.equal(result.error, null);
  assert.equal(result.result.repositories.length, 4);
  assert.deepEqual(result.result.repositories.map(repo => repo.path).sort(), [primary, topic, unopened, independent].sort());
  let release;
  releaseSnapshots = { promise: new Promise(resolve => { release = resolve; }) };
  await page.reload();
  await page.waitForFunction(() => document.querySelector(".statusbar"));
  assert.equal(await page.$$eval(".repo-tab", nodes => nodes.length), 2, "Cached linked checkout metadata groups repository tabs before snapshots finish");
  assert.equal(await page.$$eval(".worktree-tab", nodes => nodes.length), 3, "Cached worktree tabs appear while repository verification is pending");
  assert.equal(await page.$eval(".worktree-tab.active", button => button.title), unopened);
  assert.deepEqual(await page.$$eval(".worktree-tab", buttons => buttons.map(button => button.textContent.trim())), ["unopened", "main", "topic"], "Dragged order is restored before snapshots complete");
  assert.equal(await page.$$eval(".repo-tab.loading", nodes => nodes.length), 2, "Cache hints do not mark snapshots ready");
  releaseSnapshots = null; release();
  await page.waitForFunction(() => document.querySelectorAll(".repo-tab").length === 2 && document.querySelector(".worktree-tab.active")?.title === "C:/trees/unopened");
  await page.waitForFunction(() => !document.querySelector(".repo-tab.loading"));
  const screenshot = path.join(os.tmpdir(), "gitferry-worktree-tabs.png");
  await page.screenshot({ path: screenshot });
  await page.locator(".repo-tab:first-child .tab-close").click();
  await page.waitForFunction(() => document.querySelectorAll(".repo-tab").length === 1);
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("gitferry.openTabs"))), [independent]);
  assert.deepEqual(errors, []);
  console.log(`Worktree UI smoke passed: migration, switching, remembering, unopened worktree, MCP checkout paths, reload and repository close. Screenshot: ${screenshot}`);
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  if (vite) vite.kill();
});
