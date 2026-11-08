"""Real WebKit mouse selection in diffs and the transparent side-editor textarea.

Run after installing Playwright and its WebKit browser; app packages must be installed.
Uses demo data only, without Git writes, native editors, or MCP configuration.
"""
from pathlib import Path
import subprocess
import time
import traceback
import urllib.error
import urllib.request

from playwright.sync_api import sync_playwright

APP = Path(__file__).resolve().parents[1]
URL = "http://127.0.0.1:1421/?demo"


def word_point(page, selector, word):
    return page.evaluate("""({selector, word}) => {
      const element = [...document.querySelectorAll(selector)].find(item => item.textContent.includes(word));
      if (!element) throw new Error(`Missing word: ${word}`);
      element.scrollIntoView({block: "nearest"});
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const start = node.textContent.indexOf(word);
        if (start < 0) continue;
        const range = document.createRange(); range.setStart(node, start + 2); range.setEnd(node, start + 3);
        const box = range.getBoundingClientRect();
        return {x: box.x + box.width / 2, y: box.y + box.height / 2};
      }
      throw new Error(`Missing text node: ${word}`);
    }""", {"selector": selector, "word": word})


def short_window_dialogs(page):
    def fits(selector):
        box = page.locator(selector).bounding_box()
        assert box and box["y"] >= 7 and box["y"] + box["height"] <= page.viewport_size["height"] - 7, (selector, box)

    def scroll_to_bottom(selector):
        box = page.locator(selector).bounding_box()
        assert box, selector
        page.mouse.move(box["x"] + box["width"] - 18, box["y"] + min(50, box["height"] / 2))
        page.mouse.wheel(0, 10000)
        page.wait_for_function("selector => { const e = document.querySelector(selector); return e.scrollTop + e.clientHeight >= e.scrollHeight - 1; }", arg=selector)

    for height in (400, 600, 720):
        page.set_viewport_size({"width": 960, "height": height})
        page.get_by_role("button", name="Settings", exact=True).click()
        fits(".settings-modal")
        if height <= 600:
            assert page.locator(".settings-body").evaluate("body => body.scrollHeight > body.clientHeight")
        scroll_to_bottom(".settings-body")
        page.get_by_label("Editor command override").focus()
        assert page.get_by_label("Editor command override").evaluate("input => { const r = input.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }")
        assert page.locator(".settings-footer button").evaluate("button => button.getBoundingClientRect().bottom <= innerHeight")
        if height == 600:
            page.screenshot(path="/tmp/gitferry-webkit-settings-short-window.png")
        page.get_by_role("button", name="Done", exact=True).click()
        page.get_by_role("button", name="Open repository", exact=True).click()
        fits(".open-modal")
        page.get_by_role("button", name="SSH host", exact=True).click()
        scroll_to_bottom(".open-modal .modal-body")
        page.locator(".remote-form input").last.focus()
        assert page.locator(".remote-form input").last.evaluate("input => input.getBoundingClientRect().bottom <= innerHeight")
        page.get_by_role("button", name="Close open repository", exact=True).click()
        page.keyboard.press("Control+p")
        fits(".palette")
        scroll_to_bottom(".palette-list")
        assert page.locator(".palette-list button").last.evaluate("button => button.getBoundingClientRect().bottom <= innerHeight")
        page.keyboard.press("Escape")
        page.get_by_role("button", name="More actions", exact=True).click()
        fits(".toolbar-center .push-menu")
        scroll_to_bottom(".toolbar-center .push-menu")
        assert page.locator(".toolbar-center .push-menu > button").last.evaluate("button => button.getBoundingClientRect().bottom <= innerHeight")
        page.keyboard.press("Escape")
    page.set_viewport_size({"width": 1700, "height": 1000})
    print("WebKit: Settings, local/SSH repository dialog, palette and action menus fit 400/600/720px windows")


def main():
    server = subprocess.Popen(["node", "node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "1421", "--strictPort"], cwd=APP, stdout=subprocess.DEVNULL)
    try:
        for _ in range(100):
            if server.poll() is not None:
                raise RuntimeError("Selection test server exited")
            try:
                with urllib.request.urlopen(URL, timeout=1):
                    break
            except (OSError, urllib.error.URLError):
                time.sleep(.1)
        else:
            raise RuntimeError("Selection test server did not start")
        with sync_playwright() as playwright:
            browser = playwright.webkit.launch()
            page = browser.new_page(viewport={"width": 1700, "height": 1000})
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            try:
                page.goto(URL)
                page.locator(".diff-line.added .line-text").first.wait_for()
                short_window_dialogs(page)
                for _ in range(2):
                    point = word_point(page, ".diff-line.added .line-text", "loading")
                    page.mouse.dblclick(**point)
                    page.wait_for_timeout(350)
                    assert page.evaluate("window.getSelection().toString()") == "loading"
                    page.locator(".editor-input").wait_for()
                    assert page.locator(".editor-input").input_value(), "Double-clicking code must open the file"
                    page.set_viewport_size({"width": 1600, "height": 1000})
                    page.wait_for_timeout(150)
                    assert page.evaluate("window.getSelection().toString()") == "loading", "Opening and resizing must preserve the diff selection"
                    copied = page.evaluate("""() => {
                      const clipboardData = new DataTransfer();
                      const event = new ClipboardEvent("copy", {bubbles: true, cancelable: true, clipboardData});
                      window.getSelection().anchorNode.parentElement.dispatchEvent(event);
                      return clipboardData.getData("text/plain");
                    }""")
                    assert copied == "loading", copied
                page.screenshot(path="/tmp/gitferry-webkit-diff-selection.png")
                editor = page.locator(".editor-input")
                editor.wait_for()
                page.wait_for_timeout(250)
                for dirty in (False, True):
                    if dirty:
                        editor.fill(editor.input_value() + "\n// unsavedSelectionProbe\n")
                    point = word_point(page, ".editor-code", "loading")
                    page.mouse.dblclick(**point)
                    page.wait_for_timeout(350)
                    assert editor.evaluate("input => input.value.slice(input.selectionStart, input.selectionEnd)") == "loading"
                    colors = editor.evaluate("input => { const s = getComputedStyle(input, '::selection'); return [s.color, s.backgroundColor]; }")
                    assert all(color not in ("transparent", "rgba(0, 0, 0, 0)") for color in colors), colors
                    if dirty:
                        assert page.locator(".editor-tab-close.dirty").count() == 1
                page.screenshot(path="/tmp/gitferry-webkit-editor-selection.png")
                page.locator(".editor-tab-close").click()
                page.locator(".action-dialog-submit").click()
                page.locator(".editor-input").wait_for(state="detached")
                page.get_by_role("checkbox", name="Wrap diff lines").uncheck()
                bar = page.locator(".diff-horizontal-scroll").first
                bar.wait_for(state="visible")
                bar.evaluate("bar => { bar.scrollLeft = bar.scrollWidth; }")
                page.wait_for_function("document.querySelector('.diff-content').scrollLeft > 100")
                assert bar.evaluate("bar => getComputedStyle(bar).position") == "sticky"
                assert page.evaluate("""() => {
                  const pane = document.querySelector('.diff-content'), text = pane.querySelector('.diff-line.added .line-text');
                  const last = [...pane.querySelectorAll('.diff-line.added .line-text')].at(-1);
                  const range = document.createRange(); range.selectNodeContents(last); range.collapse(false);
                  const end = range.getBoundingClientRect(), bounds = pane.getBoundingClientRect();
                  return end.right <= bounds.right + 1;
                }"""), "The end of the long line must be reachable by horizontal scrolling"
                page.get_by_role("checkbox", name="Wrap diff lines").check()
                page.wait_for_function("document.querySelector('.diff-content').scrollLeft === 0")
                assert page.evaluate("document.querySelector('.diff-content').scrollWidth <= document.querySelector('.diff-content').clientWidth + 1")
                assert not errors, errors
                print("WebKit: repeated diff word selection and copying, double-click editor opening, clean and unsaved editor selection, wrapping and horizontal scrolling passed")
            except BaseException:
                page.screenshot(path="/tmp/gitferry-webkit-selection-failure.png")
                raise
            finally:
                browser.close()
    finally:
        server.terminate()
        server.wait(timeout=10)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        message = traceback.format_exc().replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
        print(f"::error title=WebKit selection::{message}")
        raise
