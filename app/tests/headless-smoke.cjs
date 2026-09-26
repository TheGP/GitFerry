// Run with `pnpm test:ui` from app/; set CHROME_PATH if Chrome is elsewhere.
// Chrome stays headless; every Git operation goes through the real agent RPC.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const readline = require("node:readline");
const puppeteer = require("puppeteer-core");

const project = path.resolve(__dirname, "../..");
const agentPath = path.join(project, "target", "debug", process.platform === "win32" ? "gitferry-agent.exe" : "gitferry-agent");
const chromePath = process.env.CHROME_PATH || (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : "/usr/bin/google-chrome");
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "gitferry-headless-"));
const screenshots = path.join(sandbox, "screenshots");
fs.mkdirSync(screenshots);
let browser, vite, agent;
let nextId = 0;
const pending = new Map();

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args[0]}: ${result.stderr}`);
  return result.stdout.trim();
}

function makeRepo(name, large = false) {
  const folder = path.join(sandbox, name);
  fs.mkdirSync(folder);
  git(folder, "init", "-b", "main");
  git(folder, "config", "user.name", "GitFerry Test");
  git(folder, "config", "user.email", "gitferry@example.test");
  fs.writeFileSync(path.join(folder, "base.txt"), "one\ntwo\nthree\n");
  git(folder, "add", "base.txt");
  git(folder, "commit", "-m", "Initial commit");
  if (large) {
    const head = git(folder, "rev-parse", "HEAD");
    for (let i = 0; i < 24; i++) git(folder, "update-ref", `refs/heads/feature/branch-${i}`, head);
    for (let i = 0; i < 158; i++) git(folder, "update-ref", `refs/remotes/origin/team/branch-${i}`, head);
    for (let i = 0; i < 414; i++) fs.writeFileSync(path.join(folder, `file-${String(i).padStart(3, "0")}.txt`), `change ${i}\n`);
  } else {
    fs.writeFileSync(path.join(folder, "base.txt"), "one\ntwo changed\nthree\n");
    fs.writeFileSync(path.join(folder, "new.txt"), "new file\n");
  }
  return folder;
}

function makeLineRepo() {
  const folder = path.join(sandbox, "lines");
  fs.mkdirSync(folder);
  git(folder, "init", "-b", "main");
  git(folder, "config", "user.name", "GitFerry Test");
  git(folder, "config", "user.email", "gitferry@example.test");
  const original = Array.from({ length: 30 }, (_, index) => `line ${index + 1}\n`).join("");
  fs.writeFileSync(path.join(folder, "lines.txt"), original);
  git(folder, "add", "lines.txt");
  git(folder, "commit", "-m", "Initial lines");
  fs.writeFileSync(path.join(folder, "lines.txt"), original.replace("line 3\n", "NEW 3\n").replace("line 15\n", "++prefixed\n").replace("line 25\n", "NEW 25\n"));
  return folder;
}

async function clickChangedLine(page, text, shift = false) {
  const label = await page.evaluate(value => [...document.querySelectorAll(".diff-line")].find(row => row.querySelector(".line-text")?.textContent === value)?.querySelector("button.line-number")?.getAttribute("aria-label"), text);
  assert.ok(label, `Selectable line ${text} must exist`);
  if (shift) await page.keyboard.down("Shift");
  await page.click(`button[aria-label='${label}'] .${label.startsWith("Select old") ? "old-line" : "new-line"}`);
  if (shift) await page.keyboard.up("Shift");
}

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    agent.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
}

async function bridge(command, args) {
  if (command.startsWith("plugin:event|")) return 1;
  const commands = {
    repo_snapshot: ["snapshot", { path: args.path, offset: args.offset, limit: 100 }],
    repo_state: ["state", { path: args.path }],
    repo_search: ["search", { path: args.path, query: args.query, offset: args.offset, limit: 100 }],
    repo_commit: ["commit_details", { path: args.path, hash: args.hash }],
    repo_diff: ["diff", { path: args.path, target: args.target, file: args.file }],
    repo_action: ["action", { path: args.path, action: args.operation }],
  };
  const entry = commands[command];
  if (!entry) throw new Error(`Unknown command ${command}`);
  const response = await rpc(...entry);
  if (response.kind === "error") throw new Error(response.value);
  if (command === "repo_snapshot") return response.value;
  return response.value;
}

async function waitForServer(url) {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error("Vite did not start");
}

async function waitUntil(check, label) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function waitForAction(page) {
  await page.waitForFunction(() => !document.querySelector("button[title='Fetch']")?.disabled);
}

async function shortcut(page, key) {
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.down(modifier);
  await page.keyboard.press(key);
  await page.keyboard.up(modifier);
}

async function openRepo(page, folder) {
  await page.locator("button[title='Open repository']").click();
  await page.locator(".open-modal .modal-body input").fill(folder);
  await page.locator(".open-modal .modal-body button[type='submit']").click();
  await page.waitForFunction(value => document.querySelector(".statusbar")?.textContent.includes(value), {}, folder);
}

async function metrics(page) {
  return page.evaluate(() => {
    const rect = selector => { const r = document.querySelector(selector)?.getBoundingClientRect(); return r && { top: r.top, bottom: r.bottom, height: r.height }; };
    const list = document.querySelector(".locations-list");
    return { viewport: innerHeight, footer: rect(".statusbar"), workspace: rect(".workspace"), locations: rect(".locations"), list: rect(".locations-list"), listScrollHeight: list?.scrollHeight, listClientHeight: list?.clientHeight, documentScrollHeight: document.documentElement.scrollHeight, longTasks: window.__longTasks };
  });
}

async function main() {
  assert.ok(fs.existsSync(agentPath), `Build ${agentPath} first`);
  assert.ok(fs.existsSync(chromePath), `Chrome not found at ${chromePath}`);
  const small = makeRepo("small");
  const large = makeRepo("large", true);
  const lineRepo = makeLineRepo();
  const remote = path.join(sandbox, "remote.git");
  fs.mkdirSync(remote);
  git(remote, "init", "--bare", "-b", "main");
  git(small, "remote", "add", "origin", remote);
  git(small, "push", "-u", "origin", "main");
  agent = spawn(agentPath, [], { cwd: project, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  readline.createInterface({ input: agent.stdout }).on("line", line => {
    const response = JSON.parse(line);
    const waiter = pending.get(response.id);
    if (waiter) { pending.delete(response.id); waiter.resolve(response); }
  });
  const vitePath = path.join(project, "app/node_modules/vite/bin/vite.js");
  vite = spawn(process.execPath, [vitePath, "--host", "127.0.0.1"], { cwd: path.join(project, "app"), windowsHide: true, stdio: "ignore" });
  await waitForServer("http://127.0.0.1:1420/");
  browser = await puppeteer.launch({ executablePath: chromePath, headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1429, height: 918, deviceScaleFactor: 1 });
  await page.exposeFunction("__gitferryInvoke", bridge);
  await page.evaluateOnNewDocument(() => {
    window.isTauri = true;
    window.__longTasks = [];
    new PerformanceObserver(list => window.__longTasks.push(...list.getEntries().map(item => Math.round(item.duration)))).observe({ entryTypes: ["longtask"] });
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1,
      unregisterCallback: () => {},
      invoke: (command, args) => window.__gitferryInvoke(command, args),
    };
  });
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.goto("http://127.0.0.1:1420/");
  await shortcut(page, "p");
  await page.waitForSelector(".palette input");
  await page.locator(".palette input").fill("Open repository");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".open-modal");
  assert.equal(await page.$$eval(".palette", items => items.length), 0);
  await page.click(".open-kind button:nth-child(2)");
  await page.locator(".remote-form label:first-child input").fill("tester@example.test");
  await page.locator(".remote-form label:nth-child(2) input").fill("relative/repo");
  assert.equal(await page.$eval(".remote-form button[type='submit']", button => button.disabled), true);
  await page.locator(".remote-form label:nth-child(2) input").fill("/tmp/repo");
  assert.equal(await page.$eval(".remote-form button[type='submit']", button => button.disabled), false);
  await page.click(".open-kind button:first-child");
  await page.locator(".open-modal .modal-body input").fill(path.join(sandbox, "missing"));
  await page.click(".open-modal .modal-body button[type='submit']");
  await page.waitForSelector(".modal-error");
  await page.keyboard.press("Escape");
  await shortcut(page, "o");
  await page.waitForSelector(".open-modal");
  await page.keyboard.press("Escape");
  await openRepo(page, small);
  await page.click(".file-row");
  await page.waitForSelector(".diff-line");
  assert.ok(await page.$eval(".details-tab:first-child", tab => tab.classList.contains("active")), "opening a Summary file must keep Summary active");
  assert.equal(await page.$eval(".file-row", row => row.getAttribute("aria-expanded")), "true");
  assert.match(await page.$eval(".diff-content", element => element.innerText), /two changed|new file/);
  await page.click(".file-row");
  assert.equal(await page.$eval(".file-row", row => row.getAttribute("aria-expanded")), "false");
  await page.click(".file-row");
  await page.waitForSelector(".diff-line");
  await page.click(".hunk-action");
  await page.waitForFunction(() => [...document.querySelectorAll(".file-group-heading")].some(item => item.textContent.trim().startsWith("STAGED ")) || document.querySelector(".error-bar"));
  assert.ok(git(small, "diff", "--cached", "--", "base.txt").includes("two changed"), JSON.stringify({ status: git(small, "status", "--short"), error: await page.$eval(".error-bar", item => item.textContent).catch(() => "") }));
  await waitForAction(page);
  if (await page.$eval(".file-row", row => row.getAttribute("aria-expanded") === "false")) await page.click(".file-row");
  await page.waitForSelector(".hunk-action");
  await page.click(".hunk-action");
  await page.waitForFunction(() => [...document.querySelectorAll(".file-group-heading")].some(item => item.textContent.trim().startsWith("UNSTAGED ")));
  assert.equal(git(small, "diff", "--cached", "--", "base.txt"), "");
  await waitForAction(page);
  if (await page.$eval(".file-row", row => row.getAttribute("aria-expanded") === "false")) await page.click(".file-row");
  await page.waitForSelector(".file-actions button");
  await page.click(".file-actions button");
  await page.waitForFunction(() => [...document.querySelectorAll(".file-group-heading")].some(item => item.textContent.trim().startsWith("STAGED ")));
  await waitForAction(page);
  if (await page.$eval(".file-row", row => row.getAttribute("aria-expanded") === "false")) await page.click(".file-row");
  await page.waitForSelector(".file-actions button");
  await page.click(".file-actions button");
  await page.waitForFunction(() => [...document.querySelectorAll(".file-group-heading")].some(item => item.textContent.trim().startsWith("UNSTAGED ")));
  await waitForAction(page);
  await page.click(".details-tab:nth-child(2)");
  await page.waitForSelector(".all-diff-card");
  await page.click(".files-heading button");
  await page.click(".files-heading button");
  await page.click(".details-tab:first-child");
  assert.equal(await page.$eval(".files-heading button", item => item.textContent.trim()), "Stage All");
  await page.click(".files-heading button");
  await page.waitForFunction(() => [...document.querySelectorAll(".file-group-heading")].some(item => item.textContent.trim().startsWith("STAGED ")) || document.querySelector(".error-bar"));
  assert.ok(git(small, "diff", "--cached", "--name-only"), await page.$eval(".error-bar", item => item.textContent).catch(() => "Stage All did not stage files"));
  await waitForAction(page);
  await page.locator(".commit-editor textarea").fill("Test UI commit");
  await page.locator(".commit-editor-actions button").click();
  await page.waitForFunction(() => document.querySelector(".commit-subject")?.textContent.includes("Test UI commit"));
  assert.equal(git(small, "log", "-1", "--pretty=%s"), "Test UI commit");
  await page.click("button[title='Push']");
  await page.waitForFunction(() => document.querySelector(".notice-bar")?.textContent.includes("main"));
  await page.waitForFunction(() => !document.querySelector("button[title='Fetch']")?.disabled);
  assert.equal(git(remote, "rev-parse", "refs/heads/main"), git(small, "rev-parse", "HEAD"));
  const other = path.join(sandbox, "other");
  git(sandbox, "clone", remote, other);
  git(other, "config", "user.name", "GitFerry Test");
  git(other, "config", "user.email", "gitferry@example.test");
  fs.writeFileSync(path.join(other, "remote.txt"), "from the remote\n");
  git(other, "add", "remote.txt");
  git(other, "commit", "-m", "Remote update");
  git(other, "push");
  await page.click("button[title='Fetch']");
  await waitUntil(() => git(small, "rev-parse", "refs/remotes/origin/main") === git(remote, "rev-parse", "refs/heads/main"), "Fetch").catch(async error => { throw new Error(`${error.message}: ${await page.$eval(".error-bar", item => item.textContent).catch(() => "no UI error")}`); });
  await page.waitForFunction(() => !document.querySelector("button[title='Pull']")?.disabled);
  assert.equal(git(small, "rev-parse", "refs/remotes/origin/main"), git(remote, "rev-parse", "refs/heads/main"));
  await page.click("button[title='Pull']");
  await waitUntil(() => git(small, "rev-parse", "HEAD") === git(remote, "rev-parse", "refs/heads/main"), "Pull");
  await page.waitForFunction(() => !document.querySelector("button[title='Fetch']")?.disabled);
  assert.equal(git(small, "rev-parse", "HEAD"), git(remote, "rev-parse", "refs/heads/main"));
  git(small, "commit", "--amend", "-m", "Remote update amended");
  fs.writeFileSync(path.join(other, "remote-later.txt"), "new remote work\n");
  git(other, "add", "remote-later.txt");
  git(other, "commit", "-m", "Later remote update");
  git(other, "push");
  const advancedRemote = git(remote, "rev-parse", "refs/heads/main");
  await page.click("button[title='More push options']");
  await page.waitForSelector(".push-menu button[title='Force push with lease']");
  await page.screenshot({ path: path.join(screenshots, "force-push-menu.png") });
  page.once("dialog", dialog => dialog.accept());
  await page.click(".push-menu button[title='Force push with lease']");
  await page.waitForSelector(".error-bar");
  assert.equal(git(remote, "rev-parse", "refs/heads/main"), advancedRemote, "stale lease must reject the push");
  await waitForAction(page);
  await page.click("button[title='Fetch']");
  await waitUntil(() => git(small, "rev-parse", "refs/remotes/origin/main") === advancedRemote, "fetch advanced lease");
  await waitForAction(page);
  git(small, "branch", "extra");
  git(remote, "update-ref", "refs/heads/extra", advancedRemote);
  git(small, "update-ref", "refs/remotes/origin/extra", advancedRemote);
  git(small, "config", "push.default", "matching");
  await page.click("button[title='More push options']");
  page.once("dialog", dialog => dialog.accept());
  await page.click(".push-menu button[title='Force push with lease']");
  await waitUntil(() => git(remote, "rev-parse", "refs/heads/main") === git(small, "rev-parse", "HEAD"), "force push with lease");
  await waitForAction(page);
  assert.equal(git(remote, "rev-parse", "refs/heads/extra"), advancedRemote, "force push must leave other branches untouched");
  await page.locator(".search-box input").fill("Test UI commit");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".commits-pane .pane-heading")?.textContent.includes("SEARCH RESULTS"));
  await page.waitForFunction(() => document.querySelector(".commit-scroll")?.textContent.includes("Test UI commit") || document.querySelector(".error-bar"));
  assert.ok((await page.$eval(".commit-scroll", element => element.textContent)).includes("Test UI commit"));
  await page.click(".search-box button");
  await page.click(".branch-chip");
  await page.locator(".branch-menu form input").fill("feature/ui-smoke");
  await page.click(".branch-menu form button");
  await waitUntil(() => git(small, "branch", "--show-current") === "feature/ui-smoke", "branch creation").catch(async error => { throw new Error(`${error.message}: ${await page.$eval(".error-bar", item => item.textContent).catch(() => "no UI error")}`); });
  await page.waitForFunction(() => document.querySelector(".branch-chip")?.textContent.includes("feature/ui-smoke"));
  assert.equal(git(small, "branch", "--show-current"), "feature/ui-smoke");
  await page.click(".branch-chip");
  await page.evaluate(() => [...document.querySelectorAll(".branch-menu-row button")].find(button => button.textContent.trim() === "main")?.click());
  await page.waitForFunction(() => document.querySelector(".branch-chip")?.textContent.includes("main"));
  assert.equal(git(small, "branch", "--show-current"), "main");
  await page.waitForFunction(() => !document.querySelector("button[title='Fetch']")?.disabled);
  await page.click(".branch-chip");
  page.once("dialog", dialog => dialog.accept());
  await page.evaluate(() => [...document.querySelectorAll(".branch-menu-row")].find(row => row.textContent.includes("feature/ui-smoke"))?.querySelector(".branch-delete")?.click());
  await waitUntil(() => !git(small, "branch", "--list", "feature/ui-smoke"), "branch deletion");
  await page.waitForFunction(() => !document.querySelector("button[title='Fetch']")?.disabled);
  await page.click(".working-row");
  fs.writeFileSync(path.join(small, "base.txt"), "temporary unwanted change\n");
  await page.waitForFunction(() => [...document.querySelectorAll(".file-row")].some(row => row.textContent.includes("base.txt")), { timeout: 10000 });
  await page.evaluate(() => { const row = [...document.querySelectorAll(".file-row")].find(item => item.textContent.includes("base.txt")); if (row?.getAttribute("aria-expanded") === "false") row.click(); });
  await page.waitForSelector(".file-actions .danger");
  page.once("dialog", dialog => dialog.accept());
  await page.click(".file-actions .danger");
  await waitUntil(() => git(small, "status", "--porcelain") === "", "discard file");
  await page.waitForFunction(() => !document.querySelector("button[title='Fetch']")?.disabled);
  fs.writeFileSync(path.join(small, "stash.tmp"), "temporary stash\n");
  await page.click("button[title='Refresh']");
  await page.waitForFunction(() => [...document.querySelectorAll(".file-row")].some(row => row.textContent.includes("stash.tmp")));
  page.once("dialog", dialog => dialog.accept("Headless stash"));
  await page.click("button[title='Stash']");
  await waitUntil(() => git(small, "status", "--porcelain") === "", "stash");
  assert.match(git(small, "stash", "list", "-1"), /Headless stash/);
  await page.waitForFunction(() => !document.querySelector("button[title='Unstash']")?.disabled);
  await page.select(".theme-control select", "claude");
  await page.click("button[title='Unstash']");
  await page.waitForFunction(() => document.querySelector(".stash-menu")?.textContent.includes("Headless stash"));
  await page.screenshot({ path: path.join(screenshots, "claude-unstash-menu.png") });
  await page.click(".stash-menu-actions button:first-child");
  await waitUntil(() => fs.existsSync(path.join(small, "stash.tmp")), "stash apply file");
  assert.match(git(small, "stash", "list", "-1"), /Headless stash/, "Apply must keep the stash");
  fs.unlinkSync(path.join(small, "stash.tmp"));
  await page.waitForFunction(() => !document.querySelector("button[title='Unstash']")?.disabled);
  await page.click("button[title='Refresh']");
  await page.click("button[title='Unstash']");
  await page.waitForSelector(".stash-menu-actions button:last-child");
  await page.click(".stash-menu-actions button:last-child");
  await waitUntil(() => fs.existsSync(path.join(small, "stash.tmp")), "unstash file");
  await waitUntil(() => git(small, "stash", "list") === "", "stash pop");
  await page.waitForFunction(() => !document.querySelector(".stash-menu"));
  assert.equal(fs.readFileSync(path.join(small, "stash.tmp"), "utf8"), "temporary stash\n");
  await page.evaluate(() => [...document.querySelectorAll(".commit-row")].find(button => button.textContent.includes("Test UI commit"))?.click());
  await page.waitForFunction(() => document.querySelector(".detail-header h2")?.textContent.includes("Test UI commit"));
  await page.click(".file-row");
  await page.waitForSelector(".diff-line");
  assert.ok(await page.$eval(".details-tab:first-child", tab => tab.classList.contains("active")), "committed file must expand in Summary");
  await page.screenshot({ path: path.join(screenshots, "small-commit.png") });

  await openRepo(page, large);
  assert.equal(await page.$$eval(".notice-bar", items => items.length), 0, "switching repositories must clear old action notices");
  const originalLocationWidth = await page.$eval(".locations", element => element.getBoundingClientRect().width);
  const splitter = await page.$eval(".locations-splitter", element => { const bounds = element.getBoundingClientRect(); return { x: bounds.x + bounds.width / 2, y: bounds.y + 100 }; });
  await page.mouse.move(splitter.x, splitter.y);
  await page.mouse.down();
  await page.mouse.move(splitter.x + 36, splitter.y, { steps: 4 });
  await page.mouse.up();
  assert.ok((await page.$eval(".locations", element => element.getBoundingClientRect().width)) > originalLocationWidth, "locations splitter must resize the pane");
  await page.click(".ref-section:nth-child(2) .ref-folder");
  const remoteFolders = await page.$$(".ref-section:nth-child(2) .ref-folder");
  await remoteFolders[remoteFolders.length - 1].click();
  const before = await metrics(page);
  console.log("Large layout", JSON.stringify(before));
  assert.equal(before.footer.bottom, before.viewport, "footer must stay at bottom");
  assert.ok(before.listScrollHeight > before.listClientHeight, "locations must scroll internally");
  assert.equal(before.documentScrollHeight, before.viewport, "document must not overflow");
  await page.screenshot({ path: path.join(screenshots, "large-summary.png") });
  const start = Date.now();
  await page.click(".file-row");
  await page.waitForSelector(".diff-line");
  const fileClickMs = Date.now() - start;
  const after = await metrics(page);
  assert.equal(after.footer.bottom, after.viewport, "file diff must not move footer");
  await page.screenshot({ path: path.join(screenshots, "large-diff.png") });
  const allStart = Date.now();
  await page.click(".details-tab:nth-child(2)");
  await page.waitForSelector(".all-diff-card");
  const allClickMs = Date.now() - allStart;
  await page.waitForFunction(() => document.querySelectorAll(".all-diff-card .diff-content").length > 0);
  await page.evaluate(() => { const pane = document.querySelector(".details-scroll"); pane.scrollTop = pane.scrollHeight; });
  await page.waitForFunction(() => [...document.querySelectorAll(".all-diff-card")].at(-1)?.querySelector(".diff-content"));
  await page.evaluate(() => { document.querySelector(".details-scroll").scrollTop = 0; });
  await page.screenshot({ path: path.join(screenshots, "large-all-changes.png") });
  for (const selectedTheme of ["vscode", "sublime", "antigravity", "claude"]) {
    await page.select(".theme-control select", selectedTheme);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), selectedTheme);
  }
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "claude");
  await page.screenshot({ path: path.join(screenshots, "claude-theme.png") });
  await page.click("button.layout-toggle");
  await page.setViewport({ width: 960, height: 600, deviceScaleFactor: 1 });
  const compactWidth = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, footerBottom: document.querySelector(".statusbar").getBoundingClientRect().bottom, detailsHeight: document.querySelector(".details-pane").getBoundingClientRect().height }));
  assert.equal(compactWidth.document, compactWidth.viewport, "minimum-size layout must not overflow horizontally");
  assert.equal(compactWidth.footerBottom, 600, "minimum-size footer must stay visible");
  assert.ok(compactWidth.detailsHeight >= 200, "minimum-size details pane must remain usable");
  await page.screenshot({ path: path.join(screenshots, "compact-layout.png") });
  await page.setViewport({ width: 1429, height: 918, deviceScaleFactor: 1 });
  await page.click("button[title='Toggle locations']");
  assert.equal(await page.$$eval(".locations", items => items.length), 0);
  await page.click("button[title='Toggle locations']");
  assert.equal(await page.$$eval(".locations", items => items.length), 1);
  assert.equal((await metrics(page)).footer.bottom, 918);
  const bottomWidth = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, commits: document.querySelector(".commits-pane").getBoundingClientRect().right }));
  assert.equal(bottomWidth.document, bottomWidth.viewport, "bottom layout must not overflow horizontally");
  assert.ok(bottomWidth.commits <= bottomWidth.viewport, "history pane must fit viewport");
  await page.screenshot({ path: path.join(screenshots, "bottom-layout.png") });
  await page.click("button.layout-toggle");
  await page.click(".repo-tab:first-child .tab-main");
  assert.ok((await page.$eval(".statusbar", element => element.textContent)).includes(small));
  await page.click(".repo-tab:nth-child(2) .tab-main");
  assert.ok((await page.$eval(".statusbar", element => element.textContent)).includes(large));
  await page.click(".repo-tab:first-child .tab-close");
  assert.equal(await page.$$eval(".repo-tab", tabs => tabs.length), 1);
  await openRepo(page, lineRepo);
  await page.click(".summary-open-tab");
  await page.waitForSelector("button.line-number.selectable");
  assert.ok(await page.$eval(".details-tab:last-child", tab => tab.classList.contains("active")), "the open-tab button must show the dedicated file tab");
  assert.ok(Number.parseFloat(await page.$eval(".diff-content", element => getComputedStyle(element).fontSize)) >= 14, "diff code must be readable");
  const gutterNumbers = await page.evaluate(() => {
    const values = ["diff --git a/lines.txt b/lines.txt", " line 1", "-line 3", "+NEW 3", " line 4", "-line 25", "+NEW 25"];
    return values.map(value => {
      const row = [...document.querySelectorAll(".diff-line")].find(item => item.querySelector(".line-text")?.textContent === value);
      return [row?.querySelector(".old-line")?.textContent ?? null, row?.querySelector(".new-line")?.textContent ?? null];
    });
  });
  assert.deepEqual(gutterNumbers, [["", ""], ["1", "1"], ["3", ""], ["", "3"], ["4", "4"], ["25", ""], ["", "25"]], "diff gutter must show old and new file line numbers");
  const dragLines = await page.evaluate(() => ["-line 3", "+NEW 3"].map(value => {
    const rect = [...document.querySelectorAll(".diff-line")].find(row => row.querySelector(".line-text")?.textContent === value)?.querySelector("button.line-number")?.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }));
  await page.mouse.move(dragLines[0].x, dragLines[0].y);
  await page.mouse.down();
  await page.mouse.move(dragLines[1].x, dragLines[1].y, { steps: 4 });
  await page.mouse.up();
  assert.match(await page.$eval(".line-selection-toolbar", element => element.textContent), /2 lines selected/);
  assert.equal(await page.$eval(".line-selection-toolbar", element => element.dataset.mode), "lines");
  await clickChangedLine(page, "-line 3");
  await clickChangedLine(page, "+NEW 3");
  assert.equal(await page.$eval(".line-selection-toolbar", element => element.dataset.mode), "hunk", "clicking selected line numbers again must return to hunk mode");
  await page.screenshot({ path: path.join(screenshots, "hunk-mode.png") });
  await clickChangedLine(page, "-line 3");
  await clickChangedLine(page, "+NEW 25");
  assert.match(await page.$eval(".line-selection-toolbar", element => element.textContent), /2 lines selected/, "multiple lines should select without Shift");
  await clickChangedLine(page, "+NEW 25");
  await clickChangedLine(page, "-line 3");
  assert.equal(await page.$eval(".line-selection-toolbar", element => element.dataset.mode), "hunk");
  await clickChangedLine(page, "+NEW 3");
  await page.waitForFunction(() => document.querySelector(".line-selection-toolbar")?.textContent.includes("1 line selected"));
  await page.screenshot({ path: path.join(screenshots, "selected-diff-line.png") });
  await page.click(".stage-lines");
  await waitUntil(() => git(lineRepo, "diff", "--cached").includes("+NEW 3"), "single line staging");
  assert.ok(!git(lineRepo, "diff", "--cached").includes("-line 3"), "adjacent deleted line must remain unstaged");
  assert.ok(!git(lineRepo, "diff", "--cached").includes("NEW 25"), "other hunk must remain unstaged");
  await waitForAction(page);
  await page.evaluate(() => [...document.querySelectorAll(".summary-diff-card")].find(card => !card.querySelector(".file-tag"))?.querySelector(".summary-open-tab")?.click());
  await page.waitForSelector("button.line-number.selectable");
  await clickChangedLine(page, "-line 25");
  await clickChangedLine(page, "+NEW 25", true);
  assert.match(await page.$eval(".line-selection-toolbar", element => element.textContent), /2 lines selected/);
  await page.click(".stage-lines");
  await waitUntil(() => git(lineRepo, "diff", "--cached").includes("+NEW 25"), "range line staging");
  assert.ok(git(lineRepo, "diff", "--cached").includes("-line 25"), "selected deletion must stage with selected addition");
  await waitForAction(page);
  await page.evaluate(() => [...document.querySelectorAll(".summary-diff-card")].find(card => !card.querySelector(".file-tag"))?.querySelector(".summary-open-tab")?.click());
  await page.waitForSelector("button.line-number.selectable");
  await clickChangedLine(page, "+++prefixed");
  await page.click(".stage-lines");
  await waitUntil(() => git(lineRepo, "diff", "--cached").includes("+++prefixed"), "stage prefixed source line");
  assert.ok(!git(lineRepo, "diff", "--cached").includes("-line 15"), "unselected replacement line must remain unstaged");
  await waitForAction(page);
  await page.evaluate(() => [...document.querySelectorAll(".summary-diff-card")].find(card => card.querySelector(".file-tag") && card.querySelector(".file-path")?.textContent === "lines.txt")?.querySelector(".summary-open-tab")?.click());
  await page.waitForSelector("button.line-number.selectable");
  await clickChangedLine(page, "+NEW 3");
  assert.match(await page.$eval(".line-selection-toolbar .stage-lines", button => button.textContent), /Unstage Lines/);
  await page.click(".stage-lines");
  await waitUntil(() => !git(lineRepo, "diff", "--cached").includes("+NEW 3"), "line unstaging");
  await waitForAction(page);
  await page.evaluate(() => [...document.querySelectorAll(".summary-diff-card")].find(card => !card.querySelector(".file-tag") && card.querySelector(".file-path")?.textContent === "lines.txt")?.querySelector(".summary-open-tab")?.click());
  await page.waitForSelector("button.line-number.selectable");
  await clickChangedLine(page, "+NEW 3");
  page.once("dialog", dialog => dialog.accept());
  await page.click(".discard-selection");
  await waitUntil(() => !fs.readFileSync(path.join(lineRepo, "lines.txt"), "utf8").includes("NEW 3"), "discard selected line");
  await waitForAction(page);
  await page.evaluate(() => [...document.querySelectorAll(".diff-line")].find(row => row.querySelector(".line-text")?.textContent === "-line 15")?.querySelector(".line-text")?.click());
  assert.equal(await page.$eval(".line-selection-toolbar", element => element.dataset.mode), "hunk");
  assert.match(await page.$eval(".line-selection-toolbar", element => element.textContent), /Hunk 2 of \d+/);
  page.once("dialog", dialog => dialog.accept());
  await page.click(".discard-selection");
  await waitUntil(() => !git(lineRepo, "diff", "--", "lines.txt").includes("-line 15"), "discard selected hunk");
  await waitForAction(page);
  const realPath = process.env.GITFERRY_REAL_REPO;
  let realRepo;
  if (realPath) {
    await openRepo(page, realPath);
    const realStart = Date.now();
    await page.click(".commit-row");
    await page.waitForFunction(() => document.querySelector(".detail-header h2")?.textContent !== "Uncommitted changes");
    await page.waitForSelector(".file-row");
    const commitMs = Date.now() - realStart;
    const diffStart = Date.now();
    await page.click(".file-row");
    await page.waitForSelector(".diff-line");
    const diffMs = Date.now() - diffStart;
    const stateStart = Date.now();
    await bridge("repo_state", { path: realPath });
    const stateMs = Date.now() - stateStart;
    realRepo = { commitMs, diffMs, stateMs, layout: await metrics(page) };
    await page.screenshot({ path: path.join(screenshots, "real-commit-diff.png") });
  }
  assert.deepEqual(pageErrors, [], "browser must have no uncaught errors");
  console.log(JSON.stringify({ screenshots, fileClickMs, allClickMs, before, after, bottomWidth, compactWidth, realRepo, pageErrors }, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  if (vite) vite.kill();
  if (agent) agent.kill();
  // Keep screenshots for inspection; remove only the disposable repositories.
  for (const name of ["small", "large", "lines", "other", "remote.git"]) {
    const target = path.resolve(sandbox, name);
    if (path.dirname(target) !== path.resolve(sandbox)) throw new Error("Unexpected test cleanup path");
    if (fs.existsSync(target)) {
      try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
      catch (error) { console.error(`Could not remove disposable ${name}: ${error.message}`); }
    }
  }
});
