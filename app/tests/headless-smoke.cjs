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
const actionRequests = [];
const invalidRevisionDiffs = [];
let snapshotGate = null;
let actionGate = null;
let saveGate = null;
let searchGate = null;
let diffRequests = 0;

function git(cwd, ...args) {
  const result = spawnSync("git", ["--no-optional-locks", ...args], { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args[0]}: ${result.stderr}`);
  return result.stdout.trim();
}

// Refreshes can replace a node between locating and clicking it; locators retry that race.
async function click(page, selector, options) {
  await page.locator(selector).click(options);
}

async function doubleClickDiffWord(page, lineText, word) {
  await page.waitForFunction(text => [...document.querySelectorAll(".diff-line .line-text")].some(line => line.textContent === text), {}, lineText);
  const point = await page.evaluate(({ lineText, word }) => {
    const line = [...document.querySelectorAll(".diff-line .line-text")].find(item => item.textContent === lineText);
    if (!line) throw new Error(`Missing diff line: ${lineText}`);
    line.scrollIntoView({ block: "nearest" });
    const nodes = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    for (let node = nodes.nextNode(); node; node = nodes.nextNode()) {
      const start = node.textContent.indexOf(word);
      if (start < 0) continue;
      const range = document.createRange();
      range.setStart(node, start); range.setEnd(node, start + 1);
      const rect = range.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }
    throw new Error(`Missing diff word: ${word}`);
  }, { lineText, word });
  // Let Chromium select the word itself; an artificial Range would miss the double-click bug.
  await page.mouse.click(point.x, point.y, { count: 2 });
  await page.waitForFunction(text => document.querySelector(".editor-input")?.value.includes(text), {}, lineText);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const selection = await page.evaluate(() => {
    const selected = window.getSelection();
    const anchor = selected?.anchorNode?.parentElement;
    const clipboard = new DataTransfer();
    anchor?.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: clipboard }));
    return { text: selected?.toString(), inDiff: Boolean(anchor?.closest(".diff-content")), editorFocused: document.activeElement?.classList.contains("editor-input"), copied: clipboard.getData("text/plain") };
  });
  assert.deepEqual(selection, { text: word, inDiff: true, editorFocused: false, copied: word }, "Opening the side editor must preserve the native diff selection and copying");
}

async function selectTheme(page, theme) {
  await click(page, "button[title='Settings']");
  await page.select('select[aria-label="Color theme"]', theme);
  await click(page, ".settings-footer button");
}

async function toggleIgnoreWhitespace(page) {
  await click(page, "button[title='Settings']");
  await click(page, ".settings-body label::-p-text(Ignore whitespace-only changes)");
  await click(page, ".settings-footer button");
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

function makeMcpRepo() {
  const folder = path.join(sandbox, "mcp");
  fs.mkdirSync(folder);
  git(folder, "init", "-b", "main");
  git(folder, "config", "user.name", "GitFerry Test");
  git(folder, "config", "user.email", "gitferry@example.test");
  fs.writeFileSync(path.join(folder, "code.txt"), "first\nold cause\nlast\n");
  git(folder, "add", "."); git(folder, "commit", "-m", "Base");
  fs.writeFileSync(path.join(folder, "code.txt"), "first\nnew cause\nlast\n");
  git(folder, "commit", "-am", "Introduce cause");
  const cause = git(folder, "rev-parse", "HEAD");
  const tree = git(folder, "rev-parse", "HEAD^{tree}");
  let head = cause;
  for (let index = 0; index < 103; index++) head = git(folder, "commit-tree", tree, "-p", head, "-m", `Later ${index}`);
  git(folder, "update-ref", "refs/heads/main", head);
  const worktree = path.join(sandbox, "mcp-topic");
  git(folder, "worktree", "add", "-b", "topic", worktree);
  return { folder, worktree, cause };
}

async function mcp(page, tool, args = {}) {
  return page.evaluate(({ tool, args }) => new Promise(resolve => {
    const id = ++window.__mcpId;
    window.__mcpWaiters.set(id, resolve);
    window.__eventCallbacks["mcp-request"]({ event: "mcp-request", payload: { id, tool, arguments: args, deadline: Date.now() + 45000 } });
  }), { tool, args });
}
async function exerciseMcp(page, repository, restore) {
  let reply = await mcp(page, "open_repository", { repository: repository.folder, branch: "main" });
  assert.equal(reply.error, null);
  await mcp(page, "open_repository", { repository: repository.worktree, branch: "topic" });
  reply = await mcp(page, "list_repositories");
  assert.equal(reply.result.repositories.find(tab => tab.path === repository.folder).branch, "main");
  assert.equal(reply.result.repositories.find(tab => tab.path === repository.worktree).branch, "topic");
  const tabCount = reply.result.repositories.length;
  // Enumeration must not mark an inactive tab refreshed without updating its history and refs.
  fs.writeFileSync(path.join(repository.folder, "external.txt"), "external commit\n");
  git(repository.folder, "add", "."); git(repository.folder, "commit", "-m", "External enumeration change");
  reply = await mcp(page, "list_repositories");
  assert.equal(reply.result.repositories.find(tab => tab.path === repository.folder).head, git(repository.folder, "rev-parse", "HEAD"));
  await click(page, '.tab-main[title^="mcp ·"]');
  await page.waitForFunction(() => document.querySelector(".commit-scroll")?.textContent.includes("External enumeration change"));
  await mcp(page, "open_repository", { repository: repository.worktree });
  fs.writeFileSync(path.join(repository.folder, "external.txt"), "external reveal\n");
  git(repository.folder, "commit", "-am", "External reveal change");
  reply = await mcp(page, "reveal_change", { repository: repository.folder, commit: repository.cause });
  assert.equal(reply.error, null);
  await page.waitForFunction(() => document.querySelector(".commit-scroll")?.textContent.includes("External reveal change"));
  await page.waitForSelector(".commit-actions summary");
  await click(page, ".commit-actions summary");
  await click(page, ".commit-actions button::-p-text(Reset hard)");
  await page.waitForSelector(".action-dialog");
  const heads = [repository.folder, repository.worktree].map(folder => git(folder, "rev-parse", "HEAD"));
  for (const tool of ["open_repository", "show_branch", "reveal_change", "reveal_file"]) {
    reply = await mcp(page, tool, { repository: repository.worktree, branch: "topic", commit: repository.cause });
    assert.match(reply.error, /dialog/, `${tool} must not navigate while a confirmation is open`);
  }
  // Simulate asynchronous navigation already started before the dialog appeared.
  await page.evaluate(() => document.querySelector('.tab-main[title^="mcp-topic"]')?.click());
  await submitActionDialog(page);
  await page.waitForFunction(() => document.querySelector(".error-bar")?.textContent.includes("Repository changed"));
  assert.deepEqual([repository.folder, repository.worktree].map(folder => git(folder, "rev-parse", "HEAD")), heads, "A confirmation from another tab must not execute");
  await click(page, "button[title='Dismiss error']");
  const alias = process.platform === "win32" ? repository.folder.replaceAll("\\", "/").toUpperCase() : `${repository.folder}/`;
  reply = await mcp(page, "open_repository", { repository: alias, branch: "main" });
  assert.equal(reply.error, null);
  assert.equal((await mcp(page, "list_repositories")).result.repositories.length, tabCount, "Reuse existing canonical tab");
  reply = await mcp(page, "open_repository", { repository: repository.folder, branch: "topic" });
  assert.match(reply.error, /expected topic/);
  reply = await mcp(page, "find_changes", { repository: repository.folder, query: "new cause", offset: 0 });
  assert.equal(reply.result.commits[0].hash, repository.cause);
  reply = await mcp(page, "reveal_change", { repository: repository.folder, branch: "main", commit: repository.cause, file: "code.txt", highlights: [
    { kind: "lines", side: "old", startLine: 2, quote: "old cause" },
    { kind: "lines", side: "new", startLine: 2, quote: "new cause" },
  ] });
  assert.equal(reply.error, null);
  assert.equal(reply.result.confirmed, true);
  assert.equal(reply.result.highlights.length, 2);
  assert.equal(await page.$$eval(".diff-line.ai-highlight", rows => rows.length), 2);
  assert.match(await page.$eval(".commit-row.selected", row => row.textContent), /Introduce cause/, "Reveal commits beyond the first history page");
  assert.equal(git(repository.folder, "branch", "--show-current"), "main");
  assert.equal(git(repository.folder, "diff"), "");
  await exerciseSearchPaging(page);
  reply = await mcp(page, "reveal_change", { repository: repository.folder, commit: repository.cause, file: "code.txt", highlights: [{ kind: "hunk", hunkIndex: 0 }] });
  assert.equal(reply.error, null);
  assert.ok(reply.result.highlights.length > 2);
  await click(page, "button[title='Clear AI highlights']");
  assert.equal(await page.$$eval(".diff-line.ai-highlight", rows => rows.length), 0);
  reply = await mcp(page, "reveal_change", { repository: repository.folder, commit: repository.cause, file: "code.txt", highlights: [{ kind: "lines", side: "old", startLine: 2, quote: "wrong" }] });
  assert.match(reply.error, /quote/);
  reply = await mcp(page, "show_branch", { repository: repository.worktree, branch: "main" });
  assert.equal(reply.error, null);
  assert.equal(reply.result.branch, "topic", "Browsing preserves the checked-out branch");
  assert.equal(git(repository.worktree, "branch", "--show-current"), "topic");
  fs.writeFileSync(path.join(repository.worktree, "topic-only.txt"), "topic side\n");
  git(repository.worktree, "add", "."); git(repository.worktree, "commit", "-m", "Topic side");
  const secondParent = git(repository.worktree, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(repository.folder, "main-only.txt"), "main side\n");
  git(repository.folder, "add", "."); git(repository.folder, "commit", "-m", "Main side");
  git(repository.folder, "merge", "--no-ff", "topic", "-m", "Merge topic");
  const merge = git(repository.folder, "rev-parse", "HEAD");
  reply = await mcp(page, "reveal_change", { repository: repository.folder, commit: merge, parent: secondParent, file: "main-only.txt", highlights: [{ kind: "lines", side: "new", startLine: 1, quote: "main side" }] });
  assert.equal(reply.error, null);
  assert.equal(reply.result.target, `${secondParent}..${merge}`);
  assert.equal(reply.result.highlights[0].newNumber, 1);
  git(repository.folder, "mv", "code.txt", "renamed.txt"); git(repository.folder, "commit", "-m", "Rename code");
  reply = await mcp(page, "file_history", { repository: repository.folder, file: "renamed.txt", revision: "HEAD", offset: 0 });
  assert.ok(reply.result.commits.some(commit => commit.hash === repository.cause));
  reply = await mcp(page, "reveal_change", { repository: repository.folder, commit: repository.cause, file: "code.txt", highlights: [{ kind: "lines", side: "new", startLine: 2 }] });
  assert.equal(reply.error, null, "Historical navigation uses the file path at the selected commit");
  git(repository.folder, "mv", "renamed.txt", "code.txt"); git(repository.folder, "commit", "-m", "Restore name");
  fs.writeFileSync(path.join(repository.folder, "code.txt"), "first\nworking cause\nlast\n");
  reply = await mcp(page, "reveal_change", { repository: repository.folder, commit: "working", file: "code.txt", highlights: [{ kind: "lines", side: "new", startLine: 2, quote: "working cause" }] });
  assert.equal(reply.error, null);
  assert.equal(await page.$$eval(".diff-line.ai-highlight.selected", rows => rows.length), 0, "AI highlights never select lines for staging");
  await clickChangedLine(page, "+working cause");
  reply = await mcp(page, "get_view");
  assert.ok(reply.result.selection.lines.some(row => row.newNumber === 2));
  await click(page, ".details-tab:first-child");
  await page.waitForSelector('.summary-diff-card[data-path="code.txt"] .diff-content');
  await clickChangedLine(page, "+working cause");
  reply = await mcp(page, "get_view");
  assert.equal(reply.result.file, "code.txt", "Summary selections must identify their file");
  assert.equal(reply.result.target, "working");
  assert.ok(reply.result.selection.lines.some(row => row.newNumber === 2));
  await page.evaluate(() => {
    const text = document.querySelector('.summary-diff-card[data-path="code.txt"] .diff-line.added .line-text');
    const range = document.createRange(); range.selectNodeContents(text);
    window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
  });
  reply = await mcp(page, "get_view");
  assert.equal(reply.result.selection.textSelection.text, "working cause");
  assert.ok(reply.result.selection.textSelection.lines.some(row => row.file === "code.txt" && row.target === "working" && row.newNumber === 2));
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await doubleClickDiffWord(page, "working cause", "cause");
  await doubleClickDiffWord(page, "working cause", "cause");
  await page.screenshot({ path: path.join(screenshots, "diff-word-selection.png") });
  await click(page, ".editor-tab-close");
  await click(page, '.summary-diff-card[data-path="code.txt"] .summary-open-tab');
  await doubleClickDiffWord(page, "working cause", "cause");
  await click(page, ".editor-input");
  assert.equal(await page.$eval(".editor-input", input => document.activeElement === input), true, "The editor still accepts focus when clicked");
  await click(page, ".editor-tab-close");
  reply = await mcp(page, "reveal_change", { repository: repository.folder, commit: repository.cause, file: "code.txt" });
  assert.equal(reply.error, null);
  await doubleClickDiffWord(page, "new cause", "cause");
  assert.equal(await page.$eval(".editor-input", input => input.readOnly), true, "Historical files remain read-only");
  await click(page, ".editor-tab-close");
  const beforeFileReveal = { head: git(repository.folder, "rev-parse", "HEAD"), status: git(repository.folder, "status", "--porcelain"), file: fs.readFileSync(path.join(repository.folder, "code.txt"), "utf8") };
  const comment = "This file is unchanged at the tip of topic.\nThe explanation stays beside the highlighted code.";
  reply = await mcp(page, "reveal_file", { repository: repository.folder, branch: "topic", file: "code.txt", startLine: 2, endLine: 3, quote: "new cause", comment });
  assert.equal(reply.error, null);
  assert.equal(reply.result.confirmed, true);
  assert.equal(reply.result.revision, secondParent);
  assert.equal(reply.result.branch, "main", "Browsing an unchanged file never checks out its branch");
  assert.equal(await page.$eval(".editor-input", input => input.value), "first\nnew cause\nlast\n");
  assert.equal(await page.$$eval(".editor-row.ai-highlight", rows => rows.length), 2);
  assert.equal(await page.$eval(".editor-annotation p", note => note.textContent), comment);
  assert.equal((await mcp(page, "get_view")).result.editor.annotation.startLine, 2);
  await page.screenshot({ path: path.join(screenshots, "mcp-unchanged-file.png") });
  for (const args of [{ quote: "wrong code" }, { startLine: 4, endLine: 4 }, { file: "missing.txt" }, { branch: "missing-branch" }]) {
    reply = await mcp(page, "reveal_file", { repository: repository.folder, branch: "topic", file: "code.txt", startLine: 2, ...args });
    assert.ok(reply.error, "Invalid file evidence must fail");
    assert.equal((await mcp(page, "get_view")).result.editor.revision, secondParent, "Failed requests must preserve the previous editor");
  }
  await click(page, ".editor-annotation button[title='Clear AI highlights']");
  assert.equal((await mcp(page, "get_view")).result.editor.annotation, null);
  assert.equal(await page.$$eval(".editor-row.ai-highlight", rows => rows.length), 0);
  reply = await mcp(page, "reveal_file", { repository: repository.folder, revision: "working", file: "code.txt", startLine: 2, quote: "working cause" });
  assert.equal(reply.error, null);
  assert.equal(await page.$eval(".editor-input", input => input.value), "first\nworking cause\nlast\n");
  assert.equal(await page.$eval(".editor-input", input => input.readOnly), true);
  assert.deepEqual({ head: git(repository.folder, "rev-parse", "HEAD"), status: git(repository.folder, "status", "--porcelain"), file: fs.readFileSync(path.join(repository.folder, "code.txt"), "utf8") }, beforeFileReveal);
  await click(page, ".editor-tab-close");
  reply = await mcp(page, "reveal_change", { repository: repository.folder, commit: "working", file: "code.txt", highlights: [{ kind: "lines", side: "new", startLine: 2, quote: "working cause" }] });
  assert.equal(reply.error, null);
  fs.writeFileSync(path.join(repository.folder, "code.txt"), "first\ndifferent content\nlast\n");
  await shortcut(page, "r");
  try {
    await page.waitForFunction(() => [...document.querySelectorAll(".line-text")].some(row => row.textContent === "different content"), { timeout: 5000 });
  } catch (error) {
    throw new Error(`${error.message}: view=${JSON.stringify((await mcp(page, "get_view")).result)} text=${await page.$eval(".details-pane", pane => pane.textContent)}`);
  }
  assert.equal(await page.$$eval(".diff-line.ai-highlight", rows => rows.length), 0, "Changed diffs clear stale emphasis");
  await mcp(page, "open_repository", { repository: restore, branch: "main" });
  await click(page, "button[aria-label='Close mcp-topic']");
  await click(page, "button[aria-label='Close mcp']");
  console.log("MCP navigation: branch identity, tab reuse, old/new lines, hunks, old history, code search, selection and stale highlights passed");
}

async function exerciseStatusMessages(page, repository) {
  const other = makeRepo("status-other");
  await openRepo(page, other);
  await click(page, '.tab-main[title^="small ·"]');
  let finishAction;
  actionGate = { kind: "pull", started: false, promise: new Promise(resolve => { finishAction = resolve; }) };
  await click(page, 'button[title="Pull"]');
  await waitUntil(() => actionGate.started, "pending pull");
  assert.equal(await page.$eval(".progress-bar > span", element => element.textContent), "Pulling…");
  assert.match(await page.$eval(".statusbar-right", element => element.textContent), /Pulling…/);
  await page.evaluate(path => window.__eventCallbacks["git-progress"]({ event: "git-progress", payload: { path, message: "Receiving objects: 50%" } }), repository);
  assert.equal(await page.$eval(".progress-bar > span", element => element.textContent), "Pulling… · Receiving objects: 50%");
  actionGate = null; finishAction();
  await waitForAction(page);
  assert.equal(await page.$eval(".notice-bar", element => element.textContent), "Pull complete");
  assert.match(await page.$eval(".notice-bar", element => element.title), /Already up to date/);
  // Hold the RPC response to inspect cancellation UI without starting a slow transfer.
  actionGate = { kind: "pull", started: false, cancel: true, error: "Operation cancelled", promise: new Promise(resolve => { finishAction = resolve; }) };
  await click(page, 'button[title="Pull"]');
  await waitUntil(() => actionGate.started, "cancellable pull");
  await click(page, ".progress-bar button");
  await page.waitForFunction(() => document.querySelector(".progress-bar > span")?.textContent === "Cancelling pull…");
  await page.evaluate(path => window.__eventCallbacks["git-progress"]({ event: "git-progress", payload: { path, message: "Receiving objects: 100%" } }), repository);
  assert.equal(await page.$eval(".progress-bar > span", element => element.textContent), "Cancelling pull…", "Late transfer progress must not overwrite cancellation");
  actionGate = null; finishAction();
  await waitForAction(page);
  assert.equal(await page.$eval(".notice-bar", element => element.textContent), "Pull cancelled");
  assert.equal(await page.$(".error-bar"), null);
  actionGate = { kind: "pull", started: false, promise: new Promise(resolve => { finishAction = resolve; }) };
  await click(page, 'button[title="Pull"]');
  await waitUntil(() => actionGate.started, "background pull");
  await click(page, '.tab-main[title^="status-other ·"]');
  await page.evaluate(() => document.querySelector(".commit-row")?.click());
  await page.waitForFunction(() => document.querySelector(".commit-message")?.textContent.includes("Initial commit"));
  assert.equal(await page.$eval(".progress-bar > span", element => element.textContent), "Pulling… (small)");
  actionGate = null; finishAction();
  await waitForAction(page);
  assert.match(await page.$eval(".commit-message", element => element.textContent), /Initial commit/, "Finishing a pull in another repository must not change this tab's selection");
  assert.equal(await page.$eval(".notice-bar", element => element.textContent), "small: Pull complete");
  await click(page, '.tab-main[title^="small ·"]');

  const raw = "fatal: bad object deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
  const holdRefresh = () => {
    let release;
    snapshotGate = { paths: [], holdPaths: [repository], error: raw, promise: new Promise(resolve => { release = resolve; }) };
    return release;
  };
  const refresh = async () => {
    await click(page, 'button[title="More actions"]');
    await click(page, '.push-menu button[title="Refresh"]');
    await waitUntil(() => snapshotGate.paths.includes(repository), "pending repository refresh");
  };
  let release = holdRefresh();
  await refresh();
  await click(page, '.tab-main[title^="status-other ·"]');
  const gate = snapshotGate;
  snapshotGate = null; release();
  await gate.promise;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.$(".error-bar"), null, "A late error from another repository must not appear in this tab");

  await click(page, '.tab-main[title^="small ·"]');
  release = holdRefresh();
  await refresh();
  snapshotGate = null; release();
  await page.waitForSelector(".error-bar");
  assert.equal(await page.$eval(".status-chip-text", element => element.textContent), "Refreshing repository: This revision is unavailable");
  await click(page, ".status-chip-text");
  assert.equal(await page.$eval(".error-details pre", element => element.textContent), `Error: ${raw}`);
  assert.match(await page.$eval(".error-details p", element => element.textContent), /Refresh the repository/);
  await page.screenshot({ path: path.join(screenshots, "readable-revision-error.png") });
  await click(page, '.error-details button::-p-text(Refresh repository)');
  await page.waitForFunction(() => !document.querySelector(".error-bar"));
  actionGate = { kind: "pull", started: false, error: raw, promise: new Promise(resolve => { finishAction = resolve; }) };
  await click(page, 'button[title="Pull"]');
  await waitUntil(() => actionGate.started, "failing background pull");
  await click(page, '.tab-main[title^="status-other ·"]');
  await page.evaluate(() => document.querySelector(".commit-row")?.click());
  await page.waitForFunction(() => document.querySelector(".commit-message")?.textContent.includes("Initial commit"));
  actionGate = null; finishAction();
  await waitForAction(page);
  assert.equal(await page.$eval(".status-chip-text", element => element.textContent), "Pull (small): This revision is unavailable");
  await click(page, ".status-chip-text");
  let finishRecovery;
  snapshotGate = { paths: [], holdPaths: [repository], promise: new Promise(resolve => { finishRecovery = resolve; }) };
  await click(page, '.error-details button::-p-text(Refresh repository)');
  await waitUntil(() => snapshotGate.paths.includes(repository), "refreshing the failed repository rather than the active one");
  assert.deepEqual(snapshotGate.paths, [repository]);
  snapshotGate = null; finishRecovery();
  await page.waitForFunction(() => !document.querySelector(".error-bar"));
  assert.match(await page.$eval(".commit-message", element => element.textContent), /Initial commit/, "Recovering another repository must preserve this tab's selection");
  await click(page, '.tab-main[title^="small ·"]');
  await click(page, 'button[aria-label="Close status-other"]');
  console.log("Status messages: named progress, streaming context, completion details, stale errors and revision recovery passed");
}

async function exerciseSearchPaging(page) {
  await click(page, ".working-row");
  await click(page, "button[title='Search commits']");
  const search = async query => {
    await page.locator(".search-box input").fill(query);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector(".commits-pane .pane-heading")?.textContent.includes("SEARCH RESULTS"));
  };
  for (const next of ["Base", "Later"]) {
    let releaseSearch;
    searchGate = { query: "Later", started: false, finished: false, promise: new Promise(resolve => { releaseSearch = resolve; }) };
    await search("Later");
    await page.waitForSelector(".commits-pane .load-more");
    await click(page, ".commits-pane .load-more");
    await waitUntil(() => searchGate.started, "delayed search pagination");
    await search("Base");
    await page.waitForFunction(() => document.querySelector(".heading-count")?.textContent === "1");
    if (next === "Later") {
      await search("Later");
      await page.waitForFunction(() => document.querySelector(".heading-count")?.textContent === "100+");
    }
    const gate = searchGate;
    searchGate = null; releaseSearch();
    await waitUntil(() => gate.finished, "old search page response");
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    assert.equal(await page.$eval(".heading-count", count => count.textContent), next === "Base" ? "1" : "100+", "Old search pages must not overwrite a new query, including the same query restarted");
    await page.evaluate(() => { document.querySelector(".commit-scroll").scrollTop = 0; });
  }
  await click(page, ".search-box button[title='Clear search']");
  console.log("Search pagination: changed and restarted queries reject delayed pages");
}

async function clickChangedLine(page, text, shift = false) {
  const label = await page.evaluate(value => [...document.querySelectorAll(".diff-line")].find(row => row.dataset.copyPrefix === value[0] && row.querySelector(".line-text")?.textContent === value.slice(1))?.querySelector("button.line-number")?.getAttribute("aria-label"), text);
  assert.ok(label, `Selectable line ${text} must exist`);
  if (shift) await page.keyboard.down("Shift");
  await click(page, `button[aria-label='${label}'] .${label.startsWith("Select old") ? "old-line" : "new-line"}`);
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
  if (command === "ssh_current_prompt") return null;
  if (command === "ssh_saved_credentials") return [];
  if (command === "repo_action") actionRequests.push({ path: args.path, kind: args.operation.kind });
  if (command === "repo_action" && actionGate?.kind === args.operation.kind) {
    const gate = actionGate;
    gate.started = true;
    await gate.promise;
    if (gate.error) throw new Error(gate.error);
  }
  if (command === "repo_cancel" && actionGate?.cancel) return "Cancellation requested";
  if (command === "plugin:window|is_maximized") return true;
  if (command === "repo_diff") diffRequests++;
  const heldSearch = command === "repo_search" && args.offset > 0 && searchGate && args.query === searchGate.query ? searchGate : null;
  if (heldSearch) { heldSearch.started = true; await heldSearch.promise; }
  if (command === "repo_save_file" && saveGate) {
    const gate = saveGate;
    gate.started = true;
    await gate.promise;
  }
  if (command === "repo_snapshot" && snapshotGate && (!snapshotGate.holdPaths || snapshotGate.holdPaths.includes(args.path))) {
    const gate = snapshotGate;
    gate.paths.push(args.path);
    await gate.promise;
    if (gate.error) throw new Error(gate.error);
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
    repo_search: [args.codeSearch ? "find_changes" : "search", { path: args.path, query: args.query, offset: args.offset, limit: 100 }],
    repo_commit: ["commit_details", { path: args.path, hash: args.hash }],
    repo_compare: ["compare", { path: args.path, base: args.base, head: args.head }],
    repo_file_history: ["file_history", { path: args.path, file: args.file, revision: args.revision, offset: args.offset, limit: 100 }],
    repo_blame: ["blame", { path: args.path, file: args.file, revision: args.revision, start_line: args.startLine, limit: 300 }],
    repo_tracked_files: ["tracked_files", { path: args.path, query: args.query, limit: 100 }],
    repo_diff: ["diff", { path: args.path, target: args.target, file: args.file, ignore_whitespace: args.ignoreWhitespace ?? false, full_context: args.fullContext ?? false }],
    repo_read_file: ["read_file", { path: args.path, file: args.file }],
    repo_save_file: ["save_file", { path: args.path, file: args.file, content: args.content, expected_content: args.expectedContent, stage: args.stage }],
    repo_action: ["action", { path: args.path, action: args.operation, cancel_token: args.cancelToken }],
    repo_cancel: ["cancel", { token: args.token }],
  };
  const entry = commands[command];
  if (!entry) throw new Error(`Unknown command ${command}`);
  const response = await rpc(...entry);
  if (heldSearch) heldSearch.finished = true;
  if (response.kind === "error") {
    if (command === "repo_diff" && /bad object/.test(response.value)) invalidRevisionDiffs.push({ path: args.path, target: args.target });
    throw new Error(response.value);
  }
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
  await page.waitForFunction(() => !document.querySelector("button[title='Pull']")?.disabled);
}

async function submitActionDialog(page, { text, remote } = {}) {
  await page.waitForSelector(".action-dialog");
  if (text !== undefined) await page.locator(".action-dialog input").fill(text);
  if (remote !== undefined) await page.select(".action-dialog select", remote);
  await click(page, ".action-dialog-submit");
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

async function exerciseSideEditor(page, repository) {
  const base = path.join(repository, "base.txt"), otherFile = path.join(repository, "new.txt");
  const original = fs.readFileSync(base, "utf8"), otherOriginal = fs.readFileSync(otherFile, "utf8");
  const baseLine = '.summary-diff-card[data-path="base.txt"] .diff-line.added .line-text';
  await click(page, baseLine, { count: 2 });
  await page.waitForSelector('.editor-input[aria-label="Edit base.txt"]', { timeout: 5000 }).catch(async error => {
    throw new Error(`${error.message}: editor=${await page.$eval(".editor-pane", pane => pane.textContent).catch(() => "not mounted")} error=${await page.$eval(".error-bar", pane => pane.textContent).catch(() => "none")}`);
  });
  const loadingRepo = makeRepo("editor-loading");
  const missingRepo = path.join(sandbox, "editor-missing");
  let releaseSnapshot;
  snapshotGate = { paths: [], holdPaths: [loadingRepo], promise: new Promise(resolve => { releaseSnapshot = resolve; }) };
  await page.evaluate(({ repository, loadingRepo, missingRepo }) => {
    localStorage.setItem("gitferry.openTabs", JSON.stringify([repository, loadingRepo, missingRepo]));
    localStorage.setItem("gitferry.activeTab", repository);
  }, { repository, loadingRepo, missingRepo });
  await page.reload();
  await page.waitForSelector('.summary-diff-card[data-path="base.txt"] .diff-content');
  await page.waitForSelector('.editor-input[aria-label="Edit base.txt"]');
  await page.locator(".editor-input").fill(original + "unsaved draft\n");
  await waitUntil(() => snapshotGate.paths.includes(loadingRepo), "loading editor repository");
  await click(page, '.tab-main[title^="editor-loading"]');
  await page.waitForSelector(".repo-startup");
  assert.ok(await page.$(".editor-tab-close.dirty"), "Loading another repository must retain the editor draft");
  await click(page, '.tab-main[title^="small"]');
  assert.equal(await page.$eval(".editor-input", input => input.value), original + "unsaved draft\n");
  snapshotGate = null; releaseSnapshot();
  await click(page, '.tab-main[title^="editor-missing"]');
  await page.waitForSelector(".repo-startup button");
  assert.ok(await page.$(".editor-tab-close.dirty"), "An unavailable tab must retain the editor draft");
  await click(page, '.tab-main[title^="small"]');
  assert.equal(await page.$eval(".editor-input", input => input.value), original + "unsaved draft\n");
  await click(page, '.repo-tab:has(.tab-main[title^="editor-loading"]) .tab-close');
  await click(page, '.repo-tab:has(.tab-main[title^="editor-missing"]) .tab-close');

  let releaseSave;
  saveGate = { started: false, promise: new Promise(resolve => { releaseSave = resolve; }) };
  await click(page, ".editor-save");
  await waitUntil(() => saveGate.started, "delayed editor save");
  await click(page, '.summary-diff-card[data-path="new.txt"] .line-text', { count: 2 });
  await page.waitForSelector(".action-dialog");
  await submitActionDialog(page);
  await page.waitForSelector('.editor-input[aria-label="Edit new.txt"]');
  saveGate = null; releaseSave();
  await page.waitForFunction(() => !document.querySelector(".editor-input")?.readOnly);
  assert.equal(await page.$eval(".editor-input", input => input.value), otherOriginal.replace(/\r\n?/g, "\n"));
  assert.equal(await page.$(".editor-tab-close.dirty"), null, "A previous file's save must not dirty the newly opened file");
  await page.locator(".editor-input").fill(otherOriginal + "saved second file\n");
  await click(page, ".editor-save");
  await waitUntil(() => fs.readFileSync(otherFile, "utf8").includes("saved second file"), "save newly opened file against its own source");
  await page.waitForFunction(() => document.querySelector(".editor-save")?.disabled && !document.querySelector(".editor-tab-close.dirty"));
  await click(page, "button[aria-label='Close editor']");
  fs.writeFileSync(base, original); fs.writeFileSync(otherFile, otherOriginal);
  await shortcut(page, "r");
  await page.waitForFunction(() => [...document.querySelectorAll('.summary-diff-card[data-path="base.txt"] .line-text')].some(row => row.textContent === "two changed"));
  console.log("Side editor: drafts survive loading and unavailable repositories; delayed saves stay with their document");
}

async function exerciseComparisonBase(page) {
  const folder = path.join(sandbox, "comparison-base");
  fs.mkdirSync(folder);
  git(folder, "init", "-b", "master");
  git(folder, "config", "user.name", "GitFerry Test");
  git(folder, "config", "user.email", "gitferry@example.test");
  fs.writeFileSync(path.join(folder, "shared.txt"), "50Gi\n");
  git(folder, "add", "."); git(folder, "commit", "-m", "Old local master");
  git(folder, "switch", "-c", "feature/viewer");
  fs.writeFileSync(path.join(folder, "shared.txt"), "100Gi\n");
  git(folder, "commit", "-am", "Already merged remotely");
  git(folder, "update-ref", "refs/remotes/origin/master", "HEAD");
  fs.writeFileSync(path.join(folder, "viewer.txt"), "branch change\n");
  git(folder, "add", "."); git(folder, "commit", "-m", "Viewer change");
  await openRepo(page, folder);
  await page.waitForFunction(() => document.querySelector(".compare-main strong")?.textContent === "feature/viewer vs origin/master" && document.querySelector(".compare-main small")?.textContent.includes("1 commit"));
  await click(page, ".compare-main");
  await page.waitForSelector('.summary-diff-card[data-path="viewer.txt"] .diff-content');
  assert.deepEqual(await page.$$eval(".summary-diff-card", cards => cards.map(card => card.dataset.path)), ["viewer.txt"], "Changes already on origin/master must not appear against a stale local master");
  git(folder, "update-ref", "refs/heads/master", "HEAD");
  await shortcut(page, "r");
  await page.waitForFunction(() => document.querySelector(".compare-main small")?.textContent.includes("1 commit"));
  assert.equal(await page.$eval(".compare-main strong", heading => heading.textContent), "feature/viewer vs origin/master", "A newer local master must not hide work that has not reached the remote");
  await page.locator('.repo-tab:has(.tab-main[title^="comparison-base"]) .tab-close').click();
  console.log("Comparison base: remote master wins over both stale and newer local master");
}

async function openSummaryFile(page, file, target) {
  await click(page, ".details-tab:first-child");
  await page.waitForFunction(({ file, target }) => [...document.querySelectorAll(".summary-diff-card")].some(card => card.querySelector(".file-path")?.textContent === file && Boolean(card.querySelector(".file-tag")) === (target === "STAGED")), {}, { file, target });
  await page.evaluate(({ file, target }) => [...document.querySelectorAll(".summary-diff-card")].find(card => card.querySelector(".file-path")?.textContent === file && Boolean(card.querySelector(".file-tag")) === (target === "STAGED"))?.querySelector(".summary-open-tab")?.click(), { file, target });
  await page.waitForFunction(value => document.querySelector(".diff-heading-target")?.textContent === value, {}, target);
}

async function selectFileView(page, name) {
  await page.evaluate(label => [...document.querySelectorAll(".file-view-switch button")].find(button => button.textContent.trim() === label)?.click(), name);
}

// Watches the diff under root while it updates; the returned check says it stayed mounted and never showed "Loading diff…".
async function watchDiffInPlace(page, root) {
  await page.evaluate(selector => {
    const element = document.querySelector(selector);
    window.__diffWatch = { content: element.querySelector(".diff-content"), blanked: false };
    window.__diffWatch.observer = new MutationObserver(() => { if (element.querySelector(".empty-note")) window.__diffWatch.blanked = true; });
    window.__diffWatch.observer.observe(element, { childList: true, subtree: true });
  }, root);
  return () => page.evaluate(() => { window.__diffWatch.observer.disconnect(); return document.contains(window.__diffWatch.content) && !window.__diffWatch.blanked; });
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
  const mcpRepo = makeMcpRepo();
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
    window.__callbackId = 0;
    window.__callbacks = new Map(); window.__eventCallbacks = {};
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    window.__mcpId = 0; window.__mcpWaiters = new Map();
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: callback => { const id = ++window.__callbackId; window.__callbacks.set(id, callback); return id; },
      unregisterCallback: () => {},
      invoke: async (command, args) => {
        if (command === "plugin:event|listen") { window.__eventCallbacks[args.event] = window.__callbacks.get(args.handler); return args.handler; }
        if (command === "mcp_request_active") return window.__mcpWaiters.has(args.id);
        if (command === "mcp_reply") { window.__mcpWaiters.get(args.id)?.(args); window.__mcpWaiters.delete(args.id); return; }
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
  // The app renders only after restoring saved settings, so shortcuts pressed earlier are lost.
  await page.waitForSelector(".statusbar");
  if (process.env.GITFERRY_README_SHOWCASE) {
    await require("./readme-showcase.cjs")({ page, sandbox, screenshots, git, click, openRepo, mcp, selectTheme });
    assert.deepEqual(pageErrors, [], "showcase must have no uncaught browser errors");
    console.log(`README screenshots: ${screenshots}`);
    return;
  }
  await shortcut(page, "p");
  await page.waitForSelector(".palette input");
  await page.locator(".palette input").fill("Open repository");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".open-modal");
  assert.equal(await page.$$eval(".palette", items => items.length), 0);
  await click(page, ".open-kind button:nth-child(2)");
  await page.locator(".remote-form label:first-child input").fill("tester@example.test");
  await page.locator(".remote-form label:nth-child(2) input").fill("relative/repo");
  assert.equal(await page.$eval(".remote-form button[type='submit']", button => button.disabled), true);
  await page.locator(".remote-form label:nth-child(2) input").fill("/tmp/repo");
  assert.equal(await page.$eval(".remote-form button[type='submit']", button => button.disabled), false);
  await click(page, ".open-kind button:first-child");
  await page.locator(".open-modal .modal-body input").fill(path.join(sandbox, "missing"));
  await click(page, ".open-modal .modal-body button[type='submit']");
  await page.waitForSelector(".modal-error");
  await page.keyboard.press("Escape");
  await shortcut(page, "o");
  await page.waitForSelector(".open-modal");
  await page.keyboard.press("Escape");
  await openRepo(page, small);
  await exerciseStatusMessages(page, small);
  if (process.env.GITFERRY_STATUS_ONLY) {
    assert.deepEqual(pageErrors, [], "status UI must have no uncaught errors");
    return;
  }
  await exerciseMcp(page, mcpRepo, small);
  if (process.env.GITFERRY_MCP_ONLY) {
    assert.deepEqual(pageErrors, [], "browser must have no uncaught errors");
    console.log(`MCP-only UI smoke passed; diff selection screenshot: ${path.join(screenshots, "diff-word-selection.png")}`);
    return;
  }
  await page.waitForSelector(".summary-diff-card .diff-content");
  await exerciseSideEditor(page, small);
  await exerciseComparisonBase(page);
  const snapshotResponses = await page.evaluate(() => {
    window.__unchangedCard = [...document.querySelectorAll(".summary-diff-card")].find(card => card.querySelector(".file-path")?.textContent === "new.txt");
    return window.__snapshotResponses;
  });
  await click(page, "button[title='More actions']");
  await click(page, ".push-menu button[title='Refresh']");
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
    return card.querySelector(".row-action.stage").textContent;
  }), "Stage", "untracked files must not be labeled as conflicts");
  const groupControl = await page.evaluate(() => {
    const heading = [...document.querySelectorAll(".file-group-heading")].find(item => item.textContent.trim().startsWith("UNTRACKED"));
    const button = heading.querySelector(".group-disclosure");
    const bounds = button.getBoundingClientRect();
    const title = heading.querySelector(".file-group-title").getBoundingClientRect();
    // The group's Stage/Discard/Delete buttons sit at the right; the disclosure fills the rest of the heading.
    const actionsWidth = heading.querySelector(".group-actions")?.getBoundingClientRect().width ?? 0;
    return { text: button.textContent.trim(), hasIcon: Boolean(button.querySelector("svg")), width: bounds.width, headingWidth: heading.getBoundingClientRect().width - actionsWidth,
      iconRight: button.querySelector("svg").getBoundingClientRect().right, titleLeft: title.left,
      rightEdge: { x: bounds.right - 8, y: bounds.top + bounds.height / 2 }, titleCenter: { x: title.left + title.width / 2, y: title.top + title.height / 2 } };
  });
  assert.match(groupControl.text, /^UNTRACKED 2$/, "group heading should expose the file count");
  assert.equal(groupControl.hasIcon, true);
  assert.ok(groupControl.width >= groupControl.headingWidth - 1 && groupControl.iconRight < groupControl.titleLeft, "the heading must be clickable up to its actions, with the icon on the left");
  await page.mouse.click(groupControl.rightEdge.x, groupControl.rightEdge.y);
  assert.deepEqual(await groupExpanded("UNTRACKED"), ["false", "false"], "clicking the empty right side of the heading must close its files");
  await page.mouse.click(groupControl.titleCenter.x, groupControl.titleCenter.y);
  assert.deepEqual(await groupExpanded("UNTRACKED"), ["true", "true"], "clicking the heading label must reopen its files");
  await click(page, "button[aria-label='Close all unstaged changes']");
  assert.deepEqual(await groupExpanded("UNSTAGED"), ["false"]);
  assert.deepEqual(await groupExpanded("UNTRACKED"), ["true", "true"]);
  await click(page, "button[aria-label='Close all untracked changes']");
  assert.deepEqual(await groupExpanded("UNTRACKED"), ["false", "false"]);
  await click(page, "button[aria-label='Open all unstaged changes']");
  await click(page, "button[aria-label='Open all untracked changes']");
  await page.screenshot({ path: path.join(screenshots, "summary-open-groups.png") });
  const textSizes = await page.evaluate(() => Object.fromEntries([
    ".commit-editor-actions label", ".commit-editor-actions button", ".commit-editor textarea",
    ".file-row", ".commit-meta", ".section-heading", ".statusbar",
  ].map(selector => [selector, Number.parseFloat(getComputedStyle(document.querySelector(selector)).fontSize)])));
  for (const [selector, size] of Object.entries(textSizes)) assert.ok(size >= 13, `${selector} must be readable: ${size}px`);
  assert.ok(textSizes[".commit-editor-actions label"] >= 14, "amend control must use larger text");
  assert.ok(textSizes[".commit-editor-actions button"] >= 14, "commit button must use larger text");
  await page.waitForSelector(".diff-line");
  await toggleIgnoreWhitespace(page);
  // Filtered hunks must not be stageable, and the saved filter must say so.
  await page.waitForFunction(() => !document.querySelector(".hunk-action"));
  await page.waitForSelector(".diff-filter-note::-p-text(Whitespace-only changes are hidden)");
  await toggleIgnoreWhitespace(page);
  await page.waitForSelector(".hunk-action");
  assert.ok(await page.$eval(".details-tab:first-child", tab => tab.classList.contains("active")), "opening a Summary file must keep Summary active");
  assert.equal(await page.$eval(".file-row", row => row.getAttribute("aria-expanded")), "true");
  assert.match(await page.$eval(".diff-content", element => element.innerText), /two changed|new file/);
  await click(page, ".file-row");
  assert.equal(await page.$eval(".file-row", row => row.getAttribute("aria-expanded")), "false");
  await click(page, ".file-row");
  await click(page, ".hunk-action");
  await page.waitForFunction(() => [...document.querySelectorAll(".file-group-heading")].some(item => item.textContent.trim().startsWith("STAGED ")) || document.querySelector(".error-bar"));
  assert.ok(git(small, "diff", "--cached", "--", "base.txt").includes("two changed"), JSON.stringify({ status: git(small, "status", "--short"), error: await page.$eval(".error-bar", item => item.textContent).catch(() => "") }));
  await waitForAction(page);
  if (await page.$eval(".file-row", row => row.getAttribute("aria-expanded") === "false")) await click(page, ".file-row");
  await page.waitForSelector(".hunk-action");
  await click(page, ".hunk-action");
  await page.waitForFunction(() => [...document.querySelectorAll(".file-group-heading")].some(item => item.textContent.trim().startsWith("UNSTAGED ")));
  assert.equal(git(small, "diff", "--cached", "--", "base.txt"), "");
  await waitForAction(page);
  if (await page.$eval(".file-row", row => row.getAttribute("aria-expanded") === "false")) await click(page, ".file-row");
  await page.waitForSelector(".row-action.stage");
  await click(page, ".row-action.stage");
  await page.waitForFunction(() => [...document.querySelectorAll(".file-group-heading")].some(item => item.textContent.trim().startsWith("STAGED ")));
  await waitForAction(page);
  if (await page.$eval(".file-row", row => row.getAttribute("aria-expanded") === "false")) await click(page, ".file-row");
  await page.waitForSelector(".row-action.stage");
  await click(page, ".row-action.stage");
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
  await click(page, ".details-tab:first-child");
  fs.writeFileSync(path.join(small, "new.txt"), "new file\r\n");
  await click(page, "button[title='More actions']");
  await click(page, ".push-menu button[title='Refresh']");
  await page.evaluate(() => [...document.querySelectorAll(".summary-diff-card")].find(card => card.querySelector(".file-path")?.textContent === "new.txt")?.querySelector(".summary-open-tab")?.click());
  await page.waitForSelector(".file-view-switch");
  await page.evaluate(() => [...document.querySelectorAll(".file-view-switch button")].find(button => button.textContent.trim() === "Edit")?.click());
  await page.waitForSelector('.file-edit-textarea[aria-label="Edit new.txt"]');
  await page.locator(".file-edit-textarea").fill("new file\nsecond\n");
  await shortcut(page, "s");
  await waitUntil(() => fs.readFileSync(path.join(small, "new.txt"), "utf8") === "new file\r\nsecond\r\n", "preserve CRLF on save");
  await page.waitForFunction(() => document.querySelector(".file-edit-save")?.textContent.trim() === "Save · Ctrl+S" && document.querySelector(".file-edit-save")?.disabled);
  await click(page, ".details-tab:first-child");
  assert.equal(await page.$$(".details-tab").then(tabs => tabs.length), 2, "returning to Summary must keep the file tab available");
  await click(page, ".details-tab-close");
  assert.equal(await page.$$(".details-tab").then(tabs => tabs.length), 1, "the file tab must close with its close button");
  // The whole Changed Files bar toggles every file; its own buttons keep their own actions.
  await click(page, ".files-heading", { offset: { x: 4, y: 10 } });
  assert.equal(await page.$eval(".file-row", row => row.getAttribute("aria-expanded")), "false", "clicking the bar must collapse all files");
  await click(page, ".files-disclosure");
  assert.equal(await page.$eval(".file-row", row => row.getAttribute("aria-expanded")), "true", "clicking the title must expand all files");
  await click(page, ".files-heading button::-p-text(Browse files)");
  await page.keyboard.press("Escape");
  assert.equal(await page.$eval(".file-row", row => row.getAttribute("aria-expanded")), "true", "Browse files must not toggle the files");
  assert.equal(await page.$eval(".files-heading button:last-child", item => item.textContent.trim()), "Stage All");
  await click(page, ".files-heading button:last-child");
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
  await click(page, ".details-tab:first-child");
  await page.locator(".commit-editor textarea").fill("Test UI commit");
  await shortcut(page, "Enter");
  await page.waitForFunction(() => document.querySelector(".commit-subject")?.textContent.includes("Test UI commit"));
  assert.equal(git(small, "log", "-1", "--pretty=%s"), "Test UI commit");
  await waitForAction(page);
  await click(page, "button[title='Push']");
  // The status bar shows a notice's first line; the full Git output is in its tooltip.
  await page.waitForFunction(() => document.querySelector(".notice-bar")?.title.includes("main"));
  await page.waitForFunction(() => !document.querySelector("button[title='Pull']")?.disabled);
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
  git(small, "switch", "-c", "ui-base-pull");
  const featureHead = git(small, "rev-parse", "HEAD");
  const featureIndex = git(small, "write-tree");
  const featureContent = fs.readFileSync(path.join(small, "base.txt"), "utf8");
  fs.writeFileSync(path.join(small, "base.txt"), `${featureContent}unsaved feature work\n`);
  await page.waitForFunction(() => document.querySelector(".branch-chip")?.title === "ui-base-pull");
  await click(page, '.ref-action-trigger[aria-label="Actions for main"]');
  await page.waitForSelector('.ref-action-popover button[title="Fast-forward main from its upstream"]');
  await page.screenshot({ path: path.join(screenshots, "pull-base-branch-menu.png") });
  await click(page, '.ref-action-popover button[title="Fast-forward main from its upstream"]');
  await waitUntil(() => git(small, "rev-parse", "main") === git(other, "rev-parse", "HEAD"), "pull main while on feature");
  await waitForAction(page);
  assert.equal(git(small, "branch", "--show-current"), "ui-base-pull");
  assert.equal(git(small, "rev-parse", "HEAD"), featureHead);
  assert.equal(git(small, "write-tree"), featureIndex);
  assert.equal(fs.readFileSync(path.join(small, "base.txt"), "utf8"), `${featureContent}unsaved feature work\n`);
  assert.equal(fs.existsSync(path.join(small, "remote.txt")), false, "pulling main must not update feature files");
  fs.writeFileSync(path.join(small, "base.txt"), featureContent);
  git(small, "switch", "main");
  await page.waitForFunction(() => document.querySelector(".branch-chip")?.title === "main");
  await click(page, "button[title='More pull options']");
  await click(page, ".push-menu button[title='Fetch']");
  await waitUntil(() => git(small, "rev-parse", "refs/remotes/origin/main") === git(remote, "rev-parse", "refs/heads/main"), "Fetch").catch(async error => { throw new Error(`${error.message}: ${await page.$eval(".error-bar", item => item.textContent).catch(() => "no UI error")}`); });
  await page.waitForFunction(() => !document.querySelector("button[title='Pull']")?.disabled);
  assert.equal(git(small, "rev-parse", "refs/remotes/origin/main"), git(remote, "rev-parse", "refs/heads/main"));
  await click(page, "button[title='Pull']");
  await waitUntil(() => git(small, "rev-parse", "HEAD") === git(remote, "rev-parse", "refs/heads/main"), "Pull");
  await page.waitForFunction(() => !document.querySelector("button[title='Pull']")?.disabled);
  assert.equal(git(small, "rev-parse", "HEAD"), git(remote, "rev-parse", "refs/heads/main"));
  git(small, "commit", "--amend", "-m", "Remote update amended");
  fs.writeFileSync(path.join(other, "remote-later.txt"), "new remote work\n");
  git(other, "add", "remote-later.txt");
  git(other, "commit", "-m", "Later remote update");
  git(other, "push");
  const advancedRemote = git(remote, "rev-parse", "refs/heads/main");
  await click(page, "button[title='More push options']");
  await page.waitForSelector(".push-menu button[title='Force push with lease']");
  await page.screenshot({ path: path.join(screenshots, "force-push-menu.png") });
  await click(page, ".push-menu button[title='Force push with lease']");
  await submitActionDialog(page);
  await page.waitForSelector(".error-bar");
  assert.equal(git(remote, "rev-parse", "refs/heads/main"), advancedRemote, "stale lease must reject the push");
  await waitForAction(page);
  await click(page, "button[title='More pull options']");
  await click(page, ".push-menu button[title='Fetch']");
  await waitUntil(() => git(small, "rev-parse", "refs/remotes/origin/main") === advancedRemote, "fetch advanced lease");
  await waitForAction(page);
  git(small, "branch", "extra");
  git(remote, "update-ref", "refs/heads/extra", advancedRemote);
  git(small, "update-ref", "refs/remotes/origin/extra", advancedRemote);
  git(small, "config", "push.default", "matching");
  await click(page, "button[title='More push options']");
  await click(page, ".push-menu button[title='Force push with lease']");
  await submitActionDialog(page);
  await waitUntil(() => git(remote, "rev-parse", "refs/heads/main") === git(small, "rev-parse", "HEAD"), "force push with lease");
  await waitForAction(page);
  assert.equal(git(remote, "rev-parse", "refs/heads/extra"), advancedRemote, "force push must leave other branches untouched");
  await click(page, "button[title='Delete a remote branch by name']");
  assert.equal(await page.$eval(".action-dialog select", select => select.value), "origin");
  await submitActionDialog(page, { text: "extra" });
  await waitUntil(() => git(remote, "branch", "--list", "extra") === "", "remote branch deletion dialog");
  await waitForAction(page);
  git(small, "tag", "ui-remote-tag");
  await click(page, "button[title='More actions']");
  await click(page, ".push-menu button[title='Refresh']");
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
  await click(page, "button[title='Search commits']");
  await page.locator(".search-box input").fill("Test UI commit");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".commits-pane .pane-heading")?.textContent.includes("SEARCH RESULTS"));
  await page.waitForFunction(() => document.querySelector(".commit-scroll")?.textContent.includes("Test UI commit") || document.querySelector(".error-bar"));
  assert.ok((await page.$eval(".commit-scroll", element => element.textContent)).includes("Test UI commit"));
  assert.equal(await page.$$(".graph-canvas").then(items => items.length), 0, "Search results must not show partial graph lanes");
  await click(page, ".search-box button");
  await page.waitForSelector(".graph-canvas");
  git(remote, "update-ref", "refs/heads/team/ui-track", git(small, "rev-parse", "HEAD"));
  git(small, "fetch", "origin");
  git(small, "remote", "set-head", "origin", "-a");
  await click(page, "button[title='More actions']");
  await click(page, ".push-menu button[title='Refresh']");
  await page.waitForSelector(".branch-chip");
  await click(page, ".branch-chip");
  await page.waitForSelector(".branch-menu-remote button[title='Create tracking branch from origin/team/ui-track']");
  assert.equal(await page.$$(".branch-menu-remote button[title='Create tracking branch from origin/HEAD']").then(items => items.length), 0, "remote HEAD alias must not appear");
  await page.locator(".branch-menu-filter").fill("TEAM/UI");
  assert.equal(await page.$$(".branch-menu-row:not(.branch-menu-remote)").then(items => items.length), 0, "filter must hide nonmatching local branches");
  assert.equal(await page.$$(".branch-menu-remote").then(items => items.length), 1, "filter must find remote branches case-insensitively");
  await click(page, ".branch-menu-remote button");
  await waitUntil(() => git(small, "branch", "--show-current") === "team/ui-track", "remote tracking checkout");
  await waitForAction(page);
  assert.equal(git(small, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"), "origin/team/ui-track");
  await page.waitForFunction(() => document.querySelector(".compare-main strong")?.textContent === "team/ui-track vs origin/main");
  assert.equal(await page.$(".compare-close"), null, "Automatic feature comparisons should stay available");
  assert.ok(await page.$(".working-row.selected"), "Automatic comparisons must preserve the selected view");
  await click(page, ".compare-main");
  await page.waitForSelector(".compare-row.selected");
  await click(page, ".branch-chip");
  await page.locator(".branch-menu-filter").fill("main");
  await click(page, ".branch-menu-row:not(.branch-menu-remote) button:first-child");
  await waitUntil(() => git(small, "branch", "--show-current") === "main", "switch back to main");
  await waitForAction(page);
  await page.waitForFunction(() => !document.querySelector(".compare-row"));
  assert.ok(await page.$(".working-row.selected"), "Returning to main should exit the automatic comparison");
  const longBranch = "feat/x-mac-warmup-gologin-driver-visibility-check";
  await click(page, ".branch-chip");
  await page.locator(".branch-menu form input").fill(longBranch);
  await click(page, ".branch-menu form button");
  await waitUntil(() => git(small, "branch", "--show-current") === longBranch, "branch creation").catch(async error => { throw new Error(`${error.message}: ${await page.$eval(".error-bar", item => item.textContent).catch(() => "no UI error")}`); });
  await page.waitForFunction(branch => document.querySelector(".branch-name")?.textContent === branch, {}, longBranch);
  assert.equal(git(small, "branch", "--show-current"), longBranch);
  await page.waitForFunction(branch => document.querySelector(".compare-main strong")?.textContent === `${branch} vs origin/main`, {}, longBranch);
  await waitForAction(page);
  await click(page, "button[title='Push']");
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
  await click(page, ".branch-chip");
  await page.evaluate(() => [...document.querySelectorAll(".branch-menu-row button")].find(button => button.textContent.trim() === "main")?.click());
  await page.waitForFunction(() => document.querySelector(".branch-chip")?.textContent.includes("main"));
  assert.equal(git(small, "branch", "--show-current"), "main");
  await page.waitForFunction(() => !document.querySelector("button[title='Pull']")?.disabled);
  await click(page, ".branch-chip");
  await page.evaluate(branch => [...document.querySelectorAll(".branch-menu-row")].find(row => row.textContent.includes(branch))?.querySelector(".branch-delete")?.click(), longBranch);
  await submitActionDialog(page);
  await waitUntil(() => !git(small, "branch", "--list", longBranch), "branch deletion");
  await page.waitForFunction(() => !document.querySelector("button[title='Pull']")?.disabled);
  await click(page, ".working-row");
  fs.writeFileSync(path.join(small, "base.txt"), "temporary unwanted change\n");
  await page.waitForFunction(() => [...document.querySelectorAll(".file-row")].some(row => row.textContent.includes("base.txt")), { timeout: 10000 });
  await page.evaluate(() => { const row = [...document.querySelectorAll(".file-row")].find(item => item.textContent.includes("base.txt")); if (row?.getAttribute("aria-expanded") === "false") row.click(); });
  // Discard is confirmed in place: the first click arms it, a second click within the timeout runs it.
  const discardFile = ".summary-diff-heading .row-action::-p-text(Discard)";
  await page.waitForSelector(discardFile);
  // Shorten ConfirmButton's 10 s timeout to check it disarms on its own.
  await page.evaluate(() => { const original = window.setTimeout; window.setTimeout = (handler, delay, ...rest) => { if (delay === 10_000) { window.setTimeout = original; delay = 2000; } return original(handler, delay, ...rest); }; });
  await click(page, discardFile);
  await page.waitForSelector(".summary-diff-heading .row-action.armed");
  await page.waitForFunction(() => !document.querySelector(".row-action.armed"));
  assert.notEqual(git(small, "status", "--porcelain"), "", "Timed-out Discard must not run");
  await click(page, discardFile);
  await page.waitForSelector(".summary-diff-heading .row-action.armed");
  assert.notEqual(git(small, "status", "--porcelain"), "", "First Discard click must only arm");
  await click(page, ".summary-diff-heading .row-action.armed");
  await waitUntil(() => git(small, "status", "--porcelain") === "", "discard file").catch(async error => {
    throw new Error(`${error.message}: ${await page.$eval(".error-bar", item => item.textContent).catch(() => "no UI error")}; status=${git(small, "status", "--short")}`);
  });
  await page.waitForFunction(() => !document.querySelector("button[title='Pull']")?.disabled);
  fs.writeFileSync(path.join(small, "stash.tmp"), "temporary stash\n");
  await click(page, "button[title='More actions']");
  await click(page, ".push-menu button[title='Refresh']");
  await page.waitForFunction(() => [...document.querySelectorAll(".file-row")].some(row => row.textContent.includes("stash.tmp")));
  await click(page, "button[title='Stash']");
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
  await click(page, "button[title='Unstash']");
  await page.waitForFunction(() => document.querySelector(".stash-menu")?.textContent.includes("Headless stash"));
  await page.screenshot({ path: path.join(screenshots, "claude-unstash-menu.png") });
  await click(page, ".stash-menu-actions button:first-child");
  await waitUntil(() => fs.existsSync(path.join(small, "stash.tmp")), "stash apply file");
  assert.match(git(small, "stash", "list", "-1"), /Headless stash/, "Apply must keep the stash");
  fs.unlinkSync(path.join(small, "stash.tmp"));
  await page.waitForFunction(() => !document.querySelector("button[title='Unstash']")?.disabled);
  await click(page, "button[title='More actions']");
  await click(page, ".push-menu button[title='Refresh']");
  await click(page, "button[title='Unstash']");
  await page.waitForSelector(".stash-menu-actions button:last-child");
  await click(page, ".stash-menu-actions button:last-child");
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
  await click(page, "button[title='More pull options']");
  assert.match(await page.$eval(".push-menu", item => item.textContent), /Pull with merge/);
  assert.match(await page.$eval(".push-menu", item => item.textContent), /Pull with rebase/);
  await click(page, ".branch-chip");
  await click(page, "button[title='Rebase main onto topic']");
  await submitActionDialog(page);
  await page.waitForFunction(() => document.querySelector(".operation-panel strong")?.textContent === "Rebase in progress");
  await page.waitForFunction(() => !document.querySelector(".operation-buttons button:last-child")?.disabled);
  assert.equal(git(conflictRepo, "status", "--porcelain").includes("UU shared.txt"), true);
  await page.screenshot({ path: path.join(screenshots, "rebase-conflict.png") });
  await click(page, ".operation-buttons button:last-child");
  await submitActionDialog(page);
  await page.waitForFunction(() => !document.querySelector(".operation-panel"));
  await waitForAction(page);
  assert.equal(git(conflictRepo, "branch", "--show-current"), "main");
  await click(page, ".branch-chip");
  await click(page, "button[title='Merge topic into main']");
  await submitActionDialog(page);
  await page.waitForFunction(() => document.querySelector(".operation-panel strong")?.textContent === "Merge in progress");
  await page.waitForFunction(() => [...document.querySelectorAll(".conflict-row button")].find(button => button.textContent === "Use ours")?.disabled === false);
  await click(page, ".conflict-row button::-p-text(Use ours)");
  await submitActionDialog(page);
  await page.waitForFunction(() => document.querySelector(".operation-panel") && !document.querySelector(".conflict-row"));
  await page.waitForFunction(() => !document.querySelector(".operation-buttons button:first-child")?.disabled);
  assert.equal(fs.readFileSync(path.join(conflictRepo, "shared.txt"), "utf8"), "main\n");
  await click(page, ".operation-buttons button:first-child");
  await page.waitForFunction(() => !document.querySelector(".operation-panel"));
  await waitForAction(page);
  assert.equal(git(conflictRepo, "rev-list", "--parents", "-n", "1", "HEAD").split(" ").length, 3);
  await click(page, ".commit-row");
  await page.waitForSelector(".commit-actions summary");
  assert.equal(await page.$(".in-app-edit-button"), null, "Committed files must not show the in-app edit control");
  await click(page, ".commit-actions summary");
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
  await click(page, ".repo-tab:nth-child(2) .tab-close");

  await openRepo(page, rebaseRepo);
  await page.waitForFunction(() => document.querySelector(".compare-main strong")?.textContent === "topic vs main");
  await click(page, ".compare-main");
  await page.waitForSelector('.summary-diff-card[data-path="a.txt"] .diff-content');
  await page.screenshot({ path: path.join(screenshots, "automatic-feature-comparison.png") });
  await click(page, ".working-row");
  await click(page, ".branch-chip");
  await click(page, "button[title='Plan an interactive rebase onto main']");
  await page.waitForSelector(".rebase-modal .rebase-step:nth-child(3)");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector(".rebase-modal"));
  await click(page, ".branch-chip");
  await click(page, "button[title='Plan an interactive rebase onto main']");
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
  await click(page, ".rebase-step:nth-child(2) .rebase-move button:first-child");
  assert.match(await page.$eval(".rebase-step:first-child", element => element.textContent), /Add B/);
  await page.select(".rebase-step:first-child select", "drop");
  await page.select(".rebase-step:nth-child(3) select", "fixup");
  await page.screenshot({ path: path.join(screenshots, "interactive-rebase-plan.png") });
  await click(page, ".rebase-start");
  await waitForAction(page);
  await waitUntil(() => git(rebaseRepo, "log", "--format=%s", "main..topic") === "Add A", "interactive rebase");
  assert.equal(fs.existsSync(path.join(rebaseRepo, "b.txt")), false, "dropped commit must not appear");
  assert.equal(fs.readFileSync(path.join(rebaseRepo, "c.txt"), "utf8"), "c\n", "fixup content must be kept");
  // A commit on a compared branch updates each open card in place instead of rebuilding the list.
  await page.evaluate(() => document.querySelector('.ref-action-trigger[aria-label="Actions for topic"]')?.click());
  await page.evaluate(() => [...document.querySelectorAll(".ref-action-popover button")].find(button => button.textContent.startsWith("Compare with"))?.click());
  await page.waitForSelector('.summary-diff-card[data-path="a.txt"] .diff-content');
  const cardKeptInPlace = await watchDiffInPlace(page, '.summary-diff-card[data-path="a.txt"]');
  git(rebaseRepo, "switch", "topic");
  fs.writeFileSync(path.join(rebaseRepo, "a.txt"), "a\nmore\n");
  git(rebaseRepo, "commit", "-am", "More A");
  await page.waitForFunction(() => [...document.querySelectorAll('.summary-diff-card[data-path="a.txt"] .diff-line.added .line-text')].some(text => text.textContent === "more"), { timeout: 10000 });
  assert.ok(await cardKeptInPlace(), "a branch move must update compared files in place");
  await click(page, ".repo-tab:nth-child(2) .tab-close");

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
  await click(page, ".ref-section:nth-child(2) .ref-folder");
  const remoteFolders = await page.$$(".ref-section:nth-child(2) .ref-folder");
  await remoteFolders[remoteFolders.length - 1].click();
  const before = await metrics(page);
  console.log("Large layout", JSON.stringify(before));
  assert.equal(before.footer.bottom, before.viewport, "footer must stay at bottom");
  assert.ok(before.listScrollHeight > before.listClientHeight, "locations must scroll internally");
  assert.equal(before.documentScrollHeight, before.viewport, "document must not overflow");
  await page.screenshot({ path: path.join(screenshots, "large-summary.png") });
  const start = Date.now();
  await click(page, ".file-row");
  await page.waitForSelector(".diff-line");
  const fileClickMs = Date.now() - start;
  const after = await metrics(page);
  assert.equal(after.footer.bottom, after.viewport, "file diff must not move footer");
  await page.screenshot({ path: path.join(screenshots, "large-diff.png") });
  assert.equal(await page.$eval(".files-disclosure", button => button.getAttribute("aria-expanded")), "false", "large diffs must start with files collapsed");
  const allStart = Date.now();
  await click(page, ".files-disclosure");
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
  await click(page, "button.layout-toggle");
  await page.setViewport({ width: 960, height: 600, deviceScaleFactor: 1 });
  const compactWidth = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, footerBottom: document.querySelector(".statusbar").getBoundingClientRect().bottom, detailsHeight: document.querySelector(".details-pane").getBoundingClientRect().height }));
  assert.equal(compactWidth.document, compactWidth.viewport, "minimum-size layout must not overflow horizontally");
  assert.equal(compactWidth.footerBottom, 600, "minimum-size footer must stay visible");
  assert.ok(compactWidth.detailsHeight >= 200, "minimum-size details pane must remain usable");
  await page.screenshot({ path: path.join(screenshots, "compact-layout.png") });
  await page.setViewport({ width: 1429, height: 918, deviceScaleFactor: 1 });
  await click(page, "button[title='Toggle locations']");
  assert.equal(await page.$$eval(".locations", items => items.length), 0);
  await click(page, "button[title='Toggle locations']");
  assert.equal(await page.$$eval(".locations", items => items.length), 1);
  assert.equal((await metrics(page)).footer.bottom, 918);
  const bottomWidth = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, commits: document.querySelector(".commits-pane").getBoundingClientRect().right }));
  assert.equal(bottomWidth.document, bottomWidth.viewport, "bottom layout must not overflow horizontally");
  assert.ok(bottomWidth.commits <= bottomWidth.viewport, "history pane must fit viewport");
  await page.screenshot({ path: path.join(screenshots, "bottom-layout.png") });
  await click(page, "button.layout-toggle");
  await click(page, ".repo-tab:first-child .tab-main");
  assert.ok((await page.$eval(".statusbar", element => element.textContent)).includes(small));
  await click(page, ".repo-tab:nth-child(2) .tab-main");
  assert.ok((await page.$eval(".statusbar", element => element.textContent)).includes(large));
  await click(page, ".repo-tab:first-child .tab-close");
  assert.equal(await page.$$eval(".repo-tab", tabs => tabs.length), 1);
  await openRepo(page, lineRepo);
  await click(page, ".summary-open-tab");
  await page.waitForSelector("button.line-number.selectable");
  // A change on disk (e.g. by an AI agent) updates the open file tab in place: no "Loading diff…" blank, no remount.
  const linesFile = path.join(lineRepo, "lines.txt");
  const linesBefore = fs.readFileSync(linesFile, "utf8");
  const fileKeptInPlace = await watchDiffInPlace(page, ".details-scroll");
  fs.writeFileSync(linesFile, linesBefore.replace("line 28\n", "AI 28\n"));
  await page.waitForFunction(() => [...document.querySelectorAll(".diff-line.added .line-text")].some(text => text.textContent === "AI 28"), { timeout: 10000 });
  assert.ok(await fileKeptInPlace(), "a file changed on disk must update the open diff in place");
  await selectFileView(page, "History");
  await page.waitForSelector(".file-history-row");
  assert.match(await page.$eval(".file-history-row", row => row.textContent), /Initial lines/);
  const diffsBefore = diffRequests;
  fs.writeFileSync(linesFile, linesBefore);
  await waitUntil(() => diffRequests > diffsBefore, "reload of the file changed back");
  assert.equal(await page.$eval(".file-view-switch button.active", button => button.textContent.trim()), "History", "a file change must not leave History");
  await selectFileView(page, "Blame");
  await page.waitForSelector(".blame-row");
  assert.equal(await page.$eval(".blame-row .blame-content", code => code.textContent), "line 1");
  assert.equal(await page.$$eval(".blame-row", rows => rows.length), 30);
  await selectFileView(page, "Diff");
  await page.waitForSelector("button.line-number.selectable");
  await page.waitForFunction(() => ![...document.querySelectorAll(".diff-line .line-text")].some(text => text.textContent === "AI 28"));
  await click(page, ".details-tab:first-child");
  await page.evaluate(() => [...document.querySelectorAll(".files-heading button")].find(button => button.textContent === "Browse files")?.click());
  await page.waitForSelector(".file-finder-modal");
  await page.locator(".file-finder-modal input").fill("lines.txt");
  await page.waitForSelector(".file-finder-list button");
  await click(page, ".file-finder-list button");
  await page.waitForSelector(".file-history-row");
  assert.equal(await page.$eval(".diff-heading-target", target => target.textContent), "TRACKED");
  await click(page, ".details-tab:first-child");
  await click(page, ".summary-open-tab");
  await page.waitForSelector("button.line-number.selectable");
  assert.ok(await page.$eval(".details-tab:last-child", tab => tab.classList.contains("active")), "the open-tab button must show the dedicated file tab");
  assert.equal(await page.$eval(".diff-content", element => Number.parseFloat(getComputedStyle(element).fontSize)), await page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--code-size"))), "diff code must use the configured font size");
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
  await click(page, ".stage-lines");
  await waitUntil(() => git(lineRepo, "diff", "--cached").includes("+NEW 3"), "single line staging");
  assert.ok(!git(lineRepo, "diff", "--cached").includes("-line 3"), "adjacent deleted line must remain unstaged");
  assert.ok(!git(lineRepo, "diff", "--cached").includes("NEW 25"), "other hunk must remain unstaged");
  await waitForAction(page);
  await openSummaryFile(page, "lines.txt", "UNSTAGED");
  await page.waitForSelector("button.line-number.selectable");
  await clickChangedLine(page, "-line 25");
  await clickChangedLine(page, "+NEW 25", true);
  assert.match(await page.$eval(".line-selection-toolbar", element => element.textContent), /2 lines selected/);
  await click(page, ".stage-lines");
  await waitUntil(() => git(lineRepo, "diff", "--cached").includes("+NEW 25"), "range line staging");
  assert.ok(git(lineRepo, "diff", "--cached").includes("-line 25"), "selected deletion must stage with selected addition");
  await waitForAction(page);
  await openSummaryFile(page, "lines.txt", "UNSTAGED");
  await page.waitForSelector("button.line-number.selectable");
  await clickChangedLine(page, "+++prefixed");
  await click(page, ".stage-lines");
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
  await click(page, ".stage-lines");
  await waitUntil(() => !git(lineRepo, "diff", "--cached").includes("+NEW 3"), "line unstaging");
  await waitForAction(page);
  await openSummaryFile(page, "lines.txt", "UNSTAGED");
  await page.waitForFunction(() => document.querySelector(".diff-heading-target")?.textContent === "UNSTAGED" && [...document.querySelectorAll(".diff-content .diff-line.added")].some(row => row.querySelector(".line-text")?.textContent === "NEW 3"));
  await clickChangedLine(page, "+NEW 3");
  await click(page, ".discard-selection");
  assert.ok(await page.$(".discard-selection.armed"), "First Discard Lines click must arm the button");
  await clickChangedLine(page, "+NEW 3");
  assert.equal(await page.$(".discard-selection.armed"), null, "Changing the selection must disarm Discard");
  await clickChangedLine(page, "+NEW 3");
  await click(page, ".discard-selection");
  assert.ok(fs.readFileSync(path.join(lineRepo, "lines.txt"), "utf8").includes("NEW 3"), "First Discard Lines click must only arm");
  await click(page, ".discard-selection");
  await waitUntil(() => !fs.readFileSync(path.join(lineRepo, "lines.txt"), "utf8").includes("NEW 3"), "discard selected line");
  await waitForAction(page);
  await page.evaluate(() => [...document.querySelectorAll(".diff-line")].find(row => row.dataset.copyPrefix === "-" && row.querySelector(".line-text")?.textContent === "line 15")?.querySelector(".line-text")?.click());
  assert.equal(await page.$eval(".line-selection-toolbar", element => element.dataset.mode), "hunk");
  assert.match(await page.$eval(".line-selection-toolbar", element => element.textContent), /Hunk 2 of \d+/);
  await click(page, ".discard-selection");
  await click(page, ".discard-selection");
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
    await click(page, ".commit-row");
    await page.waitForSelector(".detail-header .commit-message");
    await page.waitForSelector(".file-row");
    const commitMs = Date.now() - realStart;
    const diffStart = Date.now();
    await click(page, ".file-row");
    await click(page, ".file-row");
    await page.waitForSelector(".diff-line");
    const diffMs = Date.now() - diffStart;
    const stateStart = Date.now();
    await bridge("repo_state", { path: realPath });
    const stateMs = Date.now() - stateStart;
    realRepo = { commitMs, diffMs, stateMs, layout: await metrics(page) };
    await page.screenshot({ path: path.join(screenshots, "real-commit-diff.png") });
  }
  assert.deepEqual(pageErrors, [], "browser must have no uncaught errors");
  assert.deepEqual(invalidRevisionDiffs, [], "switching views must not request a commit from another repository");
  console.log(JSON.stringify({ screenshots, fileClickMs, allClickMs, before, after, bottomWidth, compactWidth, realRepo, pageErrors }, null, 2));
}

main().catch(async error => {
  console.error(error);
  console.error(JSON.stringify({ sandbox, recentActions: actionRequests.slice(-10) }, null, 2));
  const pages = await browser?.pages();
  await pages?.at(-1)?.screenshot({ path: path.join(screenshots, "failure.png") }).catch(() => {});
  process.exitCode = 1;
}).finally(async () => {
  if (browser) await browser.close();
  if (vite) vite.kill();
  if (agent) agent.kill();
  // Keep screenshots for inspection; remove only the disposable repositories.
  for (const name of ["status-other", "harbor", "harbor-ui", "mcp-topic", "mcp", "small", "large", "lines", "whitespace", "conflicts", "rebase-plan", "other", "remote.git", "editor-loading", "comparison-base"]) {
    const target = path.resolve(sandbox, name);
    if (path.dirname(target) !== path.resolve(sandbox)) throw new Error("Unexpected test cleanup path");
    if (fs.existsSync(target)) {
      try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
      catch (error) { console.error(`Could not remove disposable ${name}: ${error.message}`); }
    }
  }
});
