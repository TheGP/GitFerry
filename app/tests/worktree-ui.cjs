// Focused browser coverage for repository/worktree presentation and session migration.
// Real Git metadata is covered by agent/tests/worktrees.rs; this bridge supplies fixed snapshots.
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const puppeteer = require("puppeteer-core");

const primary = "C:/repos/app", topic = "C:/trees/topic", unopened = "C:/trees/unopened", independent = "C:/elsewhere/app";
const worktrees = [primary, topic, unopened].map((path, index) => ({ path, branch: ["main", "topic", "unopened"][index], head: "1".repeat(40), bare: false, prunable: false }));
worktrees[2].branch = "Detached HEAD";
worktrees[1].mergedInto = "origin/main";
let topicStatus = [];
const snapshot = repo => ({ path: repo, name: repo.split("/").pop(), repositoryName: "app", branch: worktrees.find(tree => tree.path === repo)?.branch ?? "independent", commonGitDir: repo === independent ? `${independent}/.git` : `${primary}/.git`, worktrees: repo === independent ? [{ ...worktrees[0], path: independent, branch: "independent" }] : worktrees, head: "1".repeat(40), status: repo === topic ? topicStatus : [], refs: [], remotes: [], commits: [], hasMore: false });
let vite, browser;
let releaseSnapshots = null;
const removals = [];
let partialCleanup = false;
let pendingRemoval = null;

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
    if (command === "repo_action" && ["remove_worktree", "forget_worktree"].includes(args.operation.kind)) {
      assert.equal(args.operation.value.confirmed, true);
      assert.equal(args.operation.value.expected_head, "1".repeat(40));
      assert.notEqual(args.operation.value.path, primary);
      if (pendingRemoval) await pendingRemoval;
      removals.push(args.operation.value.path);
      worktrees.splice(worktrees.findIndex(tree => tree.path === args.operation.value.path), 1);
      if (partialCleanup) throw new Error("Worktree removed from Git, but folder cleanup failed: held file");
      return "";
    }
    if (command === "repo_snapshot") {
      if (releaseSnapshots) await releaseSnapshots.promise;
      return snapshot(args.path);
    }
    if (command === "repo_state") {
      if (args.path !== independent && !worktrees.some(tree => tree.path === args.path)) throw new Error("fatal: not a git repository");
      return snapshot(args.path);
    }
    if (command === "repo_watch") return new Promise(() => {});
    if (command === "repo_notes" || command === "repo_read_notes") return { content: "" };
    if (command === "ssh_current_prompt") return null;
    if (command === "repo_diff") return { text: "", truncated: false };
    return null;
  });
  await page.evaluateOnNewDocument(({ primary, topic, independent }) => {
    window.isTauri = true;
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async text => { window.__copiedText = text; } } });
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
  assert.deepEqual(await page.$$eval(".worktree-tab", buttons => buttons.map(button => button.textContent.trim())), ["main", "topic", "unopened (detached)"], "Branches use branch labels; detached checkouts use their folder name");
  assert.equal(await page.$$eval(".worktree-merged", badges => badges.length), 1);
  assert.equal(await page.$eval(".worktree-tab.active .worktree-merged", badge => badge.getAttribute("aria-label")), "Commits included in origin/main");
  assert.match(await page.$eval(".worktree-merged", badge => badge.title), /last fetched.*Uncommitted edits/);
  topicStatus = [{ path: "staged.txt", index: "A", worktree: " " }];
  await page.keyboard.down("Control"); await page.keyboard.press("r"); await page.keyboard.up("Control");
  await page.waitForFunction(() => document.querySelectorAll(".worktree-merged").length === 0);
  topicStatus = [];
  await page.keyboard.down("Control"); await page.keyboard.press("r"); await page.keyboard.up("Control");
  await page.waitForFunction(() => document.querySelectorAll(".worktree-merged").length === 1);
  const beforeTabs = await page.evaluate(() => localStorage.getItem("gitferry.openTabs"));
  const first = await page.$eval(".worktree-tab:first-child", button => { const rect = button.getBoundingClientRect(); return { x: rect.x + 5, y: rect.y + rect.height / 2 }; });
  const last = await page.$eval(".worktree-tab:last-child", button => { const rect = button.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; });
  await page.mouse.move(last.x, last.y); await page.mouse.down();
  await page.mouse.move(first.x, first.y, { steps: 10 }); await page.mouse.up();
  await page.waitForFunction(() => [...document.querySelectorAll(".worktree-tab")].map(button => button.textContent.trim()).join(",") === "unopened (detached),main,topic");
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
  assert.deepEqual(await page.$$eval(".worktree-tab", buttons => buttons.map(button => button.textContent.trim())), ["unopened (detached)", "main", "topic"], "Dragged order is restored before snapshots complete");
  assert.equal(await page.$$eval(".repo-tab.loading", nodes => nodes.length), 2, "Cache hints do not mark snapshots ready");
  assert.equal(await page.$$eval(".worktree-merged", badges => badges.length), 0, "Do not show cached badges before verifying repository state");
  releaseSnapshots = null; release();
  await page.waitForFunction(() => document.querySelectorAll(".repo-tab").length === 2 && document.querySelector(".worktree-tab.active")?.title === "C:/trees/unopened");
  await page.waitForFunction(() => !document.querySelector(".repo-tab.loading"));
  await page.waitForFunction(() => document.querySelectorAll(".worktree-merged").length === 1);
  const screenshot = path.join(os.tmpdir(), "gitferry-worktree-tabs.png");
  await page.screenshot({ path: screenshot });
  await page.click(`.worktree-tab[title='${primary}']`, { button: "right" });
  assert.equal(await page.$eval(".worktree-action-popover button", button => button.disabled), true, "Primary checkout cannot be removed");
  await page.keyboard.press("Escape");
  assert.equal(await page.$(".worktree-action-popover"), null);
  await page.click(`.worktree-tab[title='${topic}']`, { button: "right" });
  await page.locator(".worktree-action-popover button:last-child").click();
  await page.waitForFunction(() => window.__copiedText === "topic");
  assert.equal(await page.$(".worktree-action-popover"), null, "Copy dismisses the menu");
  assert.equal(await page.$eval(".worktree-tab.active", button => button.title), unopened, "Copy does not switch checkouts");
  assert.deepEqual(removals, [], "Copy does not remove a worktree");
  await page.click(`.worktree-tab[title='${topic}']`, { button: "right" });
  await page.locator(".worktree-action-popover button").click();
  await page.waitForSelector(".action-dialog");
  assert.match(await page.$eval(".action-dialog-body", body => body.textContent), /C:\/trees\/topic.*branch is kept/s);
  await page.screenshot({ path: path.join(os.tmpdir(), "gitferry-remove-worktree-confirmation.png") });
  await page.keyboard.press("Escape");
  assert.deepEqual(removals, [], "Cancelling must not send a removal request");
  assert.equal(await page.$eval(".worktree-tab.active", button => button.title), unopened, "Right-click does not switch checkouts");
  let finishRemoval;
  pendingRemoval = new Promise((resolve, reject) => { finishRemoval = { resolve, reject }; });
  await page.click(`.worktree-tab[title='${unopened}']`, { button: "right" });
  await page.locator(".worktree-action-popover button").click();
  await page.waitForSelector(".action-dialog");
  const submit = await page.$$(".action-dialog-footer button");
  await submit[submit.length - 1].click();
  await page.waitForSelector(".worktree-tab.removing[aria-busy='true'] .worktree-removing");
  assert.equal(await page.$eval(".worktree-tab.removing", tab => tab.title), unopened);
  assert.equal(await page.$eval(".worktree-tab.removing", tab => tab.disabled), true);
  await page.screenshot({ path: path.join(os.tmpdir(), "gitferry-worktree-removing.png") });
  finishRemoval.reject(new Error("Worktree has uncommitted changes"));
  await page.waitForFunction(() => !document.querySelector(".worktree-tab.removing"));
  assert.ok(await page.$(`.worktree-tab[title='${unopened}']`), "A failed removal restores the tab's normal appearance");
  assert.deepEqual(removals, []);
  pendingRemoval = null;
  await page.click(`.worktree-tab[title='${unopened}']`, { button: "right" });
  await page.locator(".worktree-action-popover button").click();
  await page.locator(".action-dialog-submit").click();
  await page.waitForFunction(() => ![...document.querySelectorAll(".worktree-tab")].some(button => button.title === "C:/trees/unopened"));
  assert.deepEqual(removals, [unopened]);
  assert.equal(await page.$eval(".worktree-tab.active", button => button.title), primary, "Removing the active checkout selects the primary checkout");
  assert.equal(await page.$$eval(".repo-tab", tabs => tabs.length), 2);
  assert.ok(!JSON.parse(await page.evaluate(() => localStorage.getItem("gitferry.openTabs"))).includes(unopened));
  assert.ok(!(await page.evaluate(() => localStorage.getItem("gitferry.worktreeMetadata")))?.includes(unopened));
  partialCleanup = true;
  await page.click(`.worktree-tab[title='${topic}']`, { button: "right" });
  await page.locator(".worktree-action-popover button").click();
  await page.locator(".action-dialog-submit").click();
  await page.waitForFunction(() => document.body.textContent.includes("folder cleanup failed"));
  await page.waitForFunction(() => !document.querySelector(".worktree-tabbar"));
  assert.ok(!JSON.parse(await page.evaluate(() => localStorage.getItem("gitferry.openTabs"))).includes(topic), "A partial Git cleanup cannot leave an unregistered checkout as an open tab");
  await page.reload();
  await page.waitForFunction(() => !document.querySelector(".repo-tab.loading"));
  assert.equal(await page.$$eval(".worktree-tab", tabs => tabs.length), 0, "The deleted checkout cannot return from the session cache");
  partialCleanup = false;
  const broken = "C:/trees/broken";
  worktrees.push({ ...worktrees[0], path: broken, branch: "stale-topic", prunable: true });
  await page.keyboard.down("Control"); await page.keyboard.press("r"); await page.keyboard.up("Control");
  await page.waitForSelector(".worktree-unavailable");
  await page.locator(`.worktree-tab[title='${broken}']`).click();
  assert.equal(await page.$eval(".worktree-tab.active", tab => tab.title), primary, "An unavailable checkout must not activate");
  await page.click(`.worktree-tab[title='${broken}']`, { button: "right" });
  assert.match(await page.$eval(".worktree-action-popover", menu => menu.textContent), /Forget stale worktree/);
  await page.locator(".worktree-action-popover button").click();
  await page.waitForSelector(".action-dialog");
  assert.match(await page.$eval(".action-dialog-body", body => body.textContent), /remaining folder and files will be kept.*metadata is saved/s);
  await page.screenshot({ path: path.join(os.tmpdir(), "gitferry-forget-stale-worktree.png") });
  await page.keyboard.press("Escape");
  assert.ok(await page.$(`.worktree-tab[title='${broken}']`), "Cancellation keeps the stale registration visible");
  await page.click(`.worktree-tab[title='${broken}']`, { button: "right" });
  await page.locator(".worktree-action-popover button").click();
  await page.locator(".action-dialog-submit").click();
  await page.waitForFunction(() => !document.querySelector(".worktree-unavailable"));
  assert.equal(removals.at(-1), broken);
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
