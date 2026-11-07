"""Real WebKit mouse selection in diffs and the transparent side-editor textarea.

Run after installing Playwright and its WebKit browser; app packages must be installed.
Uses demo data only, without Git writes, native editors, or MCP configuration.
"""
from pathlib import Path
import subprocess
import time
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
                for _ in range(2):
                    point = word_point(page, ".diff-line.added .line-text", "isLoading")
                    page.mouse.dblclick(**point)
                    page.wait_for_timeout(350)
                    assert page.evaluate("window.getSelection().toString()") == "isLoading"
                    assert page.locator(".editor-input").count() == 0, "Text selection opened the side editor"
                    copied = page.evaluate("""() => {
                      const clipboardData = new DataTransfer();
                      const event = new ClipboardEvent("copy", {bubbles: true, cancelable: true, clipboardData});
                      window.getSelection().anchorNode.parentElement.dispatchEvent(event);
                      return clipboardData.getData("text/plain");
                    }""")
                    assert copied == "isLoading", copied
                page.screenshot(path="/tmp/gitferry-webkit-diff-selection.png")
                page.locator(".diff-line.added").filter(has_text="isLoading").first.locator(".line-number").dblclick()
                editor = page.locator(".editor-input")
                editor.wait_for()
                page.wait_for_timeout(250)
                for dirty in (False, True):
                    if dirty:
                        editor.fill(editor.input_value() + "\n// unsavedSelectionProbe\n")
                    point = word_point(page, ".editor-code", "isLoading")
                    page.mouse.dblclick(**point)
                    page.wait_for_timeout(350)
                    assert editor.evaluate("input => input.value.slice(input.selectionStart, input.selectionEnd)") == "isLoading"
                    colors = editor.evaluate("input => { const s = getComputedStyle(input, '::selection'); return [s.color, s.backgroundColor]; }")
                    assert all(color not in ("transparent", "rgba(0, 0, 0, 0)") for color in colors), colors
                    if dirty:
                        assert page.locator(".editor-tab-close.dirty").count() == 1
                page.screenshot(path="/tmp/gitferry-webkit-editor-selection.png")
                assert not errors, errors
                print("WebKit: repeated diff word selection and copying, gutter navigation, clean and unsaved editor word selection passed")
            except BaseException:
                page.screenshot(path="/tmp/gitferry-webkit-selection-failure.png")
                raise
            finally:
                browser.close()
    finally:
        server.terminate()
        server.wait(timeout=10)


if __name__ == "__main__":
    main()
