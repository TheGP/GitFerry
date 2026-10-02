use gitferry_agent::{snapshot_with, state_with, ReadBackend};
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

/// Runs Git with every commit at the same instant, so history order depends only on Git's tie-breaking.
fn git(dir: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_AUTHOR_DATE", "1767225600 +0000")
        .env("GIT_COMMITTER_DATE", "1767225600 +0000")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn write(dir: &Path, file: &str, content: &str) {
    let path = dir.join(file);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, content).unwrap();
}

fn commit(dir: &Path, file: &str, content: &str, message: &str) {
    write(dir, file, content);
    git(dir, &["add", "--", file]);
    git(dir, &["commit", "-qm", message]);
}

fn assert_same_reads(dir: &Path, step: &str) {
    let path = dir.to_str().unwrap();
    for (offset, limit) in [(0, 200), (0, 2), (1, 3), (4, 2)] {
        let git =
            serde_json::to_value(snapshot_with(path, offset, limit, ReadBackend::Git).unwrap())
                .unwrap();
        let gix =
            serde_json::to_value(snapshot_with(path, offset, limit, ReadBackend::Gix).unwrap())
                .unwrap();
        for key in [
            "name",
            "path",
            "branch",
            "head",
            "status",
            "refs",
            "remotes",
            "commits",
            "hasMore",
            "operation",
            "rebaseEditPause",
        ] {
            assert_eq!(
                gix[key], git[key],
                "{step}: snapshot {key} at {offset}+{limit}"
            );
        }
    }
    let git = serde_json::to_value(state_with(path, ReadBackend::Git).unwrap()).unwrap();
    let gix = serde_json::to_value(state_with(path, ReadBackend::Gix).unwrap()).unwrap();
    for key in ["branch", "head", "status", "operation", "rebaseEditPause"] {
        assert_eq!(gix[key], git[key], "{step}: state {key}");
    }
}

#[test]
fn gix_reads_match_git_cli() {
    let temp = tempfile::tempdir().unwrap();
    let origin = temp.path().join("origin.git");
    let dir = temp.path().join("repo");
    std::fs::create_dir_all(&dir).unwrap();
    git(temp.path(), &["init", "-q", "--bare", "origin.git"]);
    git(&dir, &["init", "-q", "-b", "main"]);
    git(&dir, &["config", "user.name", "Test"]);
    git(&dir, &["config", "user.email", "test@example.com"]);
    git(&dir, &["config", "core.autocrlf", "false"]);
    write(&dir, "untracked.txt", "new\n");
    assert_same_reads(&dir, "unborn branch");

    commit(&dir, "base.txt", "base\n", "Base\n\nWith a body");
    commit(
        &dir,
        "dir/ü file.txt",
        "unicode\n",
        "  Multi-line\nsubject  \n\nbody",
    );
    git(&dir, &["branch", "feature-a"]);
    git(&dir, &["branch", "feature-b"]);
    commit(&dir, "main.txt", "main\n", "Main work");
    git(&dir, &["checkout", "-q", "feature-a"]);
    commit(&dir, "a.txt", "a\n", "Feature A one");
    commit(&dir, "a.txt", "a2\n", "Feature A two");
    git(&dir, &["checkout", "-q", "feature-b"]);
    commit(&dir, "b.txt", "b\n", "Feature B");
    git(&dir, &["checkout", "-q", "main"]);
    git(
        &dir,
        &[
            "merge",
            "-q",
            "--no-ff",
            "-m",
            "Merge feature-a",
            "feature-a",
        ],
    );
    git(&dir, &["tag", "v1", "HEAD~1"]);
    git(&dir, &["tag", "-a", "v2", "-m", "Annotated", "HEAD"]);
    git(&dir, &["branch", "same-as-main"]);
    assert_same_reads(&dir, "branches, merge and tags");
    // Later history mixes commits in the commit-graph file with newer ones outside it.
    git(&dir, &["commit-graph", "write", "--reachable"]);
    assert_same_reads(&dir, "commit-graph");

    git(&dir, &["remote", "add", "origin", origin.to_str().unwrap()]);
    git(&dir, &["push", "-q", "-u", "origin", "main", "feature-b"]);
    git(&dir, &["remote", "set-head", "origin", "main"]);
    commit(&dir, "ahead.txt", "ahead\n", "Ahead of origin");
    git(&dir, &["checkout", "-q", "-b", "newer", "feature-b"]);
    commit(&dir, "behind.txt", "behind\n", "Only on origin");
    let newer = git(&dir, &["rev-parse", "HEAD"]);
    git(&dir, &["checkout", "-q", "main"]);
    git(&dir, &["branch", "-D", "newer"]);
    git(
        &dir,
        &["update-ref", "refs/remotes/origin/feature-b", &newer],
    );
    git(&dir, &["branch", "--set-upstream-to=main", "feature-a"]);
    git(&dir, &["branch", "gone"]);
    git(&dir, &["config", "branch.gone.remote", "origin"]);
    git(&dir, &["config", "branch.gone.merge", "refs/heads/gone"]);
    git(&dir, &["notes", "add", "-m", "A note", "HEAD"]);
    assert_same_reads(&dir, "upstreams and notes");

    write(&dir, "base.txt", "changed\n");
    commit(&dir, "staged.txt", "one\n", "Staged file");
    write(&dir, "staged.txt", "two\n");
    git(&dir, &["add", "staged.txt"]);
    write(&dir, "staged.txt", "three\n");
    git(&dir, &["mv", "main.txt", "moved.txt"]);
    git(&dir, &["rm", "-q", "a.txt"]);
    std::fs::remove_file(dir.join("ahead.txt")).unwrap();
    write(&dir, "deep/nested/new.txt", "new\n");
    write(&dir, "intent.txt", "intent\n");
    git(&dir, &["add", "-N", "intent.txt"]);
    write(&dir, ".gitignore", "ignored.txt\n");
    write(&dir, "ignored.txt", "ignored\n");
    std::fs::create_dir_all(dir.join("nested-repo")).unwrap();
    git(&dir.join("nested-repo"), &["init", "-q"]);
    assert_same_reads(&dir, "working tree changes");

    // Stashing refuses intent-to-add entries.
    git(&dir, &["rm", "-q", "--cached", "intent.txt"]);
    git(&dir, &["stash", "push", "-q", "-u", "-m", "First stash"]);
    write(&dir, "base.txt", "stashed again\n");
    git(&dir, &["stash", "push", "-q", "-m", "Second stash"]);
    assert_same_reads(&dir, "stashes");

    git(
        &dir,
        &["worktree", "add", "-q", "--detach", "../worktree", "HEAD~1"],
    );
    let worktree = temp.path().join("worktree");
    commit(
        &worktree,
        "worktree.txt",
        "detached\n",
        "Only in the detached worktree",
    );
    assert_same_reads(&dir, "detached worktree");
    assert_same_reads(&worktree, "inside the linked worktree");

    git(&dir, &["checkout", "-q", "-b", "theirs"]);
    commit(&dir, "conflict.txt", "theirs\n", "Theirs adds");
    commit(&dir, "base.txt", "theirs edit\n", "Theirs edits");
    git(&dir, &["rm", "-q", "dir/ü file.txt"]);
    git(&dir, &["commit", "-qm", "Theirs deletes"]);
    git(&dir, &["checkout", "-q", "main"]);
    commit(&dir, "conflict.txt", "ours\n", "Ours adds");
    commit(&dir, "base.txt", "ours edit\n", "Ours edits");
    commit(&dir, "dir/ü file.txt", "ours edit\n", "Ours edits unicode");
    let merge = Command::new("git")
        .arg("-C")
        .arg(&dir)
        .args(["merge", "theirs"])
        .output()
        .unwrap();
    assert!(!merge.status.success(), "the merge should conflict");
    assert_same_reads(&dir, "merge conflicts");
    git(&dir, &["merge", "--abort"]);

    git(&dir, &["checkout", "-q", "--detach", "HEAD~1"]);
    assert_same_reads(&dir, "detached HEAD");
}

/// Git for Windows treats a directory junction as a directory, so a `dir/` ignore pattern hides it.
#[cfg(windows)]
#[test]
fn ignored_directory_junction_matches_git() {
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path().join("repo");
    let store = temp.path().join("build-store");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::create_dir_all(&store).unwrap();
    write(&store, "output.bin", "built\n");
    git(&dir, &["init", "-q", "-b", "main"]);
    git(&dir, &["config", "user.name", "Test"]);
    git(&dir, &["config", "user.email", "test@example.com"]);
    commit(&dir, ".gitignore", "/target/\n", "Ignore build output");
    let link = Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(dir.join("target"))
        .arg(&store)
        .output()
        .unwrap();
    assert!(
        link.status.success(),
        "{}",
        String::from_utf8_lossy(&link.stderr)
    );
    write(&dir, "new.txt", "untracked\n");
    assert_same_reads(&dir, "ignored junction");
}

#[test]
fn gix_refs_hash_changes_only_when_refs_move() {
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path();
    git(dir, &["init", "-q", "-b", "main"]);
    git(dir, &["config", "user.name", "Test"]);
    git(dir, &["config", "user.email", "test@example.com"]);
    commit(dir, "file.txt", "one\n", "One");
    let path = dir.to_str().unwrap();
    let hash = || state_with(path, ReadBackend::Gix).unwrap().refs_hash;
    let first = hash();
    write(dir, "file.txt", "edited\n");
    assert_eq!(hash(), first, "working changes do not move refs");
    assert_eq!(
        snapshot_with(path, 0, 10, ReadBackend::Gix)
            .unwrap()
            .refs_hash,
        first,
        "snapshot and state agree"
    );
    git(dir, &["branch", "other"]);
    let second = hash();
    assert_ne!(second, first);
    commit(dir, "file.txt", "two\n", "Two");
    assert_ne!(hash(), second);
}

#[test]
fn stash_helpers_reached_by_backdated_refs_stay_visible() {
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path();
    git(dir, &["init", "-q", "-b", "main"]);
    git(dir, &["config", "user.name", "Test"]);
    git(dir, &["config", "user.email", "test@example.com"]);
    commit(dir, "file.txt", "base\n", "Base");
    write(dir, "file.txt", "staged\n");
    git(dir, &["add", "file.txt"]);
    write(dir, "untracked.txt", "new\n");
    git(dir, &["stash", "push", "-q", "-u", "-m", "Stash"]);
    for (parent, reference) in [
        ("refs/stash^2", "refs/heads/retained-index"),
        ("refs/stash^3", "refs/remotes/origin/retained-untracked"),
    ] {
        let helper = git(dir, &["rev-parse", parent]);
        let tree = git(dir, &["rev-parse", &format!("{helper}^{{tree}}")]);
        let output = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args([
                "commit-tree",
                &tree,
                "-p",
                &helper,
                "-m",
                "Backdated descendant",
            ])
            .env("GIT_AUTHOR_DATE", "1766534400 +0000")
            .env("GIT_COMMITTER_DATE", "1766534400 +0000")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let descendant = String::from_utf8(output.stdout).unwrap();
        git(dir, &["update-ref", reference, descendant.trim()]);
    }
    assert_same_reads(dir, "backdated branch and remote retain stash helpers");
    let snapshot = snapshot_with(dir.to_str().unwrap(), 0, 200, ReadBackend::Gix).unwrap();
    for parent in ["refs/stash^2", "refs/stash^3"] {
        let helper = git(dir, &["rev-parse", parent]);
        assert!(snapshot.commits.iter().any(|commit| commit.hash == helper));
    }
}

#[test]
fn auto_uses_git_for_non_utf8_commit_and_output_encodings() {
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path();
    git(dir, &["init", "-q", "-b", "main"]);
    git(dir, &["config", "user.name", "Test"]);
    git(dir, &["config", "user.email", "test@example.com"]);
    commit(dir, "file.txt", "base\n", "Base");
    git(dir, &["config", "i18n.commitEncoding", "ISO-8859-1"]);
    git(dir, &["config", "i18n.logOutputEncoding", "UTF-8"]);
    let tree = git(dir, &["rev-parse", "HEAD^{tree}"]);
    let mut child = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["commit-tree", &tree, "-p", "HEAD"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(b"caf\xe9\n").unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let encoded = String::from_utf8(output.stdout).unwrap();
    git(dir, &["update-ref", "refs/heads/main", encoded.trim()]);
    let path = dir.to_str().unwrap();
    let cli = snapshot_with(path, 0, 200, ReadBackend::Git).unwrap();
    assert_eq!(cli.commits[0].subject, "café");
    let auto = snapshot_with(path, 0, 200, ReadBackend::Auto).unwrap();
    assert_eq!(
        serde_json::to_value(auto).unwrap(),
        serde_json::to_value(cli).unwrap()
    );
    assert!(snapshot_with(path, 0, 200, ReadBackend::Gix)
        .unwrap_err()
        .contains("message encoding"));
    git(dir, &["config", "i18n.logOutputEncoding", "ISO-8859-1"]);
    let cli = snapshot_with(path, 0, 200, ReadBackend::Git).unwrap();
    let auto = snapshot_with(path, 0, 200, ReadBackend::Auto).unwrap();
    assert_eq!(
        serde_json::to_value(auto).unwrap(),
        serde_json::to_value(cli).unwrap()
    );
    assert!(snapshot_with(path, 0, 200, ReadBackend::Gix)
        .unwrap_err()
        .contains("log output encoding"));
}
