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
const agentPath = process.env.GITFERRY_AGENT_PATH || path.join(process.env.CARGO_TARGET_DIR || path.join(project, "target"), "debug", process.platform === "win32" ? "gitferry-agent.exe" : "gitferry-agent");
const chromePath = process.env.CHROME_PATH || (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : "/usr/bin/google-chrome");
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "gitferry-headless-"));
const screenshots = path.join(sandbox, "screenshots");
fs.mkdirSync(screenshots);
let browser, vite, agent;
let nextId = 0;
const pending = new Map();
const progressEvents = [];
let snapshotGate = null;

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args[0]}: ${result.stderr}`);
  return result.stdout.trim();
}

async function selectTheme(page, theme) {
  await page.click("button[title='Settings']");
  await page.select('select[aria-label="Color theme"]', theme);
  await page.click(".settings-footer button");
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

function makeWhitespaceRepo() {
  const folder = path.join(sandbox, "whitespace");
  fs.mkdirSync(folder);
  git(folder, "init", "-b", "main");
  git(folder, "config", "user.name", "GitFerry Test");
  git(folder, "config", "user.email", "gitferry@example.test");
  fs.writeFileSync(path.join(folder, "space.txt"), "alpha beta\nkeep\n");
  git(folder, "add", "space.txt");
  git(folder, "commit", "-m", "Initial whitespace");
  fs.writeFileSync(path.join(folder, "space.txt"), "alpha    beta\nkeep\n");
  return folder;
}

function makeConflictRepo() {
  const folder = path.join(sandbox, "conflicts");
  fs.mkdirSync(folder);
  git(folder, "init", "-b", "main");
  git(folder, "config", "user.name", "GitFerry Test");
  git(folder, "config", "user.email", "gitferry@example.test");
  fs.writeFileSync(path.join(folder, "shared.txt"), "base\n");
  git(folder, "add", ".");
  git(folder, "commit", "-m", "Base");
  git(folder, "switch", "-c", "topic");
  fs.writeFileSync(path.join(folder, "shared.txt"), "topic\n");
  git(folder, "commit", "-am", "Topic");
  git(folder, "switch", "main");
  fs.writeFileSync(path.join(folder, "shared.txt"), "main\n");
  git(folder, "commit", "-am", "Main");
  return folder;
}

function makeRebaseRepo() {
  const folder = path.join(sandbox, "rebase-plan");
  fs.mkdirSync(folder);
  git(folder, "init", "-b", "main");
  git(folder, "config", "user.name", "GitFerry Test");
  git(folder, "config", "user.email", "gitferry@example.test");
  fs.writeFileSync(path.join(folder, "base.txt"), "base\n");
  git(folder, "add", ".");
  git(folder, "commit", "-m", "Base");
  git(folder, "switch", "-c", "topic");
  for (const [name, subject] of [["a", "Add A"], ["b", "Add B"], ["c", "Add C"]]) {
    fs.writeFileSync(path.join(folder, `${name}.txt`), `${name}\n`);
    git(folder, "add", ".");
    git(folder, "commit", "-m", subject);
  }
  return folder;
}

async function clickChangedLine(page, text, shift = false) {
  const label = await page.evaluate(value => [...document.querySelectorAll(".diff-line")].find(row => row.dataset.copyPrefix === value[0] && row.querySelector(".line-text")?.textContent === value.slice(1))?.querySelector("button.line-number")?.getAttribute("aria-label"), text);
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
  if (command === "repo_snapshot" && snapshotGate) {
    const gate = snapshotGate;
    gate.paths.push(args.path);
    await gate.promise;
  }
  if (command === "repo_watch") return new Promise((resolve, reject) => {
    let watcher, timer;
    try {
      watcher = fs.watch(args.path, { recursive: true }, () => { clearTimeout(timer); watcher.close(); resolve(true); });
      timer = setTimeout(() => { watcher.close(); resolve(false); }, 5000);
    } catch (error) { reject(error); }
  });
  const commands = {
    repo_snapshot: ["snapshot", { path: args.path, offset: args.offset, limit: 100 }],
    repo_state: ["state", { path: args.path }],
    repo_rebase_plan: ["rebase_plan", { path: args.path, onto: args.onto }],
    repo_search: ["search", { path: args.path, query: args.query, offset: args.offset, limit: 100 }],
    repo_commit: ["commit_details", { path: args.path, hash: args.hash }],
    repo_file_history: ["file_history", { path: args.path, file: args.file, revision: args.revision, offset: args.offset, limit: 100 }],
    repo_blame: ["blame", { path: args.path, file: args.file, revision: args.revision, start_line: args.startLine, limit: 300 }],
    repo_tracked_files: ["tracked_files", { path: args.path, query: args.query, limit: 100 }],
    repo_diff: ["diff", { path: args.path, target: args.target, file: args.file, ignore_whitespace: args.ignoreWhitespace ?? false }],
    repo_read_file: ["read_file", { path: args.path, file: args.file }],
    repo_save_file: ["save_file", { path: args.path, file: args.file, content: args.content, expected_content: args.expectedContent, stage: args.stage }],
    repo_action: ["action", { path: args.path, action: args.operation, cancel_token: args.cancelToken }],
    repo_cancel: ["cancel", { token: args.token }],
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

async function submitActionDialog(page, { text, remote } = {}) {
  await page.waitForSelector(".action-dialog");
  if (text !== undefined) await page.locator(".action-dialog input").fill(text);
  if (remote !== undefined) await page.select(".action-dialog select", remote);
  await page.click(".action-dialog-submit");
  await page.waitForFunction(() => !document.querySelector(".action-dialog"));
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

async function openSummaryFile(page, file, target) {
  await page.click(".details-tab:first-child");
  await page.waitForFunction(({ file, target }) => [...document.querySelectorAll(".summary-diff-card")].some(card => card.querySelector(".file-path")?.textContent === file && Boolean(card.querySelector(".file-tag")) === (target === "STAGED")), {}, { file, target });
  await page.evaluate(({ file, target }) => [...document.querySelectorAll(".summary-diff-card")].find(card => card.querySelector(".file-path")?.textContent === file && Boolean(card.querySelector(".file-tag")) === (target === "STAGED"))?.querySelector(".summary-open-tab")?.click(), { file, target });
  await page.waitForFunction(value => document.querySelector(".diff-heading-target")?.textContent === value, {}, target);
}

async function selectFileView(page, name) {
  await page.evaluate(label => [...document.querySelectorAll(".file-view-switch button")].find(button => button.textContent.trim() === label)?.click(), name);
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
  fs.writeFileSync(path.join(small, "another-untracked.txt"), "second new file\n");
  const large = makeRepo("large", true);
  const lineRepo = makeLineRepo();
  const whitespaceRepo = makeWhitespaceRepo();
  const conflictRepo = makeConflictRepo();
  const rebaseRepo = makeRebaseRepo();
  const remote = path.join(sandbox, "remote.git");
  fs.mkdirSync(remote);
  git(remote, "init", "--bare", "-b", "main");
  git(small, "remote", "add", "origin", remote);
  git(small, "push", "-u", "origin", "main");
  agent = spawn(agentPath, [], { cwd: project, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  readline.createInterface({ input: agent.stdout }).on("line", line => {
    const response = JSON.parse(line);
    if (response.kind === "progress") { progressEvents.push(response.value); return; }
    const waiter = pending.get(response.id);
    if (waiter) { pending.delete(response.id); waiter.resolve(response); }
  });
  const plainWhitespace = await rpc("diff", { path: whitespaceRepo, target: "working", file: "space.txt" });
  const ignoredWhitespace = await rpc("diff", { path: whitespaceRepo, target: "working", file: "space.txt", ignore_whitespace: true });
  assert.match(plainWhitespace.value.text, /alpha    beta/);
  assert.equal(ignoredWhitespace.value.text, "", "ignore-whitespace diff must hide whitespace-only edits");
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
    window.__snapshotResponses = 0;
    new PerformanceObserver(list => window.__longTasks.push(...list.getEntries().map(item => Math.round(item.duration)))).observe({ entryTypes: ["longtask"] });
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1,
      unregisterCallback: () => {},
      invoke: async (command, args) => {
        const result = await window.__gitferryInvoke(command, args);
        if (command === "repo_snapshot") window.__snapshotResponses++;
        return result;
      },
    };
  });
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("dialog", dialog => { pageErrors.push(`Unexpected browser dialog: ${dialog.type()}`); void dialog.dismiss(); });
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
  await page.waitForSelector(".summary-diff-card .diff-content");
  const snapshotResponses = await page.evaluate(() => {
    window.__unchangedCard = [...document.querySelectorAll(".summary-diff-card")].find(card => card.querySelector(".file-path")?.textContent === "new.txt");
    return window.__snapshotResponses;
  });
  await page.click("button[title='Refresh']");
  await page.waitForFunction(count => window.__snapshotResponses > count, {}, snapshotResponses);
  assert.equal(await page.evaluate(() => document.contains(window.__unchangedCard)), true, "refresh must preserve an unchanged file card and its loaded diff");
  const groupExpanded = name => page.evaluate(groupName => {
    const heading = [...document.querySelectorAll(".file-group-heading")].find(item => item.textContent.trim().startsWith(groupName));
    if (!heading) return null;
    const rows = [];
    for (let node = heading.nextElementSibling; node && !node.classList.contains("file-group-heading"); node = node.nextElementSibling) {
      const row = node.querySelector(".file-row");
      if (row) rows.push(row.getAttribute("aria-expanded"));
    }
    return rows;
  }, name);
  assert.deepEqual(await groupExpanded("UNSTAGED"), ["true"]);
  assert.deepEqual(await groupExpanded("UNTRACKED"), ["true", "true"]);
  assert.equal(await page.$eval(".summary-diff-card", () => {
    const card = [...document.querySelectorAll(".summary-diff-card")].find(item => item.querySelector(".file-path")?.textContent === "new.txt");
    return card.querySelector(".file-actions button").textContent;
  }), "Stage file", "untracked files must not be labeled as conflicts");
  const groupControl = await page.evaluate(() => {
    const heading = [...document.querySelectorAll(".file-group-heading")].find(item => item.textContent.trim().startsWith("UNTRACKED"));
    const button = heading.querySelector(".group-disclosure");
    const bounds = heading.getBoundingClientRect();
    const title = heading.querySelector(".file-group-title").getBoundingClientRect();
    return { text: button.textContent.trim(), hasIcon: Boolean(button.querySelector("svg")), width: button.getBoundingClientRect().width, headingWidth: bounds.width,
      iconRight: button.querySelector("svg").getBoundingClientRect().right, titleLeft: title.left,
      rightEdge: { x: bounds.right - 8, y: bounds.top + bounds.height / 2 }, titleCenter: { x: title.left + title.width / 2, y: title.top + title.height / 2 } };
  });
  assert.match(groupControl.text, /^UNTRACKED 2$/, "group heading should expose the file count");
  assert.equal(groupControl.hasIcon, true);
  assert.ok(groupControl.width >= groupControl.headingWidth - 1 && groupControl.iconRight < groupControl.titleLeft, "the whole heading must be clickable with the icon on the left");
  await page.mouse.click(groupControl.rightEdge.x, groupControl.rightEdge.y);
  assert.deepEqual(await groupExpanded("UNTRACKED"), ["false", "false"], "clicking the far right of the heading must close its files");
  await page.mouse.click(groupControl.titleCenter.x, groupControl.titleCenter.y);
  assert.deepEqual(await groupExpanded("UNTRACKED"), ["true", "true"], "clicking the heading label must reopen its files");
  await page.click("button[aria-label='Close all unstaged changes']");
  assert.deepEqual(await groupExpanded("UNSTAGED"), ["false"]);
  assert.deepEqual(await groupExpanded("UNTRACKED"), ["true", "true"]);
  await page.click("button[aria-label='Close all untracked changes']");
  assert.deepEqual(await groupExpanded("UNTRACKED"), ["false", "false"]);
  await page.click("button[aria-label='Open all unstaged changes']");
  await page.click("button[aria-label='Open all untracked changes']");
  await page.screenshot({ path: path.join(screenshots, "summary-open-groups.png") });
  const textSizes = await page.evaluate(() => Object.fromEntries([
    ".commit-editor-actions label", ".commit-editor-actions button", ".commit-editor textarea",
    ".file-row", ".commit-meta", ".section-heading", ".statusbar",
  ].map(selector => [selector, Number.parseFloat(getComputedStyle(document.querySelector(selector)).fontSize)])));
  for (const [selector, size] of Object.entries(textSizes)) assert.ok(size >= 13, `${selector} must be readable: ${size}px`);
  assert.ok(textSizes[".commit-editor-actions label"] >= 14, "amend control must use larger text");
  assert.ok(textSizes[".commit-editor-actions button"] >= 14, "commit button must use larger text");
  await page.waitForSelector(".diff-line");
  await page.click(".whitespace-toggle");
  await page.waitForFunction(() => document.querySelector(".whitespace-toggle")?.getAttribute("aria-pressed") === "true");
  assert.equal(await page.$$(".hunk-action").then(items => items.length), 0, "filtered hunks must not be stageable");
  await page.click(".whitespace-toggle");
  await page.waitForSelector(".hunk-action");
  assert.ok(await page.$eval(".details-tab:first-child", tab => tab.classList.contains("active")), "opening a Summary file must keep Summary active");
  assert.equal(await page.$eval(".file-row", row => row.getAttribute("aria-expanded")), "true");
  assert.match(await page.$eval(".diff-content", element => element.innerText), /two changed|new file/);
  await page.click(".file-row");
  assert.equal(await page.$eval(".file-row", row => row.getAttribute("aria-expanded")), "false");
  await page.click(".file-row");
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
  await page.evaluate(() => [...document.querySelectorAll(".summary-diff-card")].find(card => card.querySelector(".file-path")?.textContent === "base.txt")?.querySelector(".summary-open-tab")?.click());
  await page.waitForSelector(".file-view-switch");
  await page.evaluate(() => [...document.querySelectorAll(".file-view-switch button")].find(button => button.textContent.trim() === "Edit")?.click());
  await page.waitForSelector('.file-edit-textarea[aria-label="Edit base.txt"]');
  await page.locator(".file-edit-textarea").fill("one\ntwo edited in GitFerry\nthree\n");
  await shortcut(page, "s");
  await waitUntil(() => fs.readFileSync(path.join(small, "base.txt"), "utf8").includes("two edited in GitFerry"), "save unstaged edit");
  await page.waitForFunction(() => document.querySelector(".file-edit-save")?.textContent.trim() === "Save · Ctrl+S" && document.querySelector(".file-edit-save")?.disabled);
  assert.equal(git(small, "diff", "--cached", "--", "base.txt"), "", "editing an unstaged file must not stage it");
  await page.click(".details-tab:first-child");
  fs.writeFileSync(path.join(small, "new.txt"), "new file\r\n");
  await page.click("button[title='Refresh']");
  await page.evaluate(() => [...document.querySelectorAll(".summary-diff-card")].find(card => card.querySelector(".file-path")?.textContent === "new.txt")?.querySelector(".summary-open-tab")?.click());
  await page.waitForSelector(".file-view-switch");
  await page.evaluate(() => [...document.querySelectorAll(".file-view-switch button")].find(button => button.textContent.trim() === "Edit")?.click());
  await page.waitForSelector('.file-edit-textarea[aria-label="Edit new.txt"]');
  await page.locator(".file-edit-textarea").fill("new file\nsecond\n");
  await shortcut(page, "s");
  await waitUntil(() => fs.readFileSync(path.join(small, "new.txt"), "utf8") === "new file\r\nsecond\r\n", "preserve CRLF on save");
  await page.waitForFunction(() => document.querySelector(".file-edit-save")?.textContent.trim() === "Save · Ctrl+S" && document.querySelector(".file-edit-save")?.disabled);
  await page.click(".details-tab:first-child");
  assert.equal(await page.$$(".details-tab").then(tabs => tabs.length), 1, "changes must use one Summary tab");
  await page.evaluate(() => [...document.querySelectorAll(".files-heading button")].find(button => button.textContent.trim() === "Collapse all")?.click());
  assert.equal(await page.$eval(".file-row", row => row.getAttribute("aria-expanded")), "false");
  await page.evaluate(() => [...document.querySelectorAll(".files-heading button")].find(button => button.textContent.trim() === "Expand all")?.click());
  assert.equal(await page.$eval(".file-row", row => row.getAttribute("aria-expanded")), "true");
  assert.equal(await page.$eval(".files-heading button:last-child", item => item.textContent.trim()), "Stage All");
  await page.click(".files-heading button:last-child");
  await page.waitForFunction(() => [...document.querySelectorAll(".file-group-heading")].some(item => item.textContent.trim().startsWith("STAGED ")) || document.querySelector(".error-bar"));
  assert.ok(git(small, "diff", "--cached", "--name-only"), await page.$eval(".error-bar", item => item.textContent).catch(() => "Stage All did not stage files"));
  await waitForAction(page);
  await page.evaluate(() => [...document.querySelectorAll(".summary-diff-card")].find(card => card.querySelector(".file-path")?.textContent === "base.txt" && card.querySelector(".file-tag"))?.querySelector(".summary-open-tab")?.click());
  await page.waitForSelector(".file-view-switch");
  await page.evaluate(() => [...document.querySelectorAll(".file-view-switch button")].find(button => button.textContent.trim() === "Edit")?.click());
  await page.waitForSelector('.file-edit-textarea[aria-label="Edit base.txt"]');
  await page.locator(".file-edit-textarea").fill("one\ntwo staged in GitFerry\nthree\n");
  await shortcut(page, "s");
  await waitUntil(() => git(small, "show", ":base.txt").includes("two staged in GitFerry"), "save staged edit");
  await page.waitForFunction(() => document.querySelector(".file-edit-save")?.textContent.trim() === "Save · Ctrl+S" && document.querySelector(".file-edit-save")?.disabled);
  assert.equal(git(small, "diff", "--", "base.txt"), "", "saving a staged file must stage the full edited contents");
  await page.screenshot({ path: path.join(screenshots, "in-app-file-editor.png") });
  await page.click(".details-tab:first-child");
  await page.locator(".commit-editor textarea").fill("Test UI commit");
  await shortcut(page, "Enter");
  await page.waitForFunction(() => document.querySelector(".commit-subject")?.textContent.includes("Test UI commit"));
  assert.equal(git(small, "log", "-1", "--pretty=%s"), "Test UI commit");
  await waitForAction(page);
  await page.click("button[title='Push']");
  await page.waitForFunction(() => document.querySelector(".notice-bar")?.textContent.includes("main"));
  await page.waitForFunction(() => !document.querySelector("button[title='Fetch']")?.disabled);
  assert.equal(git(remote, "rev-parse", "refs/heads/main"), git(small, "rev-parse", "HEAD"));
  assert.ok(progressEvents.length, "Git transfer progress must stream before the final RPC response");
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
  await page.click(".push-menu button[title='Force push with lease']");
  await submitActionDialog(page);
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
  await page.click(".push-menu button[title='Force push with lease']");
  await submitActionDialog(page);
  await waitUntil(() => git(remote, "rev-parse", "refs/heads/main") === git(small, "rev-parse", "HEAD"), "force push with lease");
  await waitForAction(page);
  assert.equal(git(remote, "rev-parse", "refs/heads/extra"), advancedRemote, "force push must leave other branches untouched");
  await page.click("button[title='Delete a remote branch by name']");
  assert.equal(await page.$eval(".action-dialog select", select => select.value), "origin");
  await submitActionDialog(page, { text: "extra" });
  await waitUntil(() => git(remote, "branch", "--list", "extra") === "", "remote branch deletion dialog");
  await waitForAction(page);
  git(small, "tag", "ui-remote-tag");
  await page.click("button[title='Refresh']");
  await page.waitForSelector('[aria-label="Actions for ui-remote-tag"]');
  await page.evaluate(() => document.querySelector('[aria-label="Actions for ui-remote-tag"]')?.click());
  await page.evaluate(() => [...document.querySelectorAll(".ref-action-popover button")].find(button => button.textContent.includes("Push tag"))?.click());
  assert.equal(await page.$eval(".action-dialog select", select => select.value), "origin");
  await submitActionDialog(page);
  await waitUntil(() => git(remote, "tag", "--list", "ui-remote-tag") === "ui-remote-tag", "remote tag push dialog");
  await waitForAction(page);
  await page.evaluate(() => document.querySelector('[aria-label="Actions for ui-remote-tag"]')?.click());
  await page.evaluate(() => [...document.querySelectorAll(".ref-action-popover button")].find(button => button.textContent.includes("Delete remote tag"))?.click());
  await submitActionDialog(page);
  await waitUntil(() => git(remote, "tag", "--list", "ui-remote-tag") === "", "remote tag deletion dialog");
  await waitForAction(page);
  await page.locator(".search-box input").fill("Test UI commit");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".commits-pane .pane-heading")?.textContent.includes("SEARCH RESULTS"));
  await page.waitForFunction(() => document.querySelector(".commit-scroll")?.textContent.includes("Test UI commit") || document.querySelector(".error-bar"));
  assert.ok((await page.$eval(".commit-scroll", element => element.textContent)).includes("Test UI commit"));
  assert.equal(await page.$$(".graph-canvas").then(items => items.length), 0, "Search results must not show partial graph lanes");
  await page.click(".search-box button");
  await page.waitForSelector(".graph-canvas");
  git(remote, "update-ref", "refs/heads/team/ui-track", git(small, "rev-parse", "HEAD"));
  git(small, "fetch", "origin");
  git(small, "remote", "set-head", "origin", "-a");
  await page.click("button[title='Refresh']");
  await page.waitForSelector(".branch-chip");
  await page.click(".branch-chip");
  await page.waitForSelector(".branch-menu-remote button[title='Create tracking branch from origin/team/ui-track']");
  assert.equal(await page.$$(".branch-menu-remote button[title='Create tracking branch from origin/HEAD']").then(items => items.length), 0, "remote HEAD alias must not appear");
  await page.locator(".branch-menu-filter").fill("TEAM/UI");
  assert.equal(await page.$$(".branch-menu-row:not(.branch-menu-remote)").then(items => items.length), 0, "filter must hide nonmatching local branches");
  assert.equal(await page.$$(".branch-menu-remote").then(items => items.length), 1, "filter must find remote branches case-insensitively");
  await page.click(".branch-menu-remote button");
  await waitUntil(() => git(small, "branch", "--show-current") === "team/ui-track", "remote tracking checkout");
  await waitForAction(page);
  assert.equal(git(small, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"), "origin/team/ui-track");
  await page.click(".branch-chip");
  await page.locator(".branch-menu-filter").fill("main");
  await page.click(".branch-menu-row:not(.branch-menu-remote) button:first-child");
  await waitUntil(() => git(small, "branch", "--show-current") === "main", "switch back to main");
  await waitForAction(page);
  const longBranch = "feat/x-mac-warmup-gologin-driver-visibility-check";
  await page.click(".branch-chip");
  await page.locator(".branch-menu form input").fill(longBranch);
  await page.click(".branch-menu form button");
  await waitUntil(() => git(small, "branch", "--show-current") === longBranch, "branch creation").catch(async error => { throw new Error(`${error.message}: ${await page.$eval(".error-bar", item => item.textContent).catch(() => "no UI error")}`); });
  await page.waitForFunction(branch => document.querySelector(".branch-name")?.textContent === branch, {}, longBranch);
  assert.equal(git(small, "branch", "--show-current"), longBranch);
  await waitForAction(page);
  await page.click("button[title='Push']");
  await waitUntil(() => git(remote, "branch", "--list", longBranch).includes(longBranch), "new branch push");
  assert.equal(git(remote, "rev-parse", `refs/heads/${longBranch}`), git(small, "rev-parse", "HEAD"));
  await waitForAction(page);
  assert.equal(git(small, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"), `origin/${longBranch}`);
  const branchFits = () => page.$eval(".branch-chip", chip => { const name = chip.querySelector(".branch-name"); return { text: name.textContent, clipped: name.scrollWidth > name.clientWidth || name.scrollHeight > name.clientHeight, chipRight: chip.getBoundingClientRect().right, viewport: innerWidth, document: document.documentElement.scrollWidth }; });
  for (const width of [1429, 960]) {
    await page.setViewport({ width, height: 918, deviceScaleFactor: 1 });
    const layout = await branchFits();
    assert.equal(layout.text, longBranch);
    assert.equal(layout.clipped, false, `branch name must be fully visible at ${width}px`);
    assert.ok(layout.chipRight <= layout.viewport, `branch chip must fit at ${width}px`);
    assert.equal(layout.document, layout.viewport, `toolbar must not overflow at ${width}px`);
    if (width === 1429) await page.screenshot({ path: path.join(screenshots, "long-branch-desktop.png") });
  }
  await page.screenshot({ path: path.join(screenshots, "long-branch-compact.png") });
  await page.setViewport({ width: 1429, height: 918, deviceScaleFactor: 1 });
  await page.click(".branch-chip");
  await page.evaluate(() => [...document.querySelectorAll(".branch-menu-row button")].find(button => button.textContent.trim() === "main")?.click());
  await page.waitForFunction(() => document.querySelector(".branch-chip")?.textContent.includes("main"));
  assert.equal(git(small, "branch", "--show-current"), "main");
  await page.waitForFunction(() => !document.querySelector("button[title='Fetch']")?.disabled);
  await page.click(".branch-chip");
  await page.evaluate(branch => [...document.querySelectorAll(".branch-menu-row")].find(row => row.textContent.includes(branch))?.querySelector(".branch-delete")?.click(), longBranch);
  await submitActionDialog(page);
  await waitUntil(() => !git(small, "branch", "--list", longBranch), "branch deletion");
  await page.waitForFunction(() => !document.querySelector("button[title='Fetch']")?.disabled);
  await page.click(".working-row");
  fs.writeFileSync(path.join(small, "base.txt"), "temporary unwanted change\n");
  await page.waitForFunction(() => [...document.querySelectorAll(".file-row")].some(row => row.textContent.includes("base.txt")), { timeout: 10000 });
  await page.evaluate(() => { const row = [...document.querySelectorAll(".file-row")].find(item => item.textContent.includes("base.txt")); if (row?.getAttribute("aria-expanded") === "false") row.click(); });
  await page.waitForSelector(".file-actions .danger");
  await page.click(".file-actions .danger");
  await submitActionDialog(page);
  await waitUntil(() => git(small, "status", "--porcelain") === "", "discard file").catch(async error => {
    throw new Error(`${error.message}: ${await page.$eval(".error-bar", item => item.textContent).catch(() => "no UI error")}; status=${git(small, "status", "--short")}`);
  });
  await page.waitForFunction(() => !document.querySelector("button[title='Fetch']")?.disabled);
  fs.writeFileSync(path.join(small, "stash.tmp"), "temporary stash\n");
  await page.click("button[title='Refresh']");
  await page.waitForFunction(() => [...document.querySelectorAll(".file-row")].some(row => row.textContent.includes("stash.tmp")));
  await page.click("button[title='Stash']");
  await page.waitForSelector(".action-dialog input");
  assert.equal(await page.$eval(".action-dialog input", input => input.value), "Work in progress");
  await submitActionDialog(page, { text: "Headless stash" });
  await waitUntil(() => git(small, "status", "--porcelain") === "", "stash").catch(async error => {
    throw new Error(`${error.message}: ${await page.$eval(".error-bar", item => item.textContent).catch(() => "no UI error")}; status=${git(small, "status", "--short")}`);
  });
  assert.match(git(small, "stash", "list", "-1"), /Headless stash/);
  await page.waitForFunction(() => [...document.querySelectorAll(".commit-subject")].some(item => item.textContent.includes("Headless stash")));
  assert.equal(await page.$$eval(".commit-subject", items => items.some(item => /^(index on|untracked files on) /i.test(item.textContent.trim()))), false, "stash helper commits must be absent from history");
  await page.waitForFunction(() => !document.querySelector("button[title='Unstash']")?.disabled);
  await selectTheme(page, "claude");
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
  await page.waitForFunction(() => document.querySelector(".detail-header .commit-message")?.textContent.includes("Test UI commit"));
  await page.waitForSelector(".diff-line");
  assert.ok(await page.$eval(".details-tab:first-child", tab => tab.classList.contains("active")), "committed file must expand in Summary");
  await page.screenshot({ path: path.join(screenshots, "small-commit.png") });

  await openRepo(page, conflictRepo);
  await page.click("button[title='More pull options']");
  assert.match(await page.$eval(".push-menu", item => item.textContent), /Pull with merge/);
  assert.match(await page.$eval(".push-menu", item => item.textContent), /Pull with rebase/);
  await page.click(".branch-chip");
  await page.click("button[title='Rebase main onto topic']");
  await submitActionDialog(page);
  await page.waitForFunction(() => document.querySelector(".operation-panel")?.textContent.includes("rebase"));
  await page.waitForFunction(() => !document.querySelector(".operation-buttons button:last-child")?.disabled);
  assert.equal(git(conflictRepo, "status", "--porcelain").includes("UU shared.txt"), true);
  await page.screenshot({ path: path.join(screenshots, "rebase-conflict.png") });
  await page.click(".operation-buttons button:last-child");
  await submitActionDialog(page);
  await page.waitForFunction(() => !document.querySelector(".operation-panel"));
  await waitForAction(page);
  assert.equal(git(conflictRepo, "branch", "--show-current"), "main");
  await page.click(".branch-chip");
  await page.click("button[title='Merge topic into main']");
  await submitActionDialog(page);
  await page.waitForFunction(() => document.querySelector(".operation-panel")?.textContent.includes("merge"));
  await page.waitForFunction(() => !document.querySelector(".conflict-row button:first-of-type")?.disabled);
  await page.click(".conflict-row button:first-of-type");
  await submitActionDialog(page);
  await page.waitForFunction(() => document.querySelector(".operation-panel") && !document.querySelector(".conflict-row"));
  await page.waitForFunction(() => !document.querySelector(".operation-buttons button:first-child")?.disabled);
  assert.equal(fs.readFileSync(path.join(conflictRepo, "shared.txt"), "utf8"), "main\n");
  await page.click(".operation-buttons button:first-child");
  await page.waitForFunction(() => !document.querySelector(".operation-panel"));
  await waitForAction(page);
  assert.equal(git(conflictRepo, "rev-list", "--parents", "-n", "1", "HEAD").split(" ").length, 3);
  await page.click(".commit-row");
  await page.waitForSelector(".commit-actions summary");
  assert.equal(await page.$(".in-app-edit-button"), null, "Committed files must not show the in-app edit control");
  await page.click(".commit-actions summary");
  await page.evaluate(() => [...document.querySelectorAll(".commit-actions button")].find(button => button.textContent === "Create tag")?.click());
  await page.waitForSelector(".action-dialog input");
  assert.equal(await page.$eval(".action-dialog-submit", button => button.disabled), true, "Blank tag name should disable creation");
  await submitActionDialog(page, { text: "ui-test-tag" });
  await page.waitForFunction(() => document.querySelector(".commit-actions")?.textContent.includes("Delete tag ui-test-tag"));
  assert.equal(git(conflictRepo, "rev-parse", "refs/tags/ui-test-tag"), git(conflictRepo, "rev-parse", "HEAD"));
  await page.waitForFunction(() => ![...document.querySelectorAll(".commit-actions button")].find(button => button.textContent === "Delete tag ui-test-tag")?.disabled);
  await page.evaluate(() => [...document.querySelectorAll(".commit-actions button")].find(button => button.textContent === "Delete tag ui-test-tag")?.click());
  await submitActionDialog(page);
  await waitUntil(() => !git(conflictRepo, "tag", "--list", "ui-test-tag"), "delete tag");
  await waitForAction(page);
  await page.click(".repo-tab:nth-child(2) .tab-close");

  await openRepo(page, rebaseRepo);
  await page.click(".branch-chip");
  await page.click("button[title='Plan an interactive rebase onto main']");
  await page.waitForSelector(".rebase-modal .rebase-step:nth-child(3)");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector(".rebase-modal"));
  await page.click(".branch-chip");
  await page.click("button[title='Plan an interactive rebase onto main']");
  await page.waitForSelector(".rebase-modal .rebase-step:nth-child(3)");
  assert.match(await page.$eval(".rebase-intro", element => element.textContent), /topic onto main/);
  assert.deepEqual(await page.$$eval(".rebase-step:first-child select option", options => options.map(option => option.value)), ["pick", "reword", "edit", "squash", "fixup", "drop"]);
  await page.select(".rebase-step:first-child select", "reword");
  await page.waitForSelector("textarea[aria-label='New message for Add A']");
  await page.locator("textarea[aria-label='New message for Add A']").fill("Reworded A\n\nDetails");
  assert.equal(await page.$eval("textarea[aria-label='New message for Add A']", element => element.value), "Reworded A\n\nDetails");
  await page.select(".rebase-step:first-child select", "pick");
  await page.select(".rebase-step:first-child select", "squash");
  assert.equal(await page.$eval(".rebase-start", button => button.disabled), true);
  await page.select(".rebase-step:first-child select", "pick");
  await page.click(".rebase-step:nth-child(2) .rebase-move button:first-child");
  assert.match(await page.$eval(".rebase-step:first-child", element => element.textContent), /Add B/);
  await page.select(".rebase-step:first-child select", "drop");
  await page.select(".rebase-step:nth-child(3) select", "fixup");
  await page.screenshot({ path: path.join(screenshots, "interactive-rebase-plan.png") });
  await page.click(".rebase-start");
  await waitForAction(page);
  await waitUntil(() => git(rebaseRepo, "log", "--format=%s", "main..topic") === "Add A", "interactive rebase");
  assert.equal(fs.existsSync(path.join(rebaseRepo, "b.txt")), false, "dropped commit must not appear");
  assert.equal(fs.readFileSync(path.join(rebaseRepo, "c.txt"), "utf8"), "c\n", "fixup content must be kept");
  await page.click(".repo-tab:nth-child(2) .tab-close");

  await openRepo(page, large);
  assert.equal(await page.$eval(".file-row", row => row.getAttribute("aria-expanded")), "false", "large repositories should open with stable collapsed file rows");
  const initialFileHeight = await page.$eval(".details-scroll", pane => pane.scrollHeight);
  await page.evaluate(() => { document.querySelector(".details-scroll").scrollTop = document.querySelector(".details-scroll").scrollHeight; });
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(await page.$eval(".details-scroll", pane => pane.scrollHeight), initialFileHeight, "scrolling a large collapsed file list must not change scrollbar size");
  await page.evaluate(() => { document.querySelector(".details-scroll").scrollTop = 0; });
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
  await page.evaluate(() => [...document.querySelectorAll(".files-heading button")].find(button => button.textContent.trim() === "Expand all")?.click());
  const allClickMs = Date.now() - allStart;
  assert.equal(await page.$$(".details-tab").then(tabs => tabs.length), 1, "Summary and All Changes must share one tab");
  await page.waitForFunction(() => document.querySelectorAll(".all-diff-card .diff-content").length > 0);
  await page.evaluate(() => { const pane = document.querySelector(".details-scroll"); pane.scrollTop = pane.scrollHeight; });
  await page.waitForFunction(() => [...document.querySelectorAll(".all-diff-card")].at(-1)?.querySelector(".diff-content"));
  await page.evaluate(() => { document.querySelector(".details-scroll").scrollTop = 0; });
  await page.screenshot({ path: path.join(screenshots, "large-merged-changes.png") });
  for (const selectedTheme of ["vscode", "sublime", "antigravity", "claude"]) {
    await selectTheme(page, selectedTheme);
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
  await selectFileView(page, "History");
  await page.waitForSelector(".file-history-row");
  assert.match(await page.$eval(".file-history-row", row => row.textContent), /Initial lines/);
  await selectFileView(page, "Blame");
  await page.waitForSelector(".blame-row");
  assert.equal(await page.$eval(".blame-row .blame-content", code => code.textContent), "line 1");
  assert.equal(await page.$$eval(".blame-row", rows => rows.length), 30);
  await selectFileView(page, "Diff");
  await page.waitForSelector("button.line-number.selectable");
  await page.click(".details-tab:first-child");
  await page.evaluate(() => [...document.querySelectorAll(".files-heading button")].find(button => button.textContent === "Browse files")?.click());
  await page.waitForSelector(".file-finder-modal");
  await page.locator(".file-finder-modal input").fill("lines.txt");
  await page.waitForSelector(".file-finder-list button");
  await page.click(".file-finder-list button");
  await page.waitForSelector(".file-history-row");
  assert.equal(await page.$eval(".diff-heading-target", target => target.textContent), "TRACKED");
  await page.click(".details-tab:first-child");
  await page.click(".summary-open-tab");
  await page.waitForSelector("button.line-number.selectable");
  assert.ok(await page.$eval(".details-tab:last-child", tab => tab.classList.contains("active")), "the open-tab button must show the dedicated file tab");
  assert.ok(Number.parseFloat(await page.$eval(".diff-content", element => getComputedStyle(element).fontSize)) >= 14, "diff code must be readable");
  const gutterNumbers = await page.evaluate(() => {
    const values = ["diff --git a/lines.txt b/lines.txt", " line 1", "-line 3", "+NEW 3", " line 4", "-line 25", "+NEW 25"];
    return values.map(value => {
      const row = [...document.querySelectorAll(".diff-line")].find(item => item.dataset.copyPrefix === (value.startsWith("diff --git") ? "" : value[0]) && item.querySelector(".line-text")?.textContent === (value.startsWith("diff --git") ? value : value.slice(1)));
      return [row?.querySelector(".old-line")?.textContent ?? null, row?.querySelector(".new-line")?.textContent ?? null];
    });
  });
  assert.deepEqual(gutterNumbers, [["", ""], ["1", "1"], ["3", ""], ["", "3"], ["4", "4"], ["25", ""], ["", "25"]], "diff gutter must show old and new file line numbers");
  const dragLines = await page.evaluate(() => ["-line 3", "+NEW 3"].map(value => {
    const rect = [...document.querySelectorAll(".diff-line")].find(row => row.dataset.copyPrefix === value[0] && row.querySelector(".line-text")?.textContent === value.slice(1))?.querySelector("button.line-number")?.getBoundingClientRect();
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
  await openSummaryFile(page, "lines.txt", "UNSTAGED");
  await page.waitForSelector("button.line-number.selectable");
  await clickChangedLine(page, "-line 25");
  await clickChangedLine(page, "+NEW 25", true);
  assert.match(await page.$eval(".line-selection-toolbar", element => element.textContent), /2 lines selected/);
  await page.click(".stage-lines");
  await waitUntil(() => git(lineRepo, "diff", "--cached").includes("+NEW 25"), "range line staging");
  assert.ok(git(lineRepo, "diff", "--cached").includes("-line 25"), "selected deletion must stage with selected addition");
  await waitForAction(page);
  await openSummaryFile(page, "lines.txt", "UNSTAGED");
  await page.waitForSelector("button.line-number.selectable");
  await clickChangedLine(page, "+++prefixed");
  await page.click(".stage-lines");
  await waitUntil(() => git(lineRepo, "diff", "--cached").includes("+++prefixed"), "stage prefixed source line");
  assert.ok(!git(lineRepo, "diff", "--cached").includes("-line 15"), "unselected replacement line must remain unstaged");
  await waitForAction(page);
  await openSummaryFile(page, "lines.txt", "STAGED");
  await page.waitForFunction(() => document.querySelector(".diff-heading-target")?.textContent === "STAGED" && [...document.querySelectorAll(".diff-content .diff-line.added")].some(row => row.querySelector(".line-text")?.textContent === "NEW 3"), { timeout: 8000 }).catch(async error => {
    const ui = await page.evaluate(() => ({ target: document.querySelector(".diff-heading-target")?.textContent, rows: [...document.querySelectorAll(".diff-content .diff-line")].map(row => [row.className, row.dataset.copyPrefix, row.querySelector(".line-text")?.textContent]).slice(0, 30), cards: [...document.querySelectorAll(".summary-diff-card")].map(card => [card.querySelector(".file-path")?.textContent, card.querySelector(".file-tag")?.textContent]), error: document.querySelector(".error-bar")?.textContent }));
    throw new Error(`${error.message}: ui=${JSON.stringify(ui)} cached=${git(lineRepo, "diff", "--cached", "--", "lines.txt")}`);
  });
  await clickChangedLine(page, "+NEW 3");
  assert.match(await page.$eval(".line-selection-toolbar .stage-lines", button => button.textContent), /Unstage Lines/);
  await page.click(".stage-lines");
  await waitUntil(() => !git(lineRepo, "diff", "--cached").includes("+NEW 3"), "line unstaging");
  await waitForAction(page);
  await openSummaryFile(page, "lines.txt", "UNSTAGED");
  await page.waitForFunction(() => document.querySelector(".diff-heading-target")?.textContent === "UNSTAGED" && [...document.querySelectorAll(".diff-content .diff-line.added")].some(row => row.querySelector(".line-text")?.textContent === "NEW 3"));
  await clickChangedLine(page, "+NEW 3");
  await page.click(".discard-selection");
  await submitActionDialog(page);
  await waitUntil(() => !fs.readFileSync(path.join(lineRepo, "lines.txt"), "utf8").includes("NEW 3"), "discard selected line");
  await waitForAction(page);
  await page.evaluate(() => [...document.querySelectorAll(".diff-line")].find(row => row.dataset.copyPrefix === "-" && row.querySelector(".line-text")?.textContent === "line 15")?.querySelector(".line-text")?.click());
  assert.equal(await page.$eval(".line-selection-toolbar", element => element.dataset.mode), "hunk");
  assert.match(await page.$eval(".line-selection-toolbar", element => element.textContent), /Hunk 2 of \d+/);
  await page.click(".discard-selection");
  await submitActionDialog(page);
  await waitUntil(() => !git(lineRepo, "diff", "--", "lines.txt").includes("-line 15"), "discard selected hunk");
  await waitForAction(page);
  let releaseSnapshots;
  snapshotGate = { paths: [], promise: new Promise(resolve => { releaseSnapshots = resolve; }) };
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".repo-startup");
  assert.equal(await page.$$eval(".repo-tab", items => items.length), 2, "all saved tabs must appear before snapshots finish");
  assert.equal(await page.$$eval(".welcome", items => items.length), 0, "saved repositories must bypass the first-run welcome screen");
  assert.match(await page.$eval(".repo-tab.active .tab-main", item => item.textContent), /lines/, "the last selected tab must be active immediately");
  await waitUntil(() => snapshotGate.paths.includes(large) && snapshotGate.paths.includes(lineRepo), "parallel restoration of both repositories");
  await page.screenshot({ path: path.join(screenshots, "restored-tabs-loading.png") });
  releaseSnapshots();
  snapshotGate = null;
  await page.waitForFunction(value => document.querySelector(".workspace") && document.querySelector(".statusbar")?.textContent.includes(value), {}, lineRepo);
  await page.waitForFunction(() => !document.querySelector(".repo-tab.loading"));
  assert.equal(await page.$$eval(".repo-tab", items => items.length), 2);
  assert.equal(await page.$$eval(".repo-tab.unavailable", items => items.length), 0);
  await page.screenshot({ path: path.join(screenshots, "restored-tabs-loaded.png") });
  const realPath = process.env.GITFERRY_REAL_REPO;
  let realRepo;
  if (realPath) {
    await openRepo(page, realPath);
    const realStart = Date.now();
    await page.click(".commit-row");
    await page.waitForSelector(".detail-header .commit-message");
    await page.waitForSelector(".file-row");
    const commitMs = Date.now() - realStart;
    const diffStart = Date.now();
    await page.click(".file-row");
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
  for (const name of ["small", "large", "lines", "whitespace", "conflicts", "rebase-plan", "other", "remote.git"]) {
    const target = path.resolve(sandbox, name);
    if (path.dirname(target) !== path.resolve(sandbox)) throw new Error("Unexpected test cleanup path");
    if (fs.existsSync(target)) {
      try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
      catch (error) { console.error(`Could not remove disposable ${name}: ${error.message}`); }
    }
  }
});
