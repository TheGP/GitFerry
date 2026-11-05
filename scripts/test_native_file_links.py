"""Exercise the installed OS protocol handler in disposable macOS/Windows CI profiles.

No MCP server, token, test-only app command, or developer URL transport is used. The app's
normal settings mirror confirms that native launch events reached working-file navigation.
Rendered caret placement and unsaved buffers are checked by the real-agent browser suite.
"""
import csv
import glob
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile
import time
import traceback
from urllib.parse import urlencode, quote


def run(*args, **kwargs):
    return subprocess.check_output(args, text=True, **kwargs).strip()


def git(root, *args):
    return run("git", "-C", str(root), *args)


def wait(check, description, timeout=60):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if check():
            return
        time.sleep(0.15)
    raise AssertionError("Timed out: " + description)


def main():
    if os.environ.get("GITHUB_ACTIONS") != "true":
        raise SystemExit("This smoke test installs GitFerry and resets its settings. Run only in a disposable GitHub Actions profile.")
    if sys.platform not in ("darwin", "win32"):
        raise SystemExit("Native URL smoke tests require macOS or Windows")
    bundle = Path("native-link-bundle")
    if sys.argv[1:] == ["--prepare"]:
        bundle.mkdir(exist_ok=True)
        if sys.platform == "darwin":
            apps = [Path(path) for path in glob.glob("target/**/release/bundle/macos/GitFerry.app", recursive=True)]
            assert apps, "No bundled macOS app"
            subprocess.run(["ditto", "-c", "-k", "--keepParent", str(max(apps, key=lambda path: path.stat().st_mtime)), str(bundle / "GitFerry.zip")], check=True)
        else:
            installers = glob.glob("target/release/bundle/nsis/*setup.exe")
            assert installers, "No bundled Windows installer"
            shutil.copy2(installers[0], bundle)
        return
    if sys.argv[1:] == ["--unpack"]:
        if sys.platform == "darwin":
            destination = Path("target/release/bundle/macos")
            destination.mkdir(parents=True, exist_ok=True)
            subprocess.run(["ditto", "-x", "-k", str(bundle / "GitFerry.zip"), str(destination)], check=True)
        else:
            destination = Path("target/release/bundle/nsis")
            destination.mkdir(parents=True, exist_ok=True)
            for installer in bundle.glob("*setup.exe"):
                shutil.copy2(installer, destination)
        return
    windows = sys.platform == "win32"
    root = Path(tempfile.mkdtemp(prefix="gitferry-native-links-"))
    app = None

    def pids():
        if windows:
            output = run("tasklist", "/FI", "IMAGENAME eq gitferry.exe", "/FO", "CSV", "/NH")
            return {int(row[1]) for row in csv.reader(output.splitlines()) if len(row) > 1 and row[1].isdigit()}
        result = subprocess.run(["pgrep", "-f", "^" + re.escape(str(app / "Contents/MacOS/gitferry")) + "$"], capture_output=True, text=True)
        return {int(pid) for pid in result.stdout.split()}

    def stop():
        if not pids():
            return
        if windows:
            for pid in pids():
                subprocess.run(["taskkill", "/PID", str(pid)], check=False, capture_output=True)
            try:
                wait(lambda: not pids(), "native window closes", timeout=8)
            except AssertionError:
                for pid in pids():
                    subprocess.run(["taskkill", "/F", "/PID", str(pid)], check=True, capture_output=True)
        else:
            subprocess.run(["osascript", "-e", 'tell application id "com.gitferry.desktop" to quit'], check=True, timeout=20)
        wait(lambda: not pids(), "native process exits")

    if windows:
        installers = glob.glob("target/release/bundle/nsis/*setup.exe")
        assert installers, "No bundled Windows installer"
        destination = root / "installed"
        # NSIS scans its entire command line for /R. A forward-slash /release in argv[0]
        # can accidentally request an app launch, so use an absolute native Windows path.
        installer = Path(installers[0]).resolve()
        subprocess.run([str(installer), "/S", "/D=" + str(destination)], check=True, timeout=90)
        app = destination / "gitferry.exe"
        assert app.is_file(), "NSIS did not install GitFerry"
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Classes\gitferry\shell\open\command") as key:
            command, _ = winreg.QueryValueEx(key, None)
        assert str(app).lower() in command.lower() and "%1" in command, command
        settings = Path(os.environ["APPDATA"]) / "com.gitferry.desktop/settings.json"
    else:
        bundles = [Path(path) for path in glob.glob("target/**/release/bundle/macos/GitFerry.app", recursive=True)]
        assert bundles, "No bundled macOS app"
        app = Path("/Applications/GitFerry.app")
        subprocess.run(["ditto", str(max(bundles, key=lambda path: path.stat().st_mtime)), str(app)], check=True)
        with (app / "Contents/Info.plist").open("rb") as handle:
            info = plistlib.load(handle)
        assert any("gitferry" in item.get("CFBundleURLSchemes", []) for item in info.get("CFBundleURLTypes", [])), "Missing macOS scheme registration"
        subprocess.run(["/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", "-f", str(app)], check=True)
        settings = Path.home() / "Library/Application Support/com.gitferry.desktop/settings.json"

    assert not pids(), "The disposable test profile already has a running GitFerry"
    settings.parent.mkdir(parents=True, exist_ok=True)
    settings.write_text(json.dumps({"gitferry.mcpEnabled": "false", "gitferry.openTabs": "[]", "gitferry.sideEditor": "null"}), encoding="utf-8")
    repo = root / "repository with spaces 文件"
    repo.mkdir()
    git(repo, "init", "-b", "main")
    git(repo, "config", "user.name", "Test")
    git(repo, "config", "user.email", "test@example.test")
    clean = "clean #+% 文件.txt"
    content = "\n".join("line " + str(index) for index in range(1, 121)) + "\n"
    (repo / clean).write_text(content, encoding="utf-8")
    (repo / "modified.txt").write_text("base\n", encoding="utf-8")
    git(repo, "add", ".")
    git(repo, "commit", "-m", "Base")
    (repo / "modified.txt").write_text("working\n", encoding="utf-8")
    (repo / "untracked.txt").write_text("😀x\nsecond\n", encoding="utf-8")
    nested = repo / "nested"
    nested.mkdir()
    git(nested, "init", "-b", "nested")
    (nested / "new.txt").write_text("nested\n", encoding="utf-8")
    linked = root / "linked checkout"
    git(repo, "worktree", "add", "-b", "topic", str(linked))
    head, index = git(repo, "rev-parse", "HEAD"), (repo / ".git/index").read_bytes()

    def send(file, line=1, column=1, repository=None):
        params = {"file": str(file), "line": str(line), "column": str(column)}
        if repository is not None:
            params["repository"] = str(repository)
        url = "gitferry://open?" + urlencode(params, quote_via=quote)
        if windows:
            os.startfile(url)
        else:
            subprocess.run(["open", url], check=True)

    def opened(repository, file, line=1, column=1):
        def check():
            try:
                saved = json.loads(settings.read_text(encoding="utf-8"))
                target = json.loads(saved.get("gitferry.sideEditor", "null"))
                return (saved.get("gitferry.mcpEnabled") == "false" and target is not None
                        and Path(target["repo"]).resolve() == repository.resolve()
                        and target["path"] == file and target["line"] == line and target.get("column") == column
                        and not target.get("commit") and not target.get("readOnly"))
            except (OSError, ValueError, KeyError):
                return False
        try:
            wait(check, "native link reaches " + file)
        except AssertionError as error:
            saved = json.loads(settings.read_text(encoding="utf-8")) if settings.exists() else {}
            state = {key: saved.get(key) for key in ("gitferry.sideEditor", "gitferry.openTabs", "gitferry.mcpEnabled")}
            raise AssertionError(f"{error}; processes={pids()}; settings={state}") from error
        wait(lambda: bool(pids()), "native app running")

    try:
        send(repo / clean, 77, 1)
        opened(repo, clean, 77, 1)
        original_pids = pids()
        assert len(original_pids) == 1, "Cold start created multiple app processes"
        for file, line, column in [("modified.txt", 1, 3), ("untracked.txt", 1, 2), (clean, 78, 2), (clean, 77, 1)]:
            send(repo / file, line, column)
            opened(repo, file, line, column)
            # Windows launches a forwarding process for each click. Wait for that process to
            # exit instead of racing its shutdown immediately after the original UI responds.
            wait(lambda: pids() == original_pids, "warm forwarding process exits", timeout=10)
        send(repo / clean, 77, 1)
        send(repo / clean, 77, 1)
        time.sleep(0.8)
        opened(repo, clean, 77, 1)
        wait(lambda: pids() == original_pids, "repeated forwarding processes exit", timeout=10)
        send(nested / "new.txt")
        opened(nested, "new.txt")
        send(linked / clean, 3, 2, linked)
        opened(linked, clean, 3, 2)
        send(repo / "missing.txt")
        send(repo / clean, 99999)
        time.sleep(1)
        opened(linked, clean, 3, 2)
        assert git(repo, "rev-parse", "HEAD") == head
        assert (repo / ".git/index").read_bytes() == index
        assert (repo / "modified.txt").read_text(encoding="utf-8") == "working\n"
        assert (repo / "untracked.txt").read_text(encoding="utf-8") == "😀x\nsecond\n"
        assert git(repo, "branch", "--show-current") == "main"
        assert git(linked, "branch", "--show-current") == "topic"
        stop()
        send(repo / "untracked.txt", 2, 1)
        opened(repo, "untracked.txt", 2, 1)
        print("Native OS links passed with MCP disabled: cold start, restart, warm/repeated clicks, clean/modified/untracked files, spaces/Unicode/encoded characters, nested repos/worktrees, invalid targets and unchanged Git/file state")
    finally:
        stop()
        shutil.rmtree(root)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Console logs require a signed-in GitHub session; annotations expose actionable test
        # failures through the public check API without weakening the test or adding app probes.
        if os.environ.get("GITHUB_ACTIONS") == "true":
            message = traceback.format_exc().replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
            print("::error title=Native file-link smoke test::" + message, flush=True)
        raise
