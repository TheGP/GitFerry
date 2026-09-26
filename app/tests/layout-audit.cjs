// Inspect the source UI in headless Chrome without starting a desktop window or building binaries.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const puppeteer = require("puppeteer-core");

const project = path.resolve(__dirname, "../..");
const chromePath = process.env.CHROME_PATH || (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : "/usr/bin/google-chrome");
const output = fs.mkdtempSync(path.join(os.tmpdir(), "gitferry-layout-"));
const url = "http://127.0.0.1:1421/?demo";
let vite, browser;

async function ready() {
  for (let attempt = 0; attempt < 80; attempt++) {
    try { if ((await fetch(url)).ok) return; } catch { /* Vite is starting. */ }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error("Vite did not start");
}

async function measure(page) {
  return page.evaluate(() => {
    const bounds = element => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, height: rect.height };
    };
    const commits = [...document.querySelectorAll(".commit-row")].map(row => {
      const main = row.querySelector(".commit-main");
      const subject = row.querySelector(".commit-subject");
      const meta = row.querySelector(".commit-meta");
      const decorations = row.querySelector(".decorations");
      return { subject: subject?.textContent, row: bounds(row), content: bounds(main), subjectBounds: bounds(subject), metaBounds: bounds(meta), decorationBounds: decorations && bounds(decorations), scrollHeight: row.scrollHeight, clientHeight: row.clientHeight };
    });
    const controls = [...document.querySelectorAll(".toolbar-button")].map(button => ({ title: button.title, ...bounds(button), icon: button.querySelector(".chevron-icon") && bounds(button.querySelector(".chevron-icon")) }));
    return { width: innerWidth, documentWidth: document.documentElement.scrollWidth, commits, controls };
  });
}

async function main() {
  assert.ok(fs.existsSync(chromePath), `Chrome not found at ${chromePath}`);
  vite = spawn(process.execPath, [path.join(project, "app/node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", "1421", "--strictPort"], { cwd: path.join(project, "app"), windowsHide: true, stdio: "ignore" });
  await ready();
  browser = await puppeteer.launch({ executablePath: chromePath, headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(url);
  await page.waitForSelector(".commit-row");
  assert.equal(await page.$(".working-header"), null, "Working-directory intro still takes space above changes");
  const branchLabels = await page.evaluate(() => {
    const branchSection = document.querySelector(".ref-section");
    const main = [...branchSection.querySelectorAll(".ref-item .ref-name")].find(item => item.textContent === "main");
    return { icons: branchSection.querySelectorAll(".ref-item .ref-icon").length, mainLeft: main.getBoundingClientRect().left, folderLeft: branchSection.querySelector(".ref-folder-name").getBoundingClientRect().left };
  });
  assert.equal(branchLabels.icons, 0, "Branch rows still show glyphs");
  assert.ok(Math.abs(branchLabels.mainLeft - branchLabels.folderLeft) <= 1, "Branch labels do not align with folders");
  const report = [];
  for (const width of [1429, 1100, 960]) {
    await page.setViewport({ width, height: 918, deviceScaleFactor: 1 });
    for (const theme of ["antigravity", "vscode", "sublime", "claude"]) {
      await page.select(".theme-control select", theme);
      const layout = await measure(page);
      report.push({ width, theme, ...layout });
      if (theme === "claude") await page.screenshot({ path: path.join(output, `main-${width}.png`) });
    }
  }
  await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
  await page.select(".theme-control select", "claude");
  await page.evaluate(() => document.querySelector(".commit-row")?.click());
  await page.waitForSelector(".detail-header h2");
  await page.screenshot({ path: path.join(output, "readme-preview.png") });
  await page.click(".working-row");
  for (const layout of report) {
    assert.equal(layout.documentWidth, layout.width, `Page overflow at ${layout.width}px in ${layout.theme}`);
    for (const row of layout.commits.filter(item => item.decorationBounds)) {
      assert.ok(row.subjectBounds.top - row.row.top >= 4, `Commit title touches row top in ${layout.theme}`);
      assert.ok(row.row.bottom - row.decorationBounds.bottom >= 4, `Commit badge touches row bottom in ${layout.theme}`);
    }
    for (const [buttonTitle, menuTitle] of [["Pull", "More pull options"], ["Push", "More push options"]]) {
      const button = layout.controls.find(item => item.title === buttonTitle);
      const menu = layout.controls.find(item => item.title === menuTitle);
      assert.ok(Math.abs(button.top - menu.top) <= 1 && Math.abs(button.bottom - menu.bottom) <= 1, `${buttonTitle} halves are misaligned`);
      assert.ok(Math.abs((menu.icon.top + menu.icon.bottom) / 2 - (menu.top + menu.bottom) / 2) <= 1, `${buttonTitle} chevron is off center`);
    }
  }
  await page.setViewport({ width: 960, height: 918, deviceScaleFactor: 1 });
  await page.select(".theme-control select", "claude");
  await page.screenshot({ path: path.join(output, "branches-clean-960.png") });
  assert.equal(await page.$eval(".summary-diff-card .file-row", row => row.getAttribute("aria-expanded")), "true", "Working files must start expanded");
  await page.waitForSelector(".summary-diff-card .diff-content");
  await page.screenshot({ path: path.join(output, "merged-working-960.png") });
  await page.locator(".search-box input").fill("layout");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelectorAll(".commit-row.search-result").length === 1);
  assert.equal(await page.$$(".graph-canvas").then(items => items.length), 0, "Search results still draw partial commit lanes");
  assert.ok(await page.$eval(".commit-row.search-result", row => Number.parseFloat(getComputedStyle(row).paddingLeft) >= 16), "Search result text needs a left inset");
  await page.screenshot({ path: path.join(output, "search-no-graph-960.png") });
  await page.click(".search-box button");
  await page.waitForSelector(".graph-canvas");
  await page.click(".working-row");
  await page.focus(".commit-scroll");
  await page.keyboard.press("ArrowDown");
  assert.match(await page.$eval(".commit-row.selected", row => row.textContent), /Refine repository overview layout/);
  await page.keyboard.press("j");
  assert.match(await page.$eval(".commit-row.selected", row => row.textContent), /Add persistent SSH transport/);
  await page.keyboard.press("k");
  assert.match(await page.$eval(".commit-row.selected", row => row.textContent), /Refine repository overview layout/);
  await page.keyboard.press("ArrowUp");
  assert.ok(await page.$eval(".working-row", row => row.classList.contains("selected")), "Up did not return to Working Directory");
  await page.keyboard.press("ArrowRight");
  assert.match(await page.$eval(".file-row.keyboard-selected", row => row.textContent), /diff\.css/);
  await page.keyboard.press("ArrowDown");
  assert.match(await page.$eval(".file-row.keyboard-selected", row => row.textContent), /RepositoryView\.tsx/);
  await page.screenshot({ path: path.join(output, "keyboard-file-selected-960.png") });
  await page.keyboard.press("j");
  assert.match(await page.$eval(".file-row.keyboard-selected", row => row.textContent), /notes\.md/);
  await page.keyboard.press("k");
  assert.match(await page.$eval(".file-row.keyboard-selected", row => row.textContent), /RepositoryView\.tsx/);
  await page.keyboard.press("Enter");
  assert.equal(await page.$eval(".file-row.keyboard-selected", row => row.getAttribute("aria-expanded")), "false", "Enter did not close the selected file");
  await page.keyboard.press("Enter");
  assert.equal(await page.$eval(".file-row.keyboard-selected", row => row.getAttribute("aria-expanded")), "true", "Enter did not expand the selected file");
  await page.keyboard.press("ArrowLeft");
  await page.focus(".commit-editor textarea");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("j");
  assert.ok(await page.$eval(".working-row", row => row.classList.contains("selected")), "Typing in commit message moved the commit selection");
  assert.equal(await page.$eval(".commit-editor textarea", input => input.value), "j");
  await page.$eval(".commit-editor textarea", input => { input.value = ""; input.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.evaluate(() => [...document.querySelectorAll(".file-row")].find(row => row.textContent.includes("notes.md"))?.focus());
  await page.keyboard.press("Enter");
  assert.match(await page.$eval(".file-row.keyboard-selected", row => row.textContent), /notes\.md/, "Tab focus did not select its file");
  assert.equal(await page.$eval(".file-row.keyboard-selected", row => row.getAttribute("aria-expanded")), "false");
  await page.keyboard.press("Enter");
  const compactControls = await page.evaluate(() => [".commit-editor-actions label", ".commit-editor-actions button", ".files-heading button:last-child"].map(selector => ({ selector, height: document.querySelector(selector).getBoundingClientRect().height })));
  for (const control of compactControls) assert.ok(control.height <= 34, `${control.selector} wraps at 960px`);
  await page.click("button[title='Settings']");
  await page.select(".settings-body select", "vscode");
  await page.type(".settings-body input", "C:/Editors/code.cmd");
  assert.equal(await page.evaluate(() => localStorage.getItem("gitferry.editor")), "vscode");
  assert.equal(await page.evaluate(() => localStorage.getItem("gitferry.editorExecutable")), "C:/Editors/code.cmd");
  await page.screenshot({ path: path.join(output, "editor-settings-960.png") });
  await page.click(".settings-footer button");
  await page.click("button[title='Settings']");
  assert.equal(await page.$eval(".settings-body input", input => input.value), "C:/Editors/code.cmd");
  await page.select(".settings-body select", "antigravity");
  await page.$eval(".settings-body input", input => { input.value = ""; input.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.keyboard.press("Escape");
  await page.click(".branch-chip");
  await page.screenshot({ path: path.join(output, "branch-menu-960.png") });
  await page.click(".branch-chip");
  await page.click("button[title='Unstash']");
  await page.screenshot({ path: path.join(output, "stash-menu-960.png") });
  await page.click("button[title='Unstash']");
  await page.click(".commit-row");
  await page.waitForSelector(".detail-header h2");
  await page.click(".commit-actions summary");
  await page.screenshot({ path: path.join(output, "commit-actions-960.png") });
  assert.equal(await page.$$(".details-tab").then(tabs => tabs.length), 1, "Summary and All Changes are still separate tabs");
  assert.equal(await page.$eval(".summary-diff-card .file-row", row => row.getAttribute("aria-expanded")), "true", "Commit files should start expanded");
  await page.screenshot({ path: path.join(output, "merged-changes-960.png") });
  await page.click(".layout-toggle");
  await page.screenshot({ path: path.join(output, "bottom-layout-960.png") });
  await page.focus(".commit-scroll");
  for (let index = 0; index < 6; index++) await page.keyboard.press("ArrowDown");
  assert.match(await page.$eval(".commit-row.selected", row => row.textContent), /Initialize project scaffold/, "ArrowDown did not reach the virtualized last commit");
  assert.ok(await page.$eval(".commit-scroll", element => element.scrollTop > 0), "Keyboard selection did not scroll virtualized commits into view");
  await page.keyboard.press("ArrowUp");
  assert.match(await page.$eval(".commit-row.selected", row => row.textContent), /Create agent protocol/);
  await page.click("button[title='Open repository']");
  await page.screenshot({ path: path.join(output, "open-modal-960.png") });
  await page.keyboard.press("Escape");
  await page.click(".layout-toggle");
  await page.setViewport({ width: 1429, height: 918, deviceScaleFactor: 1 });
  await page.click("button[title='More push options']");
  await page.screenshot({ path: path.join(output, "push-menu.png") });
  await page.click("button[title='More push options']");
  await page.click(".details-tab:first-child");
  await page.screenshot({ path: path.join(output, "commit-details.png") });
  await page.screenshot({ path: path.join(output, "merged-changes.png") });
  await page.click(".layout-toggle");
  await page.screenshot({ path: path.join(output, "bottom-layout.png") });
  await page.click(".layout-toggle");
  await page.click(".working-row");
  assert.equal(await page.$eval(".summary-diff-card .file-row", row => row.getAttribute("aria-expanded")), "true", "Working files should start expanded");
  await page.click(".files-heading button:not(.whitespace-toggle)");
  assert.equal(await page.$eval(".summary-diff-card .file-row", row => row.getAttribute("aria-expanded")), "false", "Collapse all did not close files");
  await page.click(".files-heading button:not(.whitespace-toggle)");
  assert.equal(await page.$eval(".summary-diff-card .file-row", row => row.getAttribute("aria-expanded")), "true", "Expand all did not reopen files");
  await page.screenshot({ path: path.join(output, "merged-working-1429.png") });
  await page.click(".summary-diff-card .open-editor-button");
  assert.match(await page.$eval(".notice-bar", element => element.textContent), /:13 in Antigravity/);
  await page.evaluate(() => [...document.querySelectorAll(".summary-diff-card")].find(card => card.querySelector(".file-path")?.textContent.endsWith("RepositoryView.tsx"))?.querySelector(".summary-open-tab")?.click());
  const codeFont = await page.$eval(".diff-content", element => {
    const style = getComputedStyle(element);
    return { family: style.fontFamily, size: style.fontSize, lineHeight: style.lineHeight };
  });
  assert.match(codeFont.family, /^Consolas/);
  assert.equal(codeFont.size, "16px");
  assert.equal(codeFont.lineHeight, "23px");
  const diffReadability = await page.evaluate(() => {
    const pane = document.querySelector(".details-scroll");
    const diff = document.querySelector(".diff-content");
    const longLine = [...diff.querySelectorAll(".diff-line")].find(row => row.textContent.includes("This long sample line"));
    const changed = [...diff.querySelectorAll(".word-change")].map(node => node.textContent.trim()).filter(Boolean);
    const syntax = [...diff.querySelectorAll(".syntax-keyword")].map(node => node.textContent.trim()).filter(Boolean);
    return { editor: Boolean(document.querySelector(".commit-editor")), files: Boolean(document.querySelector(".files-heading")), topGap: diff.getBoundingClientRect().top - pane.getBoundingClientRect().top, overflow: diff.scrollWidth - diff.clientWidth, wrappedHeight: longLine.getBoundingClientRect().height, changed, syntax };
  });
  assert.equal(diffReadability.editor, false, "File tab still shows commit editor");
  assert.equal(diffReadability.files, false, "File tab still shows summary file list");
  assert.ok(diffReadability.topGap < 150, "File diff starts too far below the tabs");
  assert.ok(diffReadability.overflow <= 1, "Diff has horizontal overflow");
  assert.ok(diffReadability.wrappedHeight > 23, "Long code line did not wrap");
  assert.ok(diffReadability.changed.includes("false") && diffReadability.changed.some(part => part.includes("isLoading")), `Changed words are not marked separately: ${JSON.stringify(diffReadability.changed)}`);
  assert.ok(diffReadability.syntax.includes("const"), `Code syntax has no keyword color: ${JSON.stringify(diffReadability.syntax)}`);
  const diffCopy = await page.evaluate(() => {
    const removed = document.querySelector(".diff-line.deleted .line-text");
    const added = document.querySelector(".diff-line.added .line-text");
    const visible = { removed: removed.textContent, added: added.textContent };
    const range = document.createRange();
    range.setStart(removed, 0);
    range.setEnd(added, added.childNodes.length);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    let copied = "";
    document.addEventListener("copy", event => { copied = event.clipboardData.getData("text/plain"); }, { once: true });
    const copySucceeded = document.execCommand("copy");
    selection.removeAllRanges();
    return { visible, copied, copySucceeded };
  });
  assert.equal(diffCopy.visible.removed, "  const loading = false;", "Removed line still displays a diff marker");
  assert.equal(diffCopy.visible.added, "  const loading = repository.isLoading;", "Added line still displays a diff marker");
  assert.equal(diffCopy.copySucceeded, true, "Browser copy command failed");
  assert.equal(diffCopy.copied, "-  const loading = false;\n+  const loading = repository.isLoading;", "Copied diff lines lost their change markers");
  await page.click(".diff-line.added .line-number.selectable");
  assert.equal(await page.$eval(".line-selection-toolbar", element => element.dataset.mode), "lines", "Line-number click did not select the line");
  await page.click(".diff-line.added .line-number.selectable");
  assert.equal(await page.$eval(".line-selection-toolbar", element => element.dataset.mode), "hunk", "Second click did not clear line selection");
  await page.screenshot({ path: path.join(output, "code-typography-1429.png") });
  await page.setViewport({ width: 960, height: 918, deviceScaleFactor: 1 });
  assert.ok(await page.$eval(".diff-content", element => element.scrollWidth - element.clientWidth <= 1), "Narrow diff has horizontal overflow");
  await page.screenshot({ path: path.join(output, "code-typography-960.png") });
  await page.setViewport({ width: 1429, height: 918, deviceScaleFactor: 1 });
  await page.click(".diff-open-editor");
  assert.match(await page.$eval(".notice-bar", element => element.textContent), /:13 in Antigravity/);
  await page.click(".details-tab:first-child");
  await page.click(".all-diff-card .open-editor-button");
  assert.match(await page.$eval(".notice-bar", element => element.textContent), /:13 in Antigravity/);
  const strayText = await page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) {
      if (walker.currentNode.textContent.trim() === "}" && !walker.currentNode.parentElement?.closest(".diff-content")) nodes.push(walker.currentNode.parentElement?.tagName);
    }
    return nodes;
  });
  assert.deepEqual(strayText, [], "Stray brace rendered outside the UI");
  await page.screenshot({ path: path.join(output, "editor-actions.png") });
  await page.click(".commit-row");
  await page.waitForSelector(".commit-row.selected");
  for (const width of [1429, 960]) {
    await page.setViewport({ width, height: 918, deviceScaleFactor: 1 });
    for (const theme of ["antigravity", "vscode", "sublime", "claude"]) {
      await page.select(".theme-control select", theme);
      const selected = await page.evaluate(() => {
        const row = document.querySelector(".commit-row.selected");
        const rgb = color => color.match(/\d+/g).slice(0, 3).map(Number);
        const color = rgb(getComputedStyle(row).backgroundColor);
        const base = rgb(getComputedStyle(document.querySelector(".commits-pane")).backgroundColor);
        return { contrast: Math.hypot(...color.map((channel, index) => channel - base[index])), border: getComputedStyle(row).boxShadow };
      });
      assert.ok(selected.contrast >= 50, `Selected commit is too close to background in ${theme}`);
      assert.notEqual(selected.border, "none", `Selected commit has no accent border in ${theme}`);
      await page.screenshot({ path: path.join(output, `selected-commit-${theme}-${width}.png`) });
    }
  }
  await page.click(".working-row");
  await page.locator(".commit-editor textarea").fill("Keyboard commit");
  await page.evaluate(() => {
    window.__commitClicks = 0;
    document.querySelector(".commit-editor-actions button").addEventListener("click", () => { window.__commitClicks++; }, { capture: true });
  });
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.down(modifier);
  await page.keyboard.press("Enter");
  await page.keyboard.up(modifier);
  await page.waitForFunction(() => window.__commitClicks === 1);
  await page.focus(".search-box input");
  await page.keyboard.down(modifier);
  await page.keyboard.press("Enter");
  await page.keyboard.up(modifier);
  assert.equal(await page.evaluate(() => window.__commitClicks), 1, "Ctrl+Enter in search triggered a commit");
  assert.deepEqual(errors, [], `Browser errors: ${errors.join("; ")}`);
  console.log(JSON.stringify({ output, layoutsChecked: report.length, errors }, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close();
  vite?.kill();
});
