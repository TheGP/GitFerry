"""Real WebKit mouse selection in diffs and the transparent side-editor textarea.

Run after installing Playwright and its WebKit browser; app packages must be installed.
Uses demo data only, without Git writes, native editors, or MCP configuration.
"""
import base64
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


def painted_multiline_selection(page):
    # Scope to a real rendered diff, including changed-word and syntax spans.
    pane = page.locator(".diff-content").first
    pane.evaluate("pane => pane.dataset.selectionProbe = ''")
    selector = "[data-selection-probe] .line-text"

    def boxes(word):
        return page.evaluate("""({selector, word}) => {
          const element = [...document.querySelectorAll(selector)].find(e => e.textContent.includes(word));
          if (!element) throw new Error(`Missing selection word: ${word}`);
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const start = node.textContent.indexOf(word);
            if (start < 0) continue;
            const range = document.createRange(); range.setStart(node, start); range.setEnd(node, start + word.length);
            return [...range.getClientRects()].filter(r => r.width > 0).map(r => ({x: r.x, y: r.y, width: r.width, height: r.height}));
          }
          throw new Error(`Missing selection text: ${word}`);
        }""", {"selector": "[data-selection-probe] .diff-line.added .line-text" if word == "loading" else selector, "word": word})

    for first, last, reverse in (("loading", "remoteHost", False), ("loading", "remoteHost", True), ("false", "remoteHost", False), ("remote", "RepositoryPreviewConfigurationWithRemoteTrackingEnabled", False)):
        pane.scroll_into_view_if_needed()
        start, end = boxes(first)[0], boxes(last)[-1]
        points = [{"x": start["x"] + 1, "y": start["y"] + start["height"] / 2}, {"x": end["x"] + end["width"] - 1, "y": end["y"] + end["height"] / 2}]
        if reverse:
            points.reverse()
        page.mouse.move(**points[0]); page.mouse.down(); page.mouse.move(**points[1], steps=12); page.mouse.up()
        page.wait_for_timeout(120)
        selected = page.evaluate("window.getSelection().toString()")
        assert first in selected and last in selected, selected
        copied = page.evaluate("""() => {
          const clipboardData = new DataTransfer();
          window.getSelection().anchorNode.parentElement.dispatchEvent(new ClipboardEvent("copy", {bubbles: true, cancelable: true, clipboardData}));
          return clipboardData.getData("text/plain");
        }""")
        assert first in copied and last in copied, copied
        screenshot = page.screenshot(path=f"/tmp/gitferry-webkit-multiline-{first}-{reverse}.png", scale="css")
        # Inspect painted pixels, not only selection offsets: the WebKit bug copies
        # the complete text while leaving the last selected row visibly unselected.
        print(f"Checking selection pixels: {first} to {last}, reverse={reverse}")
        coverage = page.evaluate("""async ({png, rects}) => {
          const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode();
          const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
          const context = canvas.getContext("2d"); context.drawImage(image, 0, 0);
          return rects.map(rect => {
            const pixels = context.getImageData(Math.ceil(rect.x), Math.ceil(rect.y), Math.floor(rect.width) - 1, Math.floor(rect.height) - 1).data;
            let blue = 0;
            // macOS WebKit blends selection with the underlying red/green row.
            // Count blue background pixels rather than requiring the unblended CSS RGB.
            for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 2] > pixels[i] + 40 && pixels[i + 2] > pixels[i + 1] + 20 && pixels[i + 1] > pixels[i]) blue++;
            return blue / (pixels.length / 4);
          });
        }""", {"png": base64.b64encode(screenshot).decode(), "rects": [start, end]})
        assert all(value > .2 for value in coverage), (first, last, reverse, coverage)
        assert page.locator(".editor-input").count() == 0, "Dragging text must not open the editor"
        assert page.locator(".diff-line.selected").count() == 0, "Dragging text must not select staging lines"
    page.evaluate("window.getSelection().removeAllRanges()")
    print("WebKit: forward/reverse multi-line copying and visible selection pixels, changed words and wrapped final lines passed")


def repeated_find(page):
    editor = page.locator(".editor-input")
    before = editor.input_value()
    page.keyboard.press("Control+f")
    search = page.get_by_role("searchbox", name="Find in view")
    search.fill("loading")
    count = page.locator(".find-count")
    total = int(count.inner_text().split(" of ")[1])
    initial = int(count.inner_text().split(" of ")[0])
    for direction in (1, -1):
        for step in range(total * 2):
            page.keyboard.press("Enter" if direction == 1 else "Shift+Enter")
            page.wait_for_timeout(30)
            expected = (initial - 1 + direction * (step + 1)) % total + 1
            assert count.inner_text() == f"{expected} of {total}"
            assert search.evaluate("input => document.activeElement === input"), "Find must retain focus on editor matches"
            assert editor.input_value() == before, "Repeated Enter must never edit the file"
    page.screenshot(path="/tmp/gitferry-webkit-find-repeated-enter.png")
    page.keyboard.press("Escape")
    assert page.locator(".find-bar").count() == 0
    print("WebKit: repeated Enter and Shift+Enter cycle through editor and diff matches without editing")


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


def editor_range_navigation(browser):
    page = browser.new_page(viewport={"width": 1100, "height": 600})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    try:
        for width, size, editable in ((560, 13, False), (360, 13, False), (560, 15, True), (360, 15, True), (360, 24, False)):
            page.goto(f"http://127.0.0.1:1421/tests/editor-navigation.html?width={width}&size={size}{'&editable' if editable else ''}")
            editor = page.locator(".editor-input")
            editor.wait_for()
            content = editor.input_value()
            if editable:
                editor.fill(content + "\n// unsaved navigation probe")
                content = editor.input_value()
            for line in (246, 176, 246, 176):
                # Repeated clicks must navigate even after scrolling away from the active range.
                page.locator(".editor-scroll").evaluate("e => e.scrollTop = e.scrollHeight")
                button = page.get_by_role("button", name=f"Lines {line}–{line + 5}", exact=True)
                selection = editor.evaluate("e => [e.selectionStart, e.selectionEnd]")
                button.click()
                page.wait_for_timeout(200)
                geometry = page.evaluate("""line => {
                  const scroll = document.querySelector('.editor-scroll');
                  const row = document.querySelector('.editor-rows').children[line - 1];
                  const box = scroll.getBoundingClientRect(), code = row.getBoundingClientRect();
                  return {top: code.top, bottom: code.bottom, viewTop: box.top, viewBottom: box.bottom, height: scroll.clientHeight};
                }""", line)
                assert geometry["height"] > 100 and geometry["top"] >= geometry["viewTop"] - 1 and geometry["bottom"] <= geometry["viewBottom"] + 1, (width, line, geometry)
                assert editor.evaluate("e => [e.selectionStart, e.selectionEnd]") == selection, "Range navigation must not replace the existing code selection"
                assert f"Ln {line}" in page.locator(".editor-status").inner_text()
                assert editor.input_value() == content and editor.evaluate("e => e.readOnly") == (not editable)
            # Keyboard activation must keep focus on the range, too.
            button = page.get_by_role("button", name="Lines 246–251", exact=True)
            button.focus()
            page.keyboard.press("Enter")
            page.wait_for_timeout(200)
            assert button.evaluate("button => document.activeElement === button")
            assert "Ln 246" in page.locator(".editor-status").inner_text()
            assert editor.input_value() == content
            for line, word in ((178, "return"), (246, "value246")):
                page.locator(f".editor-row:nth-child({line})").evaluate("row => row.scrollIntoView({block: 'center'})")
                point = word_point(page, f".editor-row:nth-child({line}) .editor-code", word)
                page.mouse.dblclick(**point)
                page.wait_for_timeout(150)
                selected = editor.evaluate("e => e.value.slice(e.selectionStart, e.selectionEnd)")
                assert selected == word, (width, size, line, word, selected)
                assert editor.input_value() == content
            if editable:
                assert page.locator(".editor-tab-close.dirty").count() == 1
            page.screenshot(path=f"/tmp/gitferry-webkit-range-navigation-{width}-{size}.png")
        assert not errors, errors
        print("WebKit: repeated AI range clicks scroll the requested code into view in wide and narrow editors")
    except BaseException:
        page.screenshot(path="/tmp/gitferry-webkit-range-navigation-failure.png")
        raise
    finally:
        page.close()


def editor_change_overview(browser):
    page = browser.new_page(viewport={"width": 1100, "height": 650})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    try:
        for width, size in ((560, 13), (360, 24)):
            page.goto(f"http://127.0.0.1:1421/tests/editor-navigation.html?overview=changes&editable&width={width}&size={size}")
            editor = page.locator(".editor-input")
            editor.wait_for()
            page.get_by_role("button", name="Modified line 251", exact=True).wait_for()
            assert page.locator(".editor-overview-marker").count() == 4
            # New lines in an unsaved buffer must shift distant markers, without saving.
            editor.fill("// unsaved first line\n" + editor.input_value())
            marker = page.get_by_role("button", name="Modified line 252", exact=True)
            marker.wait_for()
            editor.evaluate("e => {e.focus(); e.setSelectionRange(3, 15)}")
            content = editor.input_value()
            for name, line in (("Modified line 21", 21), ("Added line 191", 191), ("Modified line 252", 252), ("Deleted near line 282", 282)):
                marker = page.get_by_role("button", name=name, exact=True)
                # The map measures actual wrapped rows, rather than assuming fixed line heights.
                geometry = marker.evaluate("""(marker, line) => {
                  const scroll = document.querySelector('.editor-scroll');
                  const row = document.querySelector('.editor-rows').children[line - 1];
                  return {actual: parseFloat(marker.style.top), expected: row.offsetTop / scroll.scrollHeight * 100};
                }""", line)
                assert abs(geometry["actual"] - geometry["expected"]) < 1, (name, geometry)
                marker.click()
                page.wait_for_timeout(100)
                geometry = page.evaluate("""line => {
                  const scroll = document.querySelector('.editor-scroll').getBoundingClientRect();
                  const row = document.querySelector('.editor-rows').children[line - 1].getBoundingClientRect();
                  return {top: row.top, bottom: row.bottom, viewTop: scroll.top, viewBottom: scroll.bottom};
                }""", line)
                assert geometry["top"] >= geometry["viewTop"] - 1 and geometry["top"] < geometry["viewBottom"], (name, geometry)
                assert editor.evaluate("e => [e.selectionStart, e.selectionEnd]") == [3, 15]
                assert editor.input_value() == content
            # Resize the pane and viewport: marker positions must follow rewrapped content.
            page.set_viewport_size({"width": 800, "height": 480})
            page.locator(".editor-pane").evaluate("e => e.style.width = '310px'")
            page.wait_for_timeout(150)
            marker = page.get_by_role("button", name="Modified line 252", exact=True)
            marker.focus()
            page.keyboard.press("Enter")
            assert marker.evaluate("e => document.activeElement === e")
            assert editor.evaluate("e => [e.selectionStart, e.selectionEnd]") == [3, 15]
            # Undo the draft through the input path: markers return to saved-buffer positions.
            editor.fill(content.removeprefix("// unsaved first line\n"))
            page.get_by_role("button", name="Modified line 251", exact=True).wait_for()
            assert page.evaluate("window.navigationEffects") == {"saves": 0, "external": 0}
            page.screenshot(path=f"/tmp/gitferry-webkit-overview-{width}.png")
        page.goto("http://127.0.0.1:1421/tests/editor-navigation.html?overview=large&editable")
        page.get_by_role("button", name="Added lines 101–600", exact=True).wait_for()
        page.get_by_role("button", name="Modified line 750", exact=True).wait_for()
        assert page.locator(".editor-overview-marker").count() == 2
        for mode in ("clean", "untracked", "fail"):
            page.goto(f"http://127.0.0.1:1421/tests/editor-navigation.html?overview={mode}")
            page.locator(".editor-overview").wait_for()
            if mode == "untracked":
                page.get_by_role("button", name="Added lines 1–300", exact=True).wait_for()
            elif mode == "fail":
                page.wait_for_function("document.querySelector('.editor-overview').title.includes('Baseline connection unavailable')")
                assert page.locator(".editor-overview-marker").count() == 0
            else:
                page.wait_for_timeout(100)
                assert page.locator(".editor-overview-marker").count() == 0
        assert not errors, errors
        print("WebKit: overview markers cover all distant changes, wrapped rows, draft edits, resize and selection-safe navigation")
    except BaseException:
        page.screenshot(path="/tmp/gitferry-webkit-overview-failure.png")
        raise
    finally:
        page.close()


def editor_removed_code(browser):
    page = browser.new_page(viewport={"width": 1100, "height": 650})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    try:
        for width, size, editable in ((560, 13, False), (360, 24, True)):
            page.goto(f"http://127.0.0.1:1421/tests/editor-navigation.html?overview=changes&width={width}&size={size}{'&editable' if editable else ''}")
            editor = page.locator(".editor-input")
            editor.wait_for()
            shift = 1 if editable else 0
            if editable:
                editor.fill("// unsaved prefix\n" + editor.input_value())
            content = editor.input_value()
            editor.evaluate("e => {e.focus();e.setSelectionRange(3,15)}")
            button = page.get_by_role("button", name=f"Show removed lines near line {20 + shift}", exact=True)
            button.scroll_into_view_if_needed()
            button.click()
            page.locator(".editor-removed").wait_for()
            assert "Removed line 20" in page.locator(".editor-removed-heading").inner_text()
            assert "const value20 = 20;" in page.locator(".editor-removed-code").inner_text()
            assert editor.input_value() == content
            assert editor.evaluate("e => [e.selectionStart,e.selectionEnd]") == [3,15]
            assert editor.evaluate("e => e.readOnly") == (not editable)
            # The textarea and syntax text must still align after the preview changes the viewport.
            page.locator(f".editor-row:nth-child({20 + shift})").evaluate("e => e.scrollIntoView({block:'center'})")
            point = word_point(page, f".editor-row:nth-child({20 + shift}) .editor-code", "editedNearTop")
            page.mouse.dblclick(**point)
            page.wait_for_timeout(100)
            assert editor.evaluate("e => e.value.slice(e.selectionStart,e.selectionEnd)") == "editedNearTop"
            point = word_point(page, ".editor-removed-code", "value20")
            page.mouse.dblclick(**point)
            page.wait_for_timeout(100)
            assert page.evaluate("window.getSelection().toString()") == "value20"
            # Old line numbers use CSS, so copying the whole removed block contains only source.
            copied = page.locator(".editor-removed-code").evaluate("e => {const s=window.getSelection();s.selectAllChildren(e);return s.toString()}")
            assert copied.strip() == "const value20 = 20;", copied
            page.screenshot(path=f"/tmp/gitferry-webkit-removed-code-{width}.png")
            page.get_by_role("button", name="Next removed block", exact=True).click()
            assert "Removed line 250" in page.locator(".editor-removed-heading").inner_text()
            page.get_by_role("button", name="Next removed block", exact=True).click()
            assert "Removed line 280" in page.locator(".editor-removed-heading").inner_text()
            page.get_by_role("button", name="Close removed code", exact=True).click()
            assert page.locator(".editor-removed").count() == 0
            assert editor.input_value() == content
            if editable:
                # Undoing all changes closes obsolete previews and removes every marker.
                page.get_by_role("button", name=f"Show removed lines near line {20 + shift}", exact=True).click()
                editor.fill(page.evaluate("window.navigationBaseline"))
                page.wait_for_function("!document.querySelector('.editor-removed') && !document.querySelector('.editor-removed-marker')")
            assert page.evaluate("window.navigationEffects") == {"saves": 0, "external": 0}
        for mode, heading, count in (("removed-eof", "Removed lines 298–300", 3), ("removed-all", "Removed lines 1–300", 300)):
            page.goto(f"http://127.0.0.1:1421/tests/editor-navigation.html?overview={mode}&editable")
            editor = page.locator(".editor-input")
            editor.wait_for()
            content = editor.input_value()
            page.locator(".editor-overview-marker.removed").click()
            assert heading in page.locator(".editor-removed-heading").inner_text()
            assert page.locator(".editor-removed-row").count() == count
            assert "value300" in page.locator(".editor-removed-code").inner_text()
            assert editor.input_value() == content
            assert page.evaluate("window.navigationEffects") == {"saves": 0, "external": 0}
        assert not errors, errors
        print("WebKit: actual removed source is copyable in the editor; replacements, EOF, empty files, drafts and selection alignment passed")
    except BaseException:
        page.screenshot(path="/tmp/gitferry-webkit-removed-code-failure.png")
        raise
    finally:
        page.close()


def passive_diff_reading(browser):
    page = browser.new_page(viewport={"width": 1000, "height": 700})
    try:
        page.goto(URL)
        page.locator(".diff-content").first.wait_for()
        result = page.evaluate("""async () => {
          const {preserveDiffScroll} = await import('/src/diffScroll.ts');
          const root = document.createElement('div'); root.className='details-scroll'; root.dataset.scrollView='reading';
          root.style.cssText='position:fixed;left:10px;top:10px;width:580px;height:350px;overflow:auto;z-index:99999;display:block;overflow-anchor:none';
          document.body.append(root);
          const makeRow = (id, text) => {
            const row=document.createElement('div'); row.className='diff-line added'; row.dataset.id=id;
            const code=document.createElement('span'); code.className='line-text'; code.textContent=text; row.append(code); return row;
          };
          const cards = ['a.ts','z.ts'].map(path => {
            const card=document.createElement('div'); card.className='summary-diff-card'; card.dataset.path=path; card.dataset.target='staged';
            const heading=document.createElement('div'); heading.className='summary-diff-heading'; heading.textContent=path;
            const content=document.createElement('div'); content.className='diff-content has-hunks';
            const lines=document.createElement('div'); lines.className='diff-lines'; content.append(lines); card.append(heading,content); root.append(card);
            for(let i=0;i<130;i++) lines.append(makeRow(String(i), `const reading_${i} = '${'wrapped code '.repeat(16)}';`));
            return lines;
          });
          const [above,reading]=cards;
          const row=id => [...reading.children].find(row=>row.dataset.id===String(id));
          const offset=element=>element.getBoundingClientRect().top-root.getBoundingClientRect().top;
          const settle=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
          const anchor=id=>{ root.scrollTop+=offset(row(id))+7; return offset(row(id)); };
          const same=(id,wanted,label)=>{ if(Math.abs(offset(row(id))-wanted)>2) throw Error(`${label}: ${offset(row(id))} != ${wanted}`); };
          let wanted=anchor(80);
          preserveDiffScroll(root,()=>{ for(let i=0;i<30;i++) above.prepend(makeRow('new'+i,'new code above')); });
          await settle(); same(80,wanted,'growth in an earlier file');
          preserveDiffScroll(root,()=>{ for(let i=0;i<45;i++) above.firstElementChild.remove(); });
          await settle(); same(80,wanted,'shrink in an earlier file');
          preserveDiffScroll(root,()=>{ for(let i=0;i<20;i++) reading.prepend(makeRow('prefix'+i,'inserted code')); });
          await settle(); same(80,wanted,'insertions in the current file');
          preserveDiffScroll(root,()=>row(80).replaceWith(row(80).cloneNode(true)));
          await settle(); same(80,wanted,'recreated row');
          wanted=offset(row(81));
          preserveDiffScroll(root,()=>row(80).remove());
          await settle(); same(81,wanted,'nearest surviving row');
          row(90).querySelector('.line-text').textContent='return repeated;';
          row(100).querySelector('.line-text').textContent='return repeated;';
          wanted=anchor(100);
          preserveDiffScroll(root,()=>{
            reading.insertBefore(makeRow('duplicate','return repeated;'),row(60));
            reading.replaceChildren(...[...reading.children].map(row=>row.cloneNode(true)));
          });
          await settle(); same(100,wanted,'duplicate lines use neighbouring context');
          preserveDiffScroll(root,()=>above.prepend(makeRow('copy','code arriving during copying')));
          window.dispatchEvent(new KeyboardEvent('keydown',{key:'Meta',metaKey:true}));
          window.dispatchEvent(new KeyboardEvent('keydown',{key:'c',metaKey:true}));
          await settle(); same(100,wanted,'copying must retain the reading anchor');
          preserveDiffScroll(root,()=>above.prepend(makeRow('late','late code')));
          window.dispatchEvent(new WheelEvent('wheel',{deltaY:200})); root.scrollTop+=200;
          const userScroll=root.scrollTop; await settle();
          if(root.scrollTop!==userScroll) throw Error('Refresh overrode a user scroll');
          preserveDiffScroll(root,()=>above.prepend(makeRow('other','other code')));
          root.dataset.scrollView='another-view'; root.scrollTop=0; await settle();
          if(root.scrollTop!==0) throw Error('An old anchor overrode navigation');
          root.remove(); return true;
        }""")
        assert result
        print("WebKit: passive diff refresh preserves wrapped code, earlier file heights, recreated/duplicate rows, deletion fallbacks, user scrolling and navigation")
    except BaseException:
        page.screenshot(path="/tmp/gitferry-webkit-reading-position-failure.png")
        raise
    finally:
        page.close()


def pane_expansion(page):
    editor = page.locator(".editor-input")
    content = editor.input_value()
    page.set_viewport_size({"width": 1100, "height": 700})
    editor.focus()
    editor.evaluate("e => { window.__expandedEditor = e; const start = e.value.indexOf('loading'); e.setSelectionRange(start, start + 7); }")
    selection = editor.evaluate("e => [e.selectionStart, e.selectionEnd]")
    def check_editor():
        assert editor.evaluate("e => e === window.__expandedEditor")
        assert editor.input_value() == content
        assert editor.evaluate("e => [e.selectionStart, e.selectionEnd]") == selection
        assert page.locator(".editor-tab-close.dirty").count() == 1
    def fills_workspace(selector):
        assert page.locator(selector).evaluate("""pane => {
          const r=pane.getBoundingClientRect(),w=document.querySelector('.workspace').getBoundingClientRect();
          return Math.abs(r.x-w.x)<=1 && Math.abs(r.y-w.y)<=1 && Math.abs(r.width-w.width)<=1 && Math.abs(r.height-w.height)<=1;
        }""")
    page.keyboard.press("Meta+Shift+f")
    fills_workspace(".editor-pane"); check_editor()
    assert page.locator(".find-bar").count() == 0, "Cmd+Shift+F must expand instead of opening Find"
    page.keyboard.press("Meta+Shift+f")
    assert page.locator(".workspace.pane-expanded").count() == 0
    page.set_viewport_size({"width": 1600, "height": 700})
    page.locator(".diff-line.added .line-text").first.click()
    page.set_viewport_size({"width": 1100, "height": 700})
    page.keyboard.press("Control+Shift+f")
    fills_workspace(".details-pane"); check_editor()
    point = word_point(page, ".diff-line.added .line-text", "loading")
    page.mouse.dblclick(**point)
    page.wait_for_timeout(150)
    assert page.locator(".workspace.expanded-changes").count() == 1, "Copying in expanded Changes must not switch to the editor"
    assert page.evaluate("window.getSelection().toString()") == "loading"
    copied = page.evaluate("""() => {
      const clipboardData=new DataTransfer();
      window.getSelection().anchorNode.parentElement.dispatchEvent(new ClipboardEvent('copy',{bubbles:true,cancelable:true,clipboardData}));
      return clipboardData.getData('text/plain');
    }""")
    assert copied == "loading"
    check_editor()
    page.keyboard.press("Control+Shift+f")
    assert page.locator(".workspace.pane-expanded").count() == 0
    editor.focus()
    page.get_by_role("button", name="Expand editor pane", exact=True).click()
    fills_workspace(".editor-pane"); check_editor()
    page.keyboard.press("Control+Shift+2")
    assert page.locator(".workspace.pane-expanded").count() == 0
    check_editor()
    page.keyboard.press("Meta+Shift+2")
    fills_workspace(".editor-pane"); check_editor()
    page.keyboard.press("Control+f")
    page.locator(".find-bar").wait_for()
    page.keyboard.press("Meta+Shift+f")
    assert page.locator(".workspace.pane-expanded").count() == 0
    assert page.locator(".find-bar").count() == 1
    page.keyboard.press("Meta+Shift+f")
    fills_workspace(".editor-pane")
    page.keyboard.press("Escape")
    assert page.locator(".find-bar").count() == 0
    assert page.locator(".workspace.expanded-editor").count() == 1
    page.keyboard.press("Escape")
    assert page.locator(".workspace.pane-expanded").count() == 0
    page.keyboard.press("Control+Shift+1")
    fills_workspace(".details-pane"); check_editor()
    page.screenshot(path="/tmp/gitferry-webkit-expanded-changes.png")
    page.get_by_role("button", name="Restore Changes pane", exact=True).click()
    assert page.locator(".workspace.pane-expanded").count() == 0
    page.keyboard.press("Control+Shift+2")
    page.screenshot(path="/tmp/gitferry-webkit-expanded-editor.png")
    page.keyboard.press("Escape")
    page.set_viewport_size({"width": 1600, "height": 1000})
    print("WebKit: in-app pane expansion, laptop widths, Ctrl/Cmd shortcuts, Find/Escape priority and unsaved selections passed")


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
            editor_range_navigation(browser)
            editor_change_overview(browser)
            editor_removed_code(browser)
            passive_diff_reading(browser)
            page = browser.new_page(viewport={"width": 1700, "height": 1000})
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            try:
                page.goto(URL)
                page.locator(".diff-line.added .line-text").first.wait_for()
                print("WebKit: checking short-window dialogs")
                short_window_dialogs(page)
                print("WebKit: checking painted multi-line selection")
                painted_multiline_selection(page)
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
                print("WebKit: checking repeated Find navigation")
                repeated_find(page)
                pane_expansion(page)
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
