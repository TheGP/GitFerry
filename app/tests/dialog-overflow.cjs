const assert = require("node:assert/strict");

// Exercises the real UI with disposable repositories and synthetic, non-secret SSH prompts.
module.exports = async function ({ page, rebaseRepo, git, click, openRepo, screenshots, path, actionRequests }) {
  const fits = async selector => {
    const box = await page.$eval(selector, element => {
      const r = element.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height, viewport: innerHeight, width: innerWidth };
    });
    assert.ok(box.height > 0 && box.top >= 7 && box.bottom <= box.viewport - 7 && box.left >= 0 && box.right <= box.width + 1, `${selector} must fit the viewport: ${JSON.stringify(box)}`);
  };
  const visible = async selector => {
    assert.ok(await page.$eval(selector, element => {
      const r = element.getBoundingClientRect();
      return r.height > 0 && r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth + 1;
    }), `${selector} must be reachable`);
  };
  const scrollLast = async (scroller, target) => {
    await page.$eval(scroller, element => { element.scrollTop = element.scrollHeight; });
    await visible(target);
  };
  for (let index = 0; index < 35; index++) git(rebaseRepo, "branch", `viewport-${String(index).padStart(2, "0")}`);
  const tree = git(rebaseRepo, "rev-parse", "HEAD^{tree}");
  let head = git(rebaseRepo, "rev-parse", "HEAD");
  for (let index = 0; index < 35; index++) head = git(rebaseRepo, "commit-tree", tree, "-p", head, "-m", `Rebase viewport fixture ${index}`);
  git(rebaseRepo, "update-ref", "refs/heads/topic", head);
  await openRepo(page, rebaseRepo);
  const original = { head: git(rebaseRepo, "rev-parse", "HEAD"), status: git(rebaseRepo, "status", "--porcelain"), index: git(rebaseRepo, "write-tree"), actions: actionRequests.length };
  for (const height of [400, 600, 720]) {
    await page.setViewport({ width: 960, height, deviceScaleFactor: 1 });
    await click(page, "button[title='Settings']");
    await page.waitForSelector('.settings-ssh-row:last-child button');
    await fits('.settings-modal');
    await visible('.settings-footer button');
    assert.ok(await page.$eval('.settings-body', body => body.scrollHeight > body.clientHeight), 'All settings, including saved SSH entries, must have their own scrolling area');
    await scrollLast('.settings-body', '.settings-ssh-row:last-child button');
    await page.focus('.settings-modal .modal-title button');
    let done = false;
    for (let index = 0; index < 100; index++) {
      await page.keyboard.press('Tab');
      const focus = await page.evaluate(() => {
        const active = document.activeElement, r = active.getBoundingClientRect();
        return { inDialog: Boolean(active.closest('.settings-modal')), visible: r.top >= 0 && r.bottom <= innerHeight, done: Boolean(active.closest('.settings-footer')) };
      });
      assert.ok(focus.inDialog && focus.visible, `Keyboard focus must reveal each setting at ${height}px: ${JSON.stringify(focus)}`);
      if (focus.done) { done = true; break; }
    }
    assert.ok(done, 'Keyboard navigation must reach Done after every setting');
    if (height === 600) await page.screenshot({ path: path.join(screenshots, 'settings-short-window.png') });
    await click(page, '.settings-footer button');
    await click(page, "button[title='Open repository']");
    await fits('.open-modal');
    await scrollLast('.open-modal .modal-body', '.open-modal .modal-body form button');
    await click(page, '.open-kind button:last-child');
    await fits('.open-modal');
    await scrollLast('.open-modal .modal-body', '.remote-form button');
    await click(page, 'button[aria-label="Close open repository"]');
    await page.keyboard.down('Control'); await page.keyboard.press('p'); await page.keyboard.up('Control');
    await page.waitForSelector('.palette'); await fits('.palette');
    await scrollLast('.palette-list', '.palette-list button:last-child');
    await page.keyboard.press('Escape');
    await click(page, "button[title='More actions']");
    await fits('.toolbar-center .push-menu');
    await scrollLast('.toolbar-center .push-menu', '.toolbar-center .push-menu > button:last-of-type');
    await page.keyboard.press('Escape');
    await click(page, '.branch-chip');
    await fits('.branch-menu');
    await scrollLast('.branch-menu-list', '.branch-menu-list button[title="More actions for viewport-34"]');
    await visible('.branch-menu-filter'); await visible('.branch-menu form input');
    await click(page, "button[title='Plan an interactive rebase onto main']");
    await page.waitForSelector('.rebase-step:nth-child(38)');
    await fits('.rebase-modal');
    await visible('.rebase-footer button:last-child');
    await scrollLast('.rebase-steps', '.rebase-step:last-child select');
    await click(page, 'button[aria-label="Close rebase plan"]');
    for (const kind of ['confirm', 'password']) {
      await page.evaluate(kind => window.__eventCallbacks['ssh-prompt']({ payload: {
        id: kind === 'confirm' ? 800 : 801, kind, target: 'layout-fixture.example',
        text: Array.from({ length: 100 }, (_, index) => `SSH host verification detail ${index}`).join('\n'),
        error: kind === 'password' ? 'Authentication failed. '.repeat(100) : null,
      } }), kind);
      await page.waitForSelector('.ssh-prompt'); await fits('.ssh-prompt');
      await visible('.ssh-prompt .action-dialog-footer button:first-child');
      if (kind === 'password') {
        await page.focus('.ssh-prompt input[type="password"]');
        await visible('.ssh-prompt input[type="password"]');
      } else {
        await page.$eval('.ssh-prompt .action-dialog-body', body => { body.scrollTop = body.scrollHeight; });
        assert.ok(await page.$eval('.ssh-prompt .ssh-prompt-text', text => {
          const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
          let last;
          for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.textContent.length) last = node;
          if (!last) return false;
          const range = document.createRange();
          range.setStart(last, last.textContent.length - 1); range.setEnd(last, last.textContent.length);
          const r = range.getBoundingClientRect(), body = text.closest('.action-dialog-body').getBoundingClientRect();
          return r.height > 0 && r.top >= body.top - 1 && r.bottom <= body.bottom + 1;
        }), 'The end of a long SSH verification prompt must be readable');
      }
      await click(page, 'button[aria-label="Cancel SSH sign-in"]');
    }
  }
  // Context menus opened close to the bottom must fit, including when resized while open.
  await page.setViewport({ width: 960, height: 600, deviceScaleFactor: 1 });
  await page.$eval('.ref-item[title="viewport-34"]', item => item.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 80, clientY: innerHeight - 10 })));
  await fits('.ref-action-popover');
  await page.setViewport({ width: 960, height: 400, deviceScaleFactor: 1 });
  await fits('.ref-action-popover');
  await scrollLast('.ref-action-popover', '.ref-action-popover button:last-child');
  await page.keyboard.press('Escape');
  assert.deepEqual({ head: git(rebaseRepo, 'rev-parse', 'HEAD'), status: git(rebaseRepo, 'status', '--porcelain'), index: git(rebaseRepo, 'write-tree'), actions: actionRequests.length }, original, 'Inspecting and cancelling dialogs must not change Git state');
  console.log('Short-window UI: Settings and keyboard access, local/SSH repository forms, palette, action menus, branches, rebase, SSH prompts and context menu resizing passed at 400/600/720px');
};
