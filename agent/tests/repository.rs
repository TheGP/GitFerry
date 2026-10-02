use gitferry_agent::{
    action, action_with_progress, blame, cancel_operation, commit_details, compare, diff,
    diff_with_context, file_history, read_file, rebase_plan, save_file, search, snapshot,
    tracked_files, watch,
};
use gitferry_proto::{RebaseStep, RepoAction, Request, Response, RpcRequest, RpcResponse};
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

fn git(dir: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().to_string()
}

#[test]
fn code_search_finds_literal_introductions_and_removals_with_pagination() {
    let temp = tempfile::tempdir().unwrap();
    git(temp.path(), &["init", "-q"]);
    git(temp.path(), &["config", "user.name", "Test"]);
    git(temp.path(), &["config", "user.email", "test@example.com"]);
    let file = temp.path().join("code.txt");
    for (content, message) in [
        ("base\n", "Base"),
        ("base\nneedle.*\n", "Introduce"),
        ("changed\nneedle.*\n", "Unrelated"),
        ("changed\n", "Remove"),
    ] {
        std::fs::write(&file, content).unwrap();
        git(temp.path(), &["add", "code.txt"]);
        git(temp.path(), &["commit", "-qm", message]);
    }
    let path = temp.path().to_str().unwrap();
    let first = search(path, "code:needle.*", 0, 1).unwrap();
    assert_eq!(first.commits[0].subject, "Remove");
    assert!(first.has_more);
    let second = search(path, "code:needle.*", 1, 1).unwrap();
    assert_eq!(second.commits[0].subject, "Introduce");
    assert!(!second.has_more);
    assert!(search(path, "code:needleXYZ", 0, 100)
        .unwrap()
        .commits
        .is_empty());
}

#[test]
fn code_search_preserves_significant_whitespace() {
    let temp = tempfile::tempdir().unwrap();
    git(temp.path(), &["init", "-q"]);
    git(temp.path(), &["config", "user.name", "Test"]);
    git(temp.path(), &["config", "user.email", "test@example.com"]);
    let file = temp.path().join("code.txt");
    std::fs::write(&file, "if (ready)\n").unwrap();
    git(temp.path(), &["add", "."]);
    git(temp.path(), &["commit", "-qm", "Base"]);
    std::fs::write(&file, "    if (ready) \n").unwrap();
    git(
        temp.path(),
        &["commit", "-qam", "Indent and trailing space"],
    );
    let path = temp.path().to_str().unwrap();
    assert_eq!(
        search(path, "code:    if", 0, 100).unwrap().commits[0].subject,
        "Indent and trailing space"
    );
    assert_eq!(
        search(path, "code:(ready) ", 0, 100).unwrap().commits[0].subject,
        "Indent and trailing space"
    );
    assert!(search(path, "code:        if", 0, 100)
        .unwrap()
        .commits
        .is_empty());
}

#[test]
fn edits_working_files_and_stages_saved_staged_files() {
    let temp = tempfile::tempdir().unwrap();
    git(temp.path(), &["init", "-q"]);
    git(temp.path(), &["config", "user.name", "Test"]);
    git(temp.path(), &["config", "user.email", "test@example.com"]);
    let file = temp.path().join("file.txt");
    std::fs::write(&file, "committed\n").unwrap();
    git(temp.path(), &["add", "file.txt"]);
    git(temp.path(), &["commit", "-qm", "Initial"]);
    std::fs::write(&file, "staged\n").unwrap();
    git(temp.path(), &["add", "file.txt"]);
    std::fs::write(&file, "working\n").unwrap();
    let path = temp.path().to_str().unwrap();
    assert_eq!(read_file(path, "file.txt").unwrap().content, "working\n");
    let saved = save_file(path, "file.txt", "edited\n", "working\n", true).unwrap();
    assert!(saved.staged);
    assert!(saved.warning.is_none());
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "edited\n");
    assert_eq!(git(temp.path(), &["show", ":file.txt"]), "edited");
    assert!(git(temp.path(), &["diff", "--", "file.txt"]).is_empty());

    let error = save_file(path, "file.txt", "stale write\n", "working\n", true).unwrap_err();
    assert!(error.contains("changed on disk"));
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "edited\n");

    save_file(path, "file.txt", "unstaged\n", "edited\n", false).unwrap();
    assert_eq!(git(temp.path(), &["show", ":file.txt"]), "edited");
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "unstaged\n");
    assert!(save_file(path, "../outside.txt", "bad", "", false).is_err());
    std::fs::write(&file, "one\r\ntwo\n").unwrap();
    assert!(read_file(path, "file.txt")
        .unwrap_err()
        .contains("mixed line endings"));
}

#[test]
fn file_preview_and_editor_enforce_their_read_limits() {
    let temp = tempfile::tempdir().unwrap();
    git(temp.path(), &["init", "-q"]);
    let path = temp.path().to_str().unwrap();
    let file = temp.path().join("large.txt");
    let preview_limit = 512 * 1024;
    let editor_limit = 1024 * 1024;
    std::fs::write(&file, vec![b'x'; preview_limit]).unwrap();
    let preview = diff(path, "untracked", "large.txt").unwrap();
    assert_eq!(preview.text.len(), preview_limit);
    assert!(!preview.truncated);
    std::fs::write(&file, vec![b'x'; editor_limit]).unwrap();
    assert_eq!(
        read_file(path, "large.txt").unwrap().content.len(),
        editor_limit
    );
    let preview = diff(path, "untracked", "large.txt").unwrap();
    assert_eq!(preview.text.len(), preview_limit);
    assert!(preview.truncated);
    std::fs::write(&file, vec![b'x'; 8 * editor_limit]).unwrap();
    assert!(read_file(path, "large.txt")
        .unwrap_err()
        .contains("too large"));
    assert!(save_file(path, "large.txt", "replacement", "", false)
        .unwrap_err()
        .contains("too large"));
    assert_eq!(
        std::fs::metadata(file).unwrap().len(),
        (8 * editor_limit) as u64
    );
}

#[test]
fn status_revisions_change_only_for_the_modified_file() {
    let temp = tempfile::tempdir().unwrap();
    git(temp.path(), &["init", "-q"]);
    git(temp.path(), &["config", "user.name", "Test"]);
    git(temp.path(), &["config", "user.email", "test@example.com"]);
    std::fs::write(temp.path().join("one.txt"), "one\n").unwrap();
    std::fs::write(temp.path().join("two.txt"), "two\n").unwrap();
    git(temp.path(), &["add", "."]);
    git(temp.path(), &["commit", "-qm", "Initial"]);
    std::fs::write(temp.path().join("one.txt"), "changed one\n").unwrap();
    std::fs::write(temp.path().join("two.txt"), "changed two\n").unwrap();
    let path = temp.path().to_str().unwrap();
    let first = snapshot(path, 0, 10).unwrap().status;
    std::fs::write(temp.path().join("one.txt"), "changed one again\n").unwrap();
    let second = snapshot(path, 0, 10).unwrap().status;
    let find = |entries: &Vec<gitferry_proto::StatusEntry>, name: &str| {
        entries
            .iter()
            .find(|entry| entry.path == name)
            .unwrap()
            .worktree_revision
            .clone()
    };
    assert_ne!(find(&first, "one.txt"), find(&second, "one.txt"));
    assert_eq!(find(&first, "two.txt"), find(&second, "two.txt"));
    git(temp.path(), &["add", "one.txt"]);
    let staged = snapshot(path, 0, 10).unwrap().status;
    let one = staged.iter().find(|entry| entry.path == "one.txt").unwrap();
    assert!(!one.index_revision.is_empty());
    assert_eq!(find(&first, "two.txt"), find(&staged, "two.txt"));
}

#[test]
fn restores_selected_stash_and_only_pop_removes_it() {
    let temp = tempfile::tempdir().unwrap();
    git(temp.path(), &["init", "-q"]);
    git(temp.path(), &["config", "user.name", "Test"]);
    git(temp.path(), &["config", "user.email", "test@example.com"]);
    std::fs::write(temp.path().join("hello.txt"), "first\n").unwrap();
    git(temp.path(), &["add", "hello.txt"]);
    git(temp.path(), &["commit", "-qm", "Initial"]);
    let path = temp.path().to_str().unwrap();
    std::fs::write(temp.path().join("hello.txt"), "stashed\n").unwrap();
    action(
        path,
        RepoAction::Stash {
            message: "Test stash".into(),
        },
    )
    .unwrap();
    let hash = snapshot(path, 0, 20)
        .unwrap()
        .refs
        .into_iter()
        .find(|item| item.kind == "stash")
        .unwrap()
        .target;

    assert!(action(path, RepoAction::ApplyStash { hash: "bad".into() }).is_err());
    action(path, RepoAction::ApplyStash { hash: hash.clone() }).unwrap();
    assert_eq!(
        std::fs::read_to_string(temp.path().join("hello.txt")).unwrap(),
        "stashed\n"
    );
    assert_eq!(git(temp.path(), &["stash", "list", "--format=%H"]), hash);

    git(temp.path(), &["restore", "hello.txt"]);
    action(path, RepoAction::PopStash { hash: hash.clone() }).unwrap();
    assert_eq!(
        std::fs::read_to_string(temp.path().join("hello.txt")).unwrap(),
        "stashed\n"
    );
    assert_eq!(git(temp.path(), &["stash", "list", "--format=%H"]), "");
    assert!(action(path, RepoAction::PopStash { hash }).is_err());
}

#[test]
fn hides_stash_helpers_unless_another_ref_reaches_them() {
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path();
    git(dir, &["init", "-q", "-b", "main"]);
    git(dir, &["config", "user.name", "Test"]);
    git(dir, &["config", "user.email", "test@example.com"]);
    std::fs::write(dir.join("tracked.txt"), "base\n").unwrap();
    git(dir, &["add", "tracked.txt"]);
    git(dir, &["commit", "-qm", "Initial"]);
    std::fs::write(dir.join("tracked.txt"), "staged\n").unwrap();
    git(dir, &["add", "tracked.txt"]);
    std::fs::write(dir.join("new.txt"), "untracked\n").unwrap();
    let path = dir.to_str().unwrap();
    action(
        path,
        RepoAction::Stash {
            message: "WIP".into(),
        },
    )
    .unwrap();
    let parents: Vec<String> = git(dir, &["rev-list", "--parents", "-n", "1", "refs/stash"])
        .split_whitespace()
        .map(str::to_string)
        .collect();
    assert_eq!(
        parents.len(),
        4,
        "stash should include index and untracked parents"
    );

    let history = snapshot(path, 0, 20).unwrap();
    let stash = history
        .commits
        .iter()
        .find(|item| item.hash == parents[0])
        .unwrap();
    assert_eq!(stash.parents, vec![parents[1].clone()]);
    assert!(stash
        .decorations
        .iter()
        .any(|item| item.contains("refs/stash")));
    assert!(history
        .refs
        .iter()
        .any(|item| item.kind == "stash" && item.target == parents[0]));
    assert!(!history
        .commits
        .iter()
        .any(|item| item.hash == parents[2] || item.hash == parents[3]));
    assert!(search(path, "index on", 0, 20).unwrap().commits.is_empty());
    assert!(search(path, "untracked files on", 0, 20)
        .unwrap()
        .commits
        .is_empty());
    assert_eq!(
        search(path, "WIP", 0, 20).unwrap().commits[0].parents,
        vec![parents[1].clone()]
    );

    git(dir, &["branch", "keep-index", &parents[2]]);
    git(dir, &["tag", "keep-untracked", &parents[3]]);
    let protected = snapshot(path, 0, 20).unwrap();
    assert!(protected.commits.iter().any(|item| item.hash == parents[2]));
    assert!(protected.commits.iter().any(|item| item.hash == parents[3]));
    assert_eq!(
        protected
            .commits
            .iter()
            .find(|item| item.hash == parents[0])
            .unwrap()
            .parents,
        vec![parents[1].clone()]
    );
    git(dir, &["branch", "-D", "keep-index"]);
    git(
        dir,
        &["update-ref", "refs/remotes/origin/keep-index", &parents[2]],
    );
    assert!(snapshot(path, 0, 20)
        .unwrap()
        .commits
        .iter()
        .any(|item| item.hash == parents[2]));
}

#[test]
fn stash_helper_filter_keeps_snapshot_and_search_pages_contiguous() {
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path();
    git(dir, &["init", "-q", "-b", "main"]);
    git(dir, &["config", "user.name", "Test"]);
    git(dir, &["config", "user.email", "test@example.com"]);
    std::fs::write(dir.join("tracked.txt"), "base\n").unwrap();
    git(dir, &["add", "tracked.txt"]);
    git(dir, &["commit", "-qm", "Page base"]);
    for number in 1..=4 {
        std::fs::write(dir.join("tracked.txt"), format!("Page {number}\n")).unwrap();
        git(dir, &["commit", "-qam", &format!("Page {number}")]);
    }
    std::fs::write(dir.join("tracked.txt"), "Page staged\n").unwrap();
    git(dir, &["add", "tracked.txt"]);
    std::fs::write(dir.join("new.txt"), "Page untracked\n").unwrap();
    let path = dir.to_str().unwrap();
    action(
        path,
        RepoAction::Stash {
            message: "Page stash".into(),
        },
    )
    .unwrap();

    let expected: Vec<String> = snapshot(path, 0, 200)
        .unwrap()
        .commits
        .into_iter()
        .map(|item| item.hash)
        .collect();
    let mut actual = Vec::new();
    loop {
        let page = snapshot(path, actual.len(), 1).unwrap();
        assert_eq!(page.commits.len(), 1);
        actual.push(page.commits[0].hash.clone());
        if !page.has_more {
            break;
        }
        assert!(actual.len() < 20, "history paging did not finish");
    }
    assert_eq!(actual, expected);

    let expected_search: Vec<String> = search(path, "Page", 0, 200)
        .unwrap()
        .commits
        .into_iter()
        .map(|item| item.hash)
        .collect();
    let mut actual_search = Vec::new();
    loop {
        let page = search(path, "Page", actual_search.len(), 1).unwrap();
        assert_eq!(page.commits.len(), 1);
        actual_search.push(page.commits[0].hash.clone());
        if !page.has_more {
            break;
        }
        assert!(actual_search.len() < 20, "search paging did not finish");
    }
    assert_eq!(actual_search, expected_search);
}

#[test]
fn pages_without_stash_are_contiguous_in_history_and_search() {
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path();
    git(dir, &["init", "-q", "-b", "main"]);
    git(dir, &["config", "user.name", "Test"]);
    git(dir, &["config", "user.email", "test@example.com"]);
    for number in 0..7 {
        std::fs::write(dir.join("tracked.txt"), format!("Page {number}\n")).unwrap();
        git(dir, &["add", "tracked.txt"]);
        git(dir, &["commit", "-qm", &format!("Page {number}")]);
    }
    let expected: Vec<String> = git(dir, &["log", "HEAD", "--all", "--format=%H"])
        .lines()
        .map(str::to_string)
        .collect();
    let path = dir.to_str().unwrap();
    let mut history = Vec::new();
    let mut results = Vec::new();
    for offset in [0, 3, 6, 9] {
        let page = snapshot(path, offset, 3).unwrap();
        let search_page = search(path, "Page", offset, 3).unwrap();
        assert_eq!(page.has_more, offset + 3 < expected.len());
        assert_eq!(search_page.has_more, page.has_more);
        history.extend(page.commits.into_iter().map(|item| item.hash));
        results.extend(search_page.commits.into_iter().map(|item| item.hash));
    }
    assert_eq!(history, expected);
    assert_eq!(results, expected);
}

#[test]
fn stages_only_selected_changed_lines_and_rejects_stale_diffs() {
    let temp = tempfile::tempdir().unwrap();
    git(temp.path(), &["init", "-q"]);
    git(temp.path(), &["config", "user.name", "Test"]);
    git(temp.path(), &["config", "user.email", "test@example.com"]);
    let path = temp.path().to_str().unwrap();
    let file = temp.path().join("lines.txt");
    let original = (1..=30)
        .map(|number| format!("line {number}\n"))
        .collect::<String>();
    std::fs::write(&file, &original).unwrap();
    git(temp.path(), &["add", "lines.txt"]);
    git(temp.path(), &["commit", "-qm", "Initial"]);
    let changed = original
        .replace("line 3\n", "NEW 3\n")
        .replace("line 25\n", "NEW 25\n");
    std::fs::write(&file, &changed).unwrap();
    let before = diff(path, "working", "lines.txt").unwrap().text;
    let added_three = before
        .split('\n')
        .position(|line| line == "+NEW 3")
        .unwrap();
    action(
        path,
        RepoAction::StageLines {
            path: "lines.txt".into(),
            lines: vec![added_three],
            diff: before,
        },
    )
    .unwrap();
    let staged = diff(path, "staged", "lines.txt").unwrap().text;
    assert!(staged.contains("+NEW 3"));
    assert!(!staged.contains("-line 3"));
    assert!(!staged.contains("NEW 25"));
    assert_eq!(std::fs::read_to_string(&file).unwrap(), changed);

    let next = diff(path, "working", "lines.txt").unwrap().text;
    let selected = next
        .split('\n')
        .enumerate()
        .filter_map(|(index, line)| ["-line 25", "+NEW 25"].contains(&line).then_some(index))
        .collect::<Vec<_>>();
    assert_eq!(selected.len(), 2);
    action(
        path,
        RepoAction::StageLines {
            path: "lines.txt".into(),
            lines: selected,
            diff: next,
        },
    )
    .unwrap();
    let staged = diff(path, "staged", "lines.txt").unwrap().text;
    assert!(staged.contains("+NEW 25"));
    assert!(staged.contains("-line 25"));

    let stale = diff(path, "working", "lines.txt").unwrap().text;
    let old_three = stale
        .split('\n')
        .position(|line| line == "-line 3")
        .unwrap();
    std::fs::write(&file, changed.replace("line 12\n", "NEW 12\n")).unwrap();
    let error = action(
        path,
        RepoAction::StageLines {
            path: "lines.txt".into(),
            lines: vec![old_three],
            diff: stale,
        },
    )
    .unwrap_err();
    assert!(error.contains("Diff changed"));
}

#[test]
fn rejects_partial_line_stage_without_final_newline() {
    let temp = tempfile::tempdir().unwrap();
    git(temp.path(), &["init", "-q"]);
    git(temp.path(), &["config", "user.name", "Test"]);
    git(temp.path(), &["config", "user.email", "test@example.com"]);
    let path = temp.path().to_str().unwrap();
    std::fs::write(temp.path().join("tail.txt"), "old").unwrap();
    git(temp.path(), &["add", "tail.txt"]);
    git(temp.path(), &["commit", "-qm", "Initial"]);
    std::fs::write(temp.path().join("tail.txt"), "new").unwrap();
    let current = diff(path, "working", "tail.txt").unwrap().text;
    let added = current.split('\n').position(|line| line == "+new").unwrap();
    let error = action(
        path,
        RepoAction::StageLines {
            path: "tail.txt".into(),
            lines: vec![added],
            diff: current,
        },
    )
    .unwrap_err();
    assert!(error.contains("whole hunk"));
    let staged = diff(path, "staged", "tail.txt").unwrap().text;
    assert_eq!(staged, "");
}

#[test]
fn stages_a_selected_deletion_without_other_changes() {
    let temp = tempfile::tempdir().unwrap();
    git(temp.path(), &["init", "-q"]);
    git(temp.path(), &["config", "user.name", "Test"]);
    git(temp.path(), &["config", "user.email", "test@example.com"]);
    let path = temp.path().to_str().unwrap();
    std::fs::write(temp.path().join("lines.txt"), "one\ntwo\nthree\n").unwrap();
    git(temp.path(), &["add", "lines.txt"]);
    git(temp.path(), &["commit", "-qm", "Initial"]);
    std::fs::write(temp.path().join("lines.txt"), "one\nthree\n").unwrap();
    let current = diff(path, "working", "lines.txt").unwrap().text;
    let deleted = current.split('\n').position(|line| line == "-two").unwrap();
    action(
        path,
        RepoAction::StageLines {
            path: "lines.txt".into(),
            lines: vec![deleted],
            diff: current,
        },
    )
    .unwrap();
    assert!(diff(path, "staged", "lines.txt")
        .unwrap()
        .text
        .contains("-two"));
    assert_eq!(diff(path, "working", "lines.txt").unwrap().text, "");
}

#[test]
fn unstages_and_discards_selected_lines() {
    let temp = tempfile::tempdir().unwrap();
    git(temp.path(), &["init", "-q"]);
    git(temp.path(), &["config", "user.name", "Test"]);
    git(temp.path(), &["config", "user.email", "test@example.com"]);
    let path = temp.path().to_str().unwrap();
    let file = temp.path().join("lines.txt");
    std::fs::write(&file, "one\ntwo\nthree\n").unwrap();
    git(temp.path(), &["add", "lines.txt"]);
    git(temp.path(), &["commit", "-qm", "Initial"]);
    std::fs::write(&file, "one\nTWO\nthree\n").unwrap();
    action(
        path,
        RepoAction::StageFile {
            path: "lines.txt".into(),
        },
    )
    .unwrap();

    let staged = diff(path, "staged", "lines.txt").unwrap().text;
    let selected = staged
        .split('\n')
        .enumerate()
        .filter_map(|(index, line)| ["-two", "+TWO"].contains(&line).then_some(index))
        .collect();
    action(
        path,
        RepoAction::UnstageLines {
            path: "lines.txt".into(),
            lines: selected,
            diff: staged,
        },
    )
    .unwrap();
    assert_eq!(diff(path, "staged", "lines.txt").unwrap().text, "");
    assert!(diff(path, "working", "lines.txt")
        .unwrap()
        .text
        .contains("+TWO"));

    let working = diff(path, "working", "lines.txt").unwrap().text;
    let selected = working
        .split('\n')
        .enumerate()
        .filter_map(|(index, line)| ["-two", "+TWO"].contains(&line).then_some(index))
        .collect();
    action(
        path,
        RepoAction::DiscardLines {
            path: "lines.txt".into(),
            lines: selected,
            diff: working,
        },
    )
    .unwrap();
    assert_eq!(diff(path, "working", "lines.txt").unwrap().text, "");
    assert_eq!(std::fs::read_to_string(file).unwrap(), "one\ntwo\nthree\n");

    std::fs::write(temp.path().join("lines.txt"), "one\nTWO\nthree\n").unwrap();
    action(
        path,
        RepoAction::StageFile {
            path: "lines.txt".into(),
        },
    )
    .unwrap();
    let staged = diff(path, "staged", "lines.txt").unwrap().text;
    let added = staged.split('\n').position(|line| line == "+TWO").unwrap();
    action(
        path,
        RepoAction::UnstageLines {
            path: "lines.txt".into(),
            lines: vec![added],
            diff: staged,
        },
    )
    .unwrap();
    let staged = diff(path, "staged", "lines.txt").unwrap().text;
    assert!(staged.contains("-two"));
    assert!(!staged.contains("+TWO"));
    let working = diff(path, "working", "lines.txt").unwrap().text;
    let added = working.split('\n').position(|line| line == "+TWO").unwrap();
    action(
        path,
        RepoAction::DiscardLines {
            path: "lines.txt".into(),
            lines: vec![added],
            diff: working,
        },
    )
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(temp.path().join("lines.txt")).unwrap(),
        "one\nthree\n"
    );
}

#[test]
fn reads_empty_repo_and_working_changes() {
    let temp = tempfile::tempdir().unwrap();
    git(temp.path(), &["init", "-q"]);
    let path = temp.path().to_str().unwrap();
    let empty = snapshot(path, 0, 20).unwrap();
    assert!(empty.commits.is_empty());
    assert!(empty.head.is_none());

    std::fs::write(temp.path().join("hello.txt"), "first\n").unwrap();
    let untracked = snapshot(path, 0, 20).unwrap();
    assert_eq!(untracked.status[0].path, "hello.txt");
    assert_eq!(untracked.status[0].index, "?");
    assert_eq!(
        diff(path, "untracked", "hello.txt").unwrap().text,
        "first\n"
    );

    git(temp.path(), &["add", "hello.txt"]);
    let staged = snapshot(path, 0, 20).unwrap();
    assert_eq!(staged.status[0].index, "A");
    assert!(diff(path, "staged", "hello.txt")
        .unwrap()
        .text
        .contains("+first"));
}

#[test]
fn reads_commits_and_paginates() {
    let temp = tempfile::tempdir().unwrap();
    git(temp.path(), &["init", "-q"]);
    let path = temp.path().to_str().unwrap();
    std::fs::write(temp.path().join("hello.txt"), "first\n").unwrap();
    git(temp.path(), &["add", "hello.txt"]);
    git(
        temp.path(),
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "-qm",
            "Initial commit",
        ],
    );
    std::fs::write(temp.path().join("hello.txt"), "second\n").unwrap();
    git(temp.path(), &["add", "hello.txt"]);
    git(
        temp.path(),
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "-qm",
            "Second commit",
        ],
    );

    let first = snapshot(path, 0, 1).unwrap();
    assert_eq!(first.commits[0].subject, "Second commit");
    assert!(first.has_more);
    let second = snapshot(path, 1, 1).unwrap();
    assert_eq!(second.commits[0].subject, "Initial commit");
    assert!(!second.has_more);
    let details = commit_details(path, &second.commits[0].hash).unwrap();
    assert_eq!(details.files[0].path, "hello.txt");
    assert_eq!(details.files[0].status, "A");
    assert_eq!(
        details.tree,
        git(
            temp.path(),
            &["rev-parse", &format!("{}^{{tree}}", second.commits[0].hash)]
        )
    );
    assert_eq!((details.additions, details.deletions), (Some(1), Some(0)));
    assert_eq!(
        (details.files[0].additions, details.files[0].deletions),
        (Some(1), Some(0))
    );
    let latest = commit_details(path, &first.commits[0].hash).unwrap();
    assert_eq!((latest.additions, latest.deletions), (Some(1), Some(1)));
    assert!(diff(path, &first.commits[0].hash, "hello.txt")
        .unwrap()
        .text
        .contains("+second"));
    assert_eq!(
        search(path, "Initial", 0, 20).unwrap().commits[0].subject,
        "Initial commit"
    );
    assert_eq!(search(path, "author:Test", 0, 20).unwrap().commits.len(), 2);
    assert_eq!(
        search(path, "path:hello.txt", 0, 20).unwrap().commits.len(),
        2
    );
}

#[test]
fn annotated_tag_opens_its_commit() {
    let temp = tempfile::tempdir().unwrap();
    git(temp.path(), &["init", "-q"]);
    git(temp.path(), &["config", "user.name", "Test"]);
    git(temp.path(), &["config", "user.email", "test@example.com"]);
    std::fs::write(temp.path().join("hello.txt"), "first\n").unwrap();
    git(temp.path(), &["add", "hello.txt"]);
    git(temp.path(), &["commit", "-qm", "Initial commit"]);
    git(temp.path(), &["tag", "-am", "Release", "v1"]);

    let path = temp.path().to_str().unwrap();
    let repo = snapshot(path, 0, 20).unwrap();
    let tag = repo.refs.iter().find(|entry| entry.name == "v1").unwrap();
    assert_eq!(tag.target, repo.head.unwrap());
    assert_eq!(
        commit_details(path, &tag.target).unwrap().subject,
        "Initial commit"
    );
}

#[test]
fn stages_commits_and_switches_branch() {
    let temp = tempfile::tempdir().unwrap();
    git(temp.path(), &["init", "-q"]);
    git(temp.path(), &["config", "user.name", "Test"]);
    git(temp.path(), &["config", "user.email", "test@example.com"]);
    let path = temp.path().to_str().unwrap();
    std::fs::write(temp.path().join("hello.txt"), "first\n").unwrap();
    action(
        path,
        RepoAction::StageFile {
            path: "hello.txt".into(),
        },
    )
    .unwrap();
    action(
        path,
        RepoAction::UnstageFile {
            path: "hello.txt".into(),
        },
    )
    .unwrap();
    assert_eq!(snapshot(path, 0, 20).unwrap().status[0].index, "?");
    action(
        path,
        RepoAction::StageFile {
            path: "hello.txt".into(),
        },
    )
    .unwrap();
    action(
        path,
        RepoAction::Commit {
            message: "Initial".into(),
            amend: false,
        },
    )
    .unwrap();
    assert_eq!(snapshot(path, 0, 20).unwrap().commits[0].subject, "Initial");
    std::fs::write(temp.path().join("hello.txt"), "stashed\n").unwrap();
    action(
        path,
        RepoAction::Stash {
            message: "Save work".into(),
        },
    )
    .unwrap();
    assert!(snapshot(path, 0, 20)
        .unwrap()
        .refs
        .iter()
        .any(|item| item.kind == "stash" && item.name.contains("Save work")));
    git(temp.path(), &["mv", "hello.txt", "new name ü.txt"]);
    let renamed = snapshot(path, 0, 20).unwrap();
    assert_eq!(renamed.status[0].path, "new name ü.txt");
    assert_eq!(
        renamed.status[0].original_path.as_deref(),
        Some("hello.txt")
    );
    action(
        path,
        RepoAction::CreateBranch {
            branch: "feature".into(),
        },
    )
    .unwrap();
    assert_eq!(snapshot(path, 0, 20).unwrap().branch, "feature");
    assert!(action(
        path,
        RepoAction::CreateBranch {
            branch: "-bad".into()
        }
    )
    .is_err());
}

#[test]
fn stages_one_hunk_without_staging_another() {
    let temp = tempfile::tempdir().unwrap();
    git(temp.path(), &["init", "-q"]);
    git(temp.path(), &["config", "user.name", "Test"]);
    git(temp.path(), &["config", "user.email", "test@example.com"]);
    let path = temp.path().to_str().unwrap();
    let file = temp.path().join("lines.txt");
    std::fs::write(
        &file,
        (1..=20)
            .map(|number| format!("line {number}\n"))
            .collect::<String>(),
    )
    .unwrap();
    git(temp.path(), &["add", "lines.txt"]);
    git(temp.path(), &["commit", "-qm", "Initial"]);
    let changed = (1..=20)
        .map(|number| {
            format!(
                "{}\n",
                if number == 1 {
                    "FIRST".to_string()
                } else if number == 20 {
                    "LAST".to_string()
                } else {
                    format!("line {number}")
                }
            )
        })
        .collect::<String>();
    std::fs::write(&file, changed).unwrap();
    action(
        path,
        RepoAction::StageHunk {
            path: "lines.txt".into(),
            index: 0,
            reverse: false,
        },
    )
    .unwrap();
    let staged = diff(path, "staged", "lines.txt").unwrap().text;
    assert!(staged.contains("+FIRST"));
    assert!(!staged.contains("+LAST"));
    assert!(diff(path, "working", "lines.txt")
        .unwrap()
        .text
        .contains("+LAST"));
    action(
        path,
        RepoAction::StageHunk {
            path: "lines.txt".into(),
            index: 0,
            reverse: true,
        },
    )
    .unwrap();
    assert!(diff(path, "staged", "lines.txt").unwrap().text.is_empty());
    let before_discard = diff(path, "working", "lines.txt").unwrap().text;
    action(
        path,
        RepoAction::DiscardHunk {
            path: "lines.txt".into(),
            index: 0,
            diff: before_discard.clone(),
        },
    )
    .unwrap();
    let working = diff(path, "working", "lines.txt").unwrap().text;
    assert!(!working.contains("+FIRST"));
    assert!(working.contains("+LAST"));
    assert!(action(
        path,
        RepoAction::DiscardHunk {
            path: "lines.txt".into(),
            index: 0,
            diff: before_discard,
        }
    )
    .unwrap_err()
    .contains("Diff changed"));
}

#[test]
fn later_hunk_actions_leave_earlier_hunks_untouched() {
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path();
    git(dir, &["init", "-q"]);
    git(dir, &["config", "user.name", "Test"]);
    git(dir, &["config", "user.email", "test@example.com"]);
    let path = dir.to_str().unwrap();
    let original = (1..=30).map(|n| format!("line {n}\n")).collect::<String>();
    let changed = original
        .replace("line 1\n", "FIRST\n")
        .replace("line 30\n", "LAST\n");
    let file = dir.join("lines.txt");
    std::fs::write(&file, &original).unwrap();
    git(dir, &["add", "."]);
    git(dir, &["commit", "-qm", "Base"]);
    std::fs::write(&file, &changed).unwrap();
    action(
        path,
        RepoAction::StageHunk {
            path: "lines.txt".into(),
            index: 1,
            reverse: false,
        },
    )
    .unwrap();
    let staged = diff(path, "staged", "lines.txt").unwrap().text;
    assert!(staged.contains("+LAST"));
    assert!(!staged.contains("+FIRST"));
    assert!(diff(path, "working", "lines.txt")
        .unwrap()
        .text
        .contains("+FIRST"));

    git(dir, &["add", "."]);
    action(
        path,
        RepoAction::StageHunk {
            path: "lines.txt".into(),
            index: 1,
            reverse: true,
        },
    )
    .unwrap();
    let staged = diff(path, "staged", "lines.txt").unwrap().text;
    assert!(staged.contains("+FIRST"));
    assert!(!staged.contains("+LAST"));
    assert!(diff(path, "working", "lines.txt")
        .unwrap()
        .text
        .contains("+LAST"));

    git(dir, &["reset", "-q"]);
    let current = diff(path, "working", "lines.txt").unwrap().text;
    action(
        path,
        RepoAction::DiscardHunk {
            path: "lines.txt".into(),
            index: 1,
            diff: current,
        },
    )
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(file).unwrap(),
        original.replace("line 1\n", "FIRST\n")
    );
    assert!(diff(path, "staged", "lines.txt").unwrap().text.is_empty());
}

#[test]
fn shows_files_changed_by_merge_commit() {
    let temp = tempfile::tempdir().unwrap();
    git(temp.path(), &["init", "-q"]);
    git(temp.path(), &["config", "user.name", "Test"]);
    git(temp.path(), &["config", "user.email", "test@example.com"]);
    std::fs::write(temp.path().join("base.txt"), "base\n").unwrap();
    git(temp.path(), &["add", "."]);
    git(temp.path(), &["commit", "-qm", "Base"]);
    let main_branch = git(temp.path(), &["branch", "--show-current"]);
    git(temp.path(), &["switch", "-qc", "feature"]);
    std::fs::write(temp.path().join("feature.txt"), "feature\n").unwrap();
    git(temp.path(), &["add", "."]);
    git(temp.path(), &["commit", "-qm", "Feature"]);
    git(temp.path(), &["switch", &main_branch]);
    std::fs::write(temp.path().join("main.txt"), "main\n").unwrap();
    git(temp.path(), &["add", "."]);
    git(temp.path(), &["commit", "-qm", "Main"]);
    git(
        temp.path(),
        &["merge", "--no-ff", "-qm", "Merge feature", "feature"],
    );
    let path = temp.path().to_str().unwrap();
    let merge = snapshot(path, 0, 20).unwrap().commits[0].hash.clone();
    let details = commit_details(path, &merge).unwrap();
    assert!(details.files.iter().any(|file| file.path == "feature.txt"));
}

#[test]
fn reads_binary_preview_and_detached_head() {
    let temp = tempfile::tempdir().unwrap();
    git(temp.path(), &["init", "-q"]);
    git(temp.path(), &["config", "user.name", "Test"]);
    git(temp.path(), &["config", "user.email", "test@example.com"]);
    let path = temp.path().to_str().unwrap();
    std::fs::write(temp.path().join("image.bin"), [0, 1, 2, 3]).unwrap();
    assert_eq!(
        diff(path, "untracked", "image.bin").unwrap().text,
        "Binary file"
    );
    git(temp.path(), &["add", "image.bin"]);
    git(temp.path(), &["commit", "-qm", "Binary"]);
    let head = snapshot(path, 0, 20).unwrap().head.unwrap();
    git(temp.path(), &["checkout", "--detach", &head]);
    let detached = snapshot(path, 0, 20).unwrap();
    assert_eq!(detached.branch, "Detached HEAD");
    assert_eq!(detached.head.as_deref(), Some(head.as_str()));
    assert_eq!(detached.commits[0].subject, "Binary");
}

#[test]
fn reports_branch_ahead_and_behind_counts() {
    let temp = tempfile::tempdir().unwrap();
    let local = temp.path().join("local");
    let bare = temp.path().join("bare.git");
    std::fs::create_dir(&local).unwrap();
    git(&local, &["init", "-q"]);
    git(&local, &["config", "user.name", "Test"]);
    git(&local, &["config", "user.email", "test@example.com"]);
    std::fs::write(local.join("hello.txt"), "first\n").unwrap();
    git(&local, &["add", "."]);
    git(&local, &["commit", "-qm", "Initial"]);
    git(
        temp.path(),
        &["init", "-q", "--bare", bare.to_str().unwrap()],
    );
    git(&local, &["remote", "add", "origin", bare.to_str().unwrap()]);
    let branch = git(&local, &["branch", "--show-current"]);
    git(&local, &["push", "-u", "origin", &branch]);
    std::fs::write(local.join("hello.txt"), "second\n").unwrap();
    git(&local, &["add", "."]);
    git(&local, &["commit", "-qm", "Ahead"]);
    let head_ref = || {
        snapshot(local.to_str().unwrap(), 0, 20)
            .unwrap()
            .refs
            .into_iter()
            .find(|item| item.is_head)
            .unwrap()
    };
    assert_eq!((head_ref().ahead, head_ref().behind), (1, 0));
    git(&local, &["push"]);
    git(&local, &["reset", "--hard", "HEAD~1"]);
    assert_eq!((head_ref().ahead, head_ref().behind), (0, 1));
}

#[test]
fn compares_branch_changes_since_it_left_the_base() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path();
    let path = repo.to_str().unwrap();
    git(repo, &["init", "-q"]);
    git(repo, &["config", "user.name", "Test"]);
    git(repo, &["config", "user.email", "test@example.com"]);
    std::fs::write(repo.join("shared.txt"), "base\n").unwrap();
    git(repo, &["add", "."]);
    git(repo, &["commit", "-qm", "Base"]);
    let base_branch = git(repo, &["branch", "--show-current"]);
    git(repo, &["switch", "-qc", "feature"]);
    std::fs::write(repo.join("feature.txt"), "one\ntwo\n").unwrap();
    git(repo, &["add", "."]);
    git(repo, &["commit", "-qm", "Feature one"]);
    std::fs::write(repo.join("shared.txt"), "base\nfeature\n").unwrap();
    git(repo, &["commit", "-qam", "Feature two"]);
    let feature = git(repo, &["rev-parse", "HEAD"]);
    git(repo, &["switch", "-q", &base_branch]);
    std::fs::write(repo.join("main-only.txt"), "main\n").unwrap();
    git(repo, &["add", "."]);
    git(repo, &["commit", "-qm", "Main moves on"]);
    let main = git(repo, &["rev-parse", "HEAD"]);

    let result = compare(path, &main, &feature).unwrap();
    assert_eq!(result.commits, 2);
    let mut paths: Vec<_> = result.files.iter().map(|file| file.path.as_str()).collect();
    paths.sort();
    assert_eq!(
        paths,
        ["feature.txt", "shared.txt"],
        "base-only changes must not appear"
    );
    assert_eq!((result.additions, result.deletions), (3, 0));
    let range = format!("{}..{}", result.merge_base, feature);
    assert!(diff(path, &range, "shared.txt")
        .unwrap()
        .text
        .contains("+feature"));
    assert!(
        compare(path, "main", &feature).is_err(),
        "refs must be resolved to commit IDs first"
    );
}

#[test]
fn pushes_new_branch_with_upstream_without_pushing_other_branches() {
    let temp = tempfile::tempdir().unwrap();
    let local = temp.path().join("local");
    let bare = temp.path().join("remote.git");
    std::fs::create_dir(&local).unwrap();
    git(&local, &["init", "-q", "-b", "main"]);
    git(&local, &["config", "user.name", "Test"]);
    git(&local, &["config", "user.email", "test@example.com"]);
    std::fs::write(local.join("hello.txt"), "initial\n").unwrap();
    git(&local, &["add", "."]);
    git(&local, &["commit", "-qm", "Initial"]);
    git(
        temp.path(),
        &["init", "-q", "--bare", bare.to_str().unwrap()],
    );
    git(&local, &["remote", "add", "origin", bare.to_str().unwrap()]);
    git(&local, &["push", "-u", "origin", "main"]);
    let original_main = git(&bare, &["rev-parse", "refs/heads/main"]);
    git(&local, &["config", "push.default", "matching"]);
    action(
        local.to_str().unwrap(),
        RepoAction::CreateBranch {
            branch: "topic".into(),
        },
    )
    .unwrap();
    std::fs::write(local.join("topic.txt"), "topic\n").unwrap();
    git(&local, &["add", "."]);
    git(&local, &["commit", "-qm", "Topic"]);
    action(local.to_str().unwrap(), RepoAction::Push).unwrap();
    assert_eq!(
        git(&bare, &["rev-parse", "refs/heads/topic"]),
        git(&local, &["rev-parse", "HEAD"])
    );
    assert_eq!(git(&bare, &["rev-parse", "refs/heads/main"]), original_main);
    assert_eq!(
        git(
            &local,
            &[
                "rev-parse",
                "--abbrev-ref",
                "--symbolic-full-name",
                "@{upstream}"
            ]
        ),
        "origin/topic"
    );
}

#[test]
fn checks_out_remote_branch_with_local_tracking_and_rejects_head_alias() {
    let temp = tempfile::tempdir().unwrap();
    let seed = temp.path().join("seed");
    let bare = temp.path().join("remote.git");
    let local = temp.path().join("local");
    std::fs::create_dir(&seed).unwrap();
    git(&seed, &["init", "-q", "-b", "main"]);
    git(&seed, &["config", "user.name", "Test"]);
    git(&seed, &["config", "user.email", "test@example.com"]);
    std::fs::write(seed.join("hello.txt"), "initial\n").unwrap();
    git(&seed, &["add", "."]);
    git(&seed, &["commit", "-qm", "Initial"]);
    git(
        temp.path(),
        &["init", "-q", "--bare", "-b", "main", bare.to_str().unwrap()],
    );
    git(&seed, &["remote", "add", "origin", bare.to_str().unwrap()]);
    git(&seed, &["push", "origin", "main"]);
    git(&seed, &["switch", "-q", "-c", "team/topic"]);
    std::fs::write(seed.join("topic.txt"), "topic\n").unwrap();
    git(&seed, &["add", "."]);
    git(&seed, &["commit", "-qm", "Topic"]);
    git(&seed, &["push", "origin", "team/topic"]);
    git(
        temp.path(),
        &[
            "clone",
            "-q",
            bare.to_str().unwrap(),
            local.to_str().unwrap(),
        ],
    );
    let path = local.to_str().unwrap();
    assert!(snapshot(path, 0, 10)
        .unwrap()
        .refs
        .iter()
        .any(|item| item.name == "origin/HEAD"));
    assert!(action(
        path,
        RepoAction::TrackRemoteBranch {
            remote: "origin".into(),
            branch: "HEAD".into()
        }
    )
    .is_err());
    assert!(action(
        path,
        RepoAction::TrackRemoteBranch {
            remote: "origin".into(),
            branch: "missing".into()
        }
    )
    .is_err());
    action(
        path,
        RepoAction::TrackRemoteBranch {
            remote: "origin".into(),
            branch: "team/topic".into(),
        },
    )
    .unwrap();
    assert_eq!(git(&local, &["branch", "--show-current"]), "team/topic");
    assert_eq!(
        git(
            &local,
            &[
                "rev-parse",
                "--abbrev-ref",
                "--symbolic-full-name",
                "@{upstream}"
            ]
        ),
        "origin/team/topic"
    );
    assert_eq!(
        git(&local, &["rev-parse", "HEAD"]),
        git(&bare, &["rev-parse", "refs/heads/team/topic"])
    );
    assert!(snapshot(path, 0, 10)
        .unwrap()
        .refs
        .iter()
        .any(|item| item.name == "team/topic" && item.is_head));
}

#[test]
fn manages_local_and_remote_branches_and_tags() {
    let temp = tempfile::tempdir().unwrap();
    let local = temp.path().join("local");
    let bare = temp.path().join("remote.git");
    std::fs::create_dir(&local).unwrap();
    git(&local, &["init", "-q", "-b", "main"]);
    git(&local, &["config", "user.name", "Test"]);
    git(&local, &["config", "user.email", "test@example.com"]);
    std::fs::write(local.join("hello.txt"), "initial\n").unwrap();
    git(&local, &["add", "hello.txt"]);
    git(&local, &["commit", "-qm", "Initial"]);
    git(
        temp.path(),
        &["init", "-q", "--bare", bare.to_str().unwrap()],
    );
    git(&local, &["remote", "add", "origin", bare.to_str().unwrap()]);
    let path = local.to_str().unwrap();
    assert_eq!(snapshot(path, 0, 10).unwrap().remotes, vec!["origin"]);

    git(&local, &["branch", "topic"]);
    action(
        path,
        RepoAction::RenameBranch {
            branch: "topic".into(),
            new_name: "renamed".into(),
        },
    )
    .unwrap();
    assert_eq!(git(&local, &["branch", "--list", "renamed"]), "renamed");
    assert!(action(
        path,
        RepoAction::RenameBranch {
            branch: "renamed".into(),
            new_name: "main".into()
        }
    )
    .is_err());
    assert!(action(
        path,
        RepoAction::PushBranch {
            remote: "unknown".into(),
            branch: "renamed".into()
        }
    )
    .is_err());
    assert!(action(
        path,
        RepoAction::DeleteRemoteBranch {
            remote: "origin".into(),
            branch: "-bad".into()
        }
    )
    .is_err());
    action(
        path,
        RepoAction::PushBranch {
            remote: "origin".into(),
            branch: "renamed".into(),
        },
    )
    .unwrap();
    assert_eq!(
        git(&bare, &["rev-parse", "refs/heads/renamed"]),
        git(&local, &["rev-parse", "HEAD"])
    );
    assert!(git(&bare, &["branch", "--list", "main"]).is_empty());
    action(
        path,
        RepoAction::DeleteRemoteBranch {
            remote: "origin".into(),
            branch: "renamed".into(),
        },
    )
    .unwrap();
    assert!(git(&bare, &["branch", "--list", "renamed"]).is_empty());
    assert_eq!(git(&local, &["branch", "--list", "renamed"]), "renamed");

    git(&local, &["switch", "-q", "-c", "unmerged"]);
    std::fs::write(local.join("other.txt"), "different\n").unwrap();
    git(&local, &["add", "other.txt"]);
    git(&local, &["commit", "-qm", "Unmerged"]);
    git(&local, &["switch", "-q", "main"]);
    assert!(action(
        path,
        RepoAction::DeleteBranch {
            branch: "unmerged".into()
        }
    )
    .is_err());
    action(
        path,
        RepoAction::ForceDeleteBranch {
            branch: "unmerged".into(),
        },
    )
    .unwrap();
    assert!(git(&local, &["branch", "--list", "unmerged"]).is_empty());
    action(
        path,
        RepoAction::RenameBranch {
            branch: "main".into(),
            new_name: "main-renamed".into(),
        },
    )
    .unwrap();
    assert_eq!(git(&local, &["branch", "--show-current"]), "main-renamed");

    git(&local, &["tag", "v-test"]);
    assert!(action(
        path,
        RepoAction::DeleteRemoteTag {
            remote: "origin".into(),
            name: "-bad".into()
        }
    )
    .is_err());
    action(
        path,
        RepoAction::PushTag {
            remote: "origin".into(),
            name: "v-test".into(),
        },
    )
    .unwrap();
    assert_eq!(
        git(&bare, &["rev-parse", "refs/tags/v-test"]),
        git(&local, &["rev-parse", "HEAD"])
    );
    action(
        path,
        RepoAction::DeleteRemoteTag {
            remote: "origin".into(),
            name: "v-test".into(),
        },
    )
    .unwrap();
    assert!(git(&bare, &["tag", "--list", "v-test"]).is_empty());
    assert_eq!(git(&local, &["tag", "--list", "v-test"]), "v-test");
}

#[test]
fn resolves_merge_conflict_and_continues() {
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path();
    git(dir, &["init", "-q", "-b", "main"]);
    git(dir, &["config", "user.name", "Test"]);
    git(dir, &["config", "user.email", "test@example.com"]);
    std::fs::write(dir.join("shared.txt"), "base\n").unwrap();
    git(dir, &["add", "."]);
    git(dir, &["commit", "-qm", "Base"]);
    git(dir, &["switch", "-c", "topic"]);
    std::fs::write(dir.join("shared.txt"), "topic\n").unwrap();
    git(dir, &["commit", "-qam", "Topic"]);
    git(dir, &["switch", "main"]);
    std::fs::write(dir.join("shared.txt"), "main\n").unwrap();
    git(dir, &["commit", "-qam", "Main"]);
    assert!(action(
        dir.to_str().unwrap(),
        RepoAction::Merge {
            branch: "topic".into()
        }
    )
    .is_err());
    assert_eq!(
        snapshot(dir.to_str().unwrap(), 0, 10)
            .unwrap()
            .operation
            .as_deref(),
        Some("merge")
    );
    action(
        dir.to_str().unwrap(),
        RepoAction::ResolveFile {
            path: "shared.txt".into(),
            side: "theirs".into(),
        },
    )
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(dir.join("shared.txt")).unwrap(),
        "topic\n"
    );
    action(dir.to_str().unwrap(), RepoAction::ContinueOperation).unwrap();
    let result = snapshot(dir.to_str().unwrap(), 0, 10).unwrap();
    assert_eq!(result.operation, None);
    assert_eq!(result.commits[0].parents.len(), 2);
}

#[test]
fn aborts_conflicted_rebase_and_supports_history_actions() {
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path();
    git(dir, &["init", "-q", "-b", "main"]);
    git(dir, &["config", "user.name", "Test"]);
    git(dir, &["config", "user.email", "test@example.com"]);
    std::fs::write(dir.join("shared.txt"), "base\n").unwrap();
    git(dir, &["add", "."]);
    git(dir, &["commit", "-qm", "Base"]);
    let base = git(dir, &["rev-parse", "HEAD"]);
    git(dir, &["switch", "-c", "topic"]);
    std::fs::write(dir.join("shared.txt"), "topic\n").unwrap();
    git(dir, &["commit", "-qam", "Topic"]);
    let topic = git(dir, &["rev-parse", "HEAD"]);
    git(dir, &["switch", "main"]);
    std::fs::write(dir.join("shared.txt"), "main\n").unwrap();
    git(dir, &["commit", "-qam", "Main"]);
    git(dir, &["switch", "topic"]);
    assert!(action(
        dir.to_str().unwrap(),
        RepoAction::Rebase {
            branch: "main".into()
        }
    )
    .is_err());
    assert_eq!(
        snapshot(dir.to_str().unwrap(), 0, 10)
            .unwrap()
            .operation
            .as_deref(),
        Some("rebase")
    );
    action(dir.to_str().unwrap(), RepoAction::AbortOperation).unwrap();
    assert_eq!(
        snapshot(dir.to_str().unwrap(), 0, 10).unwrap().operation,
        None
    );
    assert_eq!(git(dir, &["rev-parse", "HEAD"]), topic);
    action(
        dir.to_str().unwrap(),
        RepoAction::CreateTag {
            name: "v-test".into(),
            hash: topic.clone(),
        },
    )
    .unwrap();
    assert_eq!(git(dir, &["rev-parse", "refs/tags/v-test"]), topic);
    action(
        dir.to_str().unwrap(),
        RepoAction::DeleteTag {
            name: "v-test".into(),
        },
    )
    .unwrap();
    assert!(git(dir, &["tag", "--list", "v-test"]).is_empty());
    action(
        dir.to_str().unwrap(),
        RepoAction::Reset {
            hash: base.clone(),
            mode: "hard".into(),
        },
    )
    .unwrap();
    assert_eq!(git(dir, &["rev-parse", "HEAD"]), base);
    assert_eq!(
        std::fs::read_to_string(dir.join("shared.txt")).unwrap(),
        "base\n"
    );
    action(dir.to_str().unwrap(), RepoAction::Detach { hash: topic }).unwrap();
    assert_eq!(
        snapshot(dir.to_str().unwrap(), 0, 10).unwrap().branch,
        "Detached HEAD"
    );
}

#[test]
fn cancels_a_running_fetch() {
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path();
    git(dir, &["init", "-q", "-b", "main"]);
    git(dir, &["config", "user.name", "Test"]);
    git(dir, &["config", "user.email", "test@example.com"]);
    std::fs::write(dir.join("file.txt"), "initial\n").unwrap();
    git(dir, &["add", "."]);
    git(dir, &["commit", "-qm", "Initial"]);
    git(
        dir,
        &["remote", "add", "origin", "ssh://example.invalid/repo"],
    );
    #[cfg(windows)]
    let command = {
        let script = dir.join("sleep.ps1");
        std::fs::write(&script, "Start-Sleep -Seconds 30\n").unwrap();
        format!(
            "powershell -NoProfile -ExecutionPolicy Bypass -File {}",
            script.to_string_lossy().replace('\\', "/")
        )
    };
    #[cfg(unix)]
    let command = {
        use std::os::unix::fs::PermissionsExt;
        let script = dir.join("sleep.sh");
        std::fs::write(&script, "#!/bin/sh\nsleep 30\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        script.to_string_lossy().into_owned()
    };
    git(dir, &["config", "core.sshCommand", &command]);
    let suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos()
        & 0xffffffffffff;
    let token = format!("00000000-0000-4000-8000-{suffix:012x}");
    let active = std::env::temp_dir()
        .join("gitferry-ops")
        .join(format!("{token}.active"));
    let repo = dir.to_str().unwrap().to_string();
    let token_for_thread = token.clone();
    let handle = std::thread::spawn(move || {
        action_with_progress(&repo, RepoAction::Fetch, Some(&token_for_thread), |_| {})
    });
    let start = std::time::Instant::now();
    while !active.is_file() && start.elapsed() < std::time::Duration::from_secs(5) {
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert!(
        active.is_file(),
        "fetch must expose an active operation marker"
    );
    cancel_operation(&token).unwrap();
    let result = handle.join().unwrap();
    assert!(result.unwrap_err().contains("cancelled"));
    assert!(
        start.elapsed() < std::time::Duration::from_secs(10),
        "cancellation should stop the transfer promptly"
    );
    assert!(!active.exists(), "operation marker must be cleaned up");
}

#[test]
fn watcher_notices_nested_worktree_changes() {
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path();
    git(dir, &["init", "-q", "-b", "main"]);
    git(dir, &["config", "user.name", "Test"]);
    git(dir, &["config", "user.email", "test@example.com"]);
    std::fs::create_dir(dir.join("nested")).unwrap();
    std::fs::write(dir.join("nested").join("file.txt"), "before\n").unwrap();
    git(dir, &["add", "."]);
    git(dir, &["commit", "-qm", "Initial"]);
    let file = dir.join("nested").join("file.txt");
    let edit = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(500));
        std::fs::write(file, "after\n").unwrap();
    });
    assert!(watch(dir.to_str().unwrap(), 5_000).unwrap());
    edit.join().unwrap();
}

#[test]
fn watcher_reports_changes_made_between_calls_once() {
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path();
    git(dir, &["init", "-q", "-b", "main"]);
    std::fs::write(dir.join("file.txt"), "before\n").unwrap();
    let path = dir.to_str().unwrap();
    // The first call starts the watcher; nothing has changed yet.
    assert!(!watch(path, 1_000).unwrap());
    // A change while nobody waits (the app is refreshing) is still reported by the next call, right away.
    std::fs::write(dir.join("file.txt"), "after\n").unwrap();
    std::thread::sleep(std::time::Duration::from_millis(300));
    let start = std::time::Instant::now();
    assert!(watch(path, 5_000).unwrap());
    assert!(start.elapsed() < std::time::Duration::from_secs(2));
    // The change was handed out once; the following call waits for a new one.
    assert!(!watch(path, 1_000).unwrap());
}

#[test]
fn watcher_ignores_git_objects_and_lock_files() {
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path();
    git(dir, &["init", "-q", "-b", "main"]);
    let path = dir.to_str().unwrap();
    assert!(!watch(path, 1_000).unwrap());
    std::fs::write(dir.join(".git").join("objects").join("probe"), "x").unwrap();
    std::fs::write(dir.join(".git").join("index.lock"), "x").unwrap();
    std::fs::remove_file(dir.join(".git").join("index.lock")).unwrap();
    std::fs::create_dir(dir.join("node_modules")).unwrap();
    std::fs::write(dir.join("node_modules").join("probe"), "x").unwrap();
    assert!(!watch(path, 1_000).unwrap());
}

#[test]
fn interactive_rebase_plan_is_ordered_and_rejects_stale_steps() {
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path();
    git(dir, &["init", "-q", "-b", "main"]);
    git(dir, &["config", "user.name", "Test"]);
    git(dir, &["config", "user.email", "test@example.com"]);
    std::fs::write(dir.join("base.txt"), "base\n").unwrap();
    git(dir, &["add", "."]);
    git(dir, &["commit", "-qm", "Base"]);
    git(dir, &["switch", "-c", "topic"]);
    for (file, subject) in [("a.txt", "Add A"), ("b.txt", "Add B")] {
        std::fs::write(dir.join(file), subject).unwrap();
        git(dir, &["add", "."]);
        git(dir, &["commit", "-qm", subject]);
    }
    let path = dir.to_str().unwrap();
    let plan = rebase_plan(path, "main").unwrap();
    assert_eq!(
        plan.iter()
            .map(|item| item.subject.as_str())
            .collect::<Vec<_>>(),
        vec!["Add A", "Add B"]
    );
    let before = git(dir, &["rev-parse", "HEAD"]);
    let stale = vec![RebaseStep {
        hash: plan[0].hash.clone(),
        action: "pick".into(),
        message: None,
    }];
    assert!(action(
        path,
        RepoAction::InteractiveRebase {
            branch: "topic".into(),
            onto: "main".into(),
            steps: stale
        }
    )
    .unwrap_err()
    .contains("plan changed"));
    assert_eq!(git(dir, &["rev-parse", "HEAD"]), before);
}

#[test]
fn interactive_rebase_rewords_squashes_and_pauses_for_edit() {
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path();
    git(dir, &["init", "-q", "-b", "main"]);
    git(dir, &["config", "user.name", "Test"]);
    git(dir, &["config", "user.email", "test@example.com"]);
    std::fs::write(dir.join("base.txt"), "base\n").unwrap();
    git(dir, &["add", "."]);
    git(dir, &["commit", "-qm", "Base"]);
    git(dir, &["switch", "-c", "topic"]);
    for (file, subject) in [("a.txt", "Add A"), ("b.txt", "Add B"), ("c.txt", "Add C")] {
        std::fs::write(dir.join(file), format!("{subject}\n")).unwrap();
        git(dir, &["add", "."]);
        git(dir, &["commit", "-qm", subject]);
    }
    let path = dir.to_str().unwrap();
    let plan = rebase_plan(path, "main").unwrap();
    assert_eq!(plan[0].message, "Add A");
    let steps = [
        RebaseStep {
            hash: plan[0].hash.clone(),
            action: "reword".into(),
            message: Some("Renamed A\n\nA longer explanation".into()),
        },
        RebaseStep {
            hash: plan[1].hash.clone(),
            action: "squash".into(),
            message: None,
        },
        RebaseStep {
            hash: plan[2].hash.clone(),
            action: "edit".into(),
            message: None,
        },
    ];
    let mut child = Command::new(env!("CARGO_BIN_EXE_gitferry-agent"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let request = RpcRequest {
        id: 1,
        request: Request::Action {
            path: path.into(),
            action: RepoAction::InteractiveRebase {
                branch: "topic".into(),
                onto: "main".into(),
                steps: steps.to_vec(),
            },
            cancel_token: None,
        },
    };
    let input = child.stdin.as_mut().unwrap();
    serde_json::to_writer(&mut *input, &request).unwrap();
    writeln!(input).unwrap();
    drop(child.stdin.take());
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let response: RpcResponse = serde_json::from_slice(&output.stdout).unwrap();
    assert!(
        matches!(&response.response, Response::Action(_)),
        "{response:?}"
    );
    let paused = snapshot(path, 0, 20).unwrap();
    assert_eq!(paused.operation.as_deref(), Some("rebase"));
    assert!(paused.rebase_edit_pause);
    assert_eq!(git(dir, &["log", "-1", "--format=%s"]), "Add C");
    let combined = git(dir, &["log", "-1", "--format=%B", "HEAD^"]);
    assert!(
        combined.contains("Renamed A") && combined.contains("Add B"),
        "{combined}"
    );
    assert!(combined.contains("A longer explanation"));
    std::fs::write(dir.join("c.txt"), "Edited C\n").unwrap();
    git(dir, &["add", "c.txt"]);
    action(path, RepoAction::AmendNoEdit).unwrap();
    action(path, RepoAction::ContinueOperation).unwrap();
    let finished = snapshot(path, 0, 20).unwrap();
    assert_eq!(finished.operation, None);
    assert!(!finished.rebase_edit_pause);
    assert_eq!(git(dir, &["log", "-1", "--format=%s"]), "Add C");
    assert_eq!(
        std::fs::read_to_string(dir.join("c.txt")).unwrap(),
        "Edited C\n"
    );
}

#[test]
fn file_history_follows_renames_and_blame_pages_lines() {
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path();
    git(dir, &["init", "-q", "-b", "main"]);
    git(dir, &["config", "user.name", "Test"]);
    git(dir, &["config", "user.email", "test@example.com"]);
    std::fs::write(dir.join("original.txt"), "alpha\nbeta\n").unwrap();
    git(dir, &["add", "."]);
    git(dir, &["commit", "-qm", "Add original"]);
    std::fs::write(dir.join("original.txt"), "alpha\nbravo\n").unwrap();
    git(dir, &["commit", "-qam", "Change second line"]);
    git(dir, &["mv", "original.txt", "renamed.txt"]);
    git(dir, &["commit", "-qm", "Rename file"]);

    let path = dir.to_str().unwrap();
    let first = file_history(path, "renamed.txt", "HEAD", 0, 2).unwrap();
    assert_eq!(first.commits.len(), 2);
    assert!(first.has_more);
    assert_eq!(first.commits[0].subject, "Rename file");
    assert_eq!(first.commits[0].path, "renamed.txt");
    assert_eq!(first.commits[1].subject, "Change second line");
    assert_eq!(first.commits[1].path, "original.txt");
    let older = file_history(path, "renamed.txt", "HEAD", 2, 2).unwrap();
    assert_eq!(older.commits[0].subject, "Add original");
    assert!(!older.has_more);

    let first_line = blame(path, "renamed.txt", "HEAD", 1, 1).unwrap();
    assert_eq!(first_line.lines[0].content, "alpha");
    assert!(first_line.has_more);
    let second_line = blame(path, "renamed.txt", "HEAD", 2, 1).unwrap();
    assert_eq!(second_line.lines[0].line, 2);
    assert_eq!(second_line.lines[0].content, "bravo");
    assert_eq!(second_line.lines[0].summary, "Change second line");
    assert!(!second_line.has_more);
    assert_eq!(
        tracked_files(path, "RENAMED", 10).unwrap(),
        vec!["renamed.txt".to_string()]
    );
    assert!(tracked_files(path, "original", 10).unwrap().is_empty());
    assert!(file_history(path, "../outside", "HEAD", 0, 10).is_err());
    assert!(blame(path, "renamed.txt", "HEAD~1", 1, 10).is_err());
}

#[test]
fn full_context_diff_includes_the_whole_file() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path();
    let path = repo.to_str().unwrap();
    git(repo, &["init", "-q"]);
    git(repo, &["config", "user.name", "Test"]);
    git(repo, &["config", "user.email", "test@example.com"]);
    let lines: Vec<String> = (1..=20).map(|line| format!("line {line}")).collect();
    std::fs::write(repo.join("long.txt"), lines.join("\n") + "\n").unwrap();
    git(repo, &["add", "."]);
    git(repo, &["commit", "-qm", "Long file"]);
    std::fs::write(
        repo.join("long.txt"),
        lines.join("\n").replace("line 10", "line ten") + "\n",
    )
    .unwrap();
    let hunks = diff(path, "working", "long.txt").unwrap().text;
    assert!(
        !hunks.contains(" line 1\n"),
        "default diff keeps three context lines"
    );
    let whole = diff_with_context(path, "working", "long.txt", false, true)
        .unwrap()
        .text;
    assert!(whole.contains(" line 1\n") && whole.contains(" line 20\n"));
    assert!(whole.contains("+line ten"));
}

#[test]
fn file_list_actions_stage_unstage_discard_and_delete_untracked_only() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path();
    let path = repo.to_str().unwrap();
    git(repo, &["init", "-q"]);
    git(repo, &["config", "user.name", "Test"]);
    git(repo, &["config", "user.email", "test@example.com"]);
    std::fs::write(repo.join("a.txt"), "a\n").unwrap();
    std::fs::write(repo.join("b.txt"), "b\n").unwrap();
    git(repo, &["add", "."]);
    git(repo, &["commit", "-qm", "Base"]);
    std::fs::write(repo.join("a.txt"), "a changed\n").unwrap();
    std::fs::write(repo.join("b.txt"), "b changed\n").unwrap();
    std::fs::create_dir(repo.join("new")).unwrap();
    std::fs::write(repo.join("new/one.txt"), "1\n").unwrap();
    std::fs::write(repo.join("new/two.txt"), "2\n").unwrap();
    let files = |names: &[&str]| {
        names
            .iter()
            .map(|name| name.to_string())
            .collect::<Vec<_>>()
    };

    action(
        path,
        RepoAction::StageFiles {
            paths: files(&["a.txt", "b.txt"]),
        },
    )
    .unwrap();
    assert_eq!(
        git(repo, &["diff", "--cached", "--name-only"]),
        "a.txt\nb.txt"
    );
    action(
        path,
        RepoAction::UnstageFiles {
            paths: files(&["b.txt"]),
        },
    )
    .unwrap();
    assert_eq!(git(repo, &["diff", "--cached", "--name-only"]), "a.txt");
    action(
        path,
        RepoAction::DiscardFiles {
            paths: files(&["b.txt"]),
        },
    )
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(repo.join("b.txt"))
            .unwrap()
            .trim_end(),
        "b"
    );

    assert!(
        action(
            path,
            RepoAction::DeleteUntracked {
                paths: files(&["a.txt"])
            }
        )
        .is_err(),
        "tracked files must never be deleted"
    );
    assert!(repo.join("a.txt").exists());
    action(
        path,
        RepoAction::DeleteUntracked {
            paths: files(&["new/one.txt", "new/two.txt"]),
        },
    )
    .unwrap();
    assert!(!repo.join("new/one.txt").exists() && !repo.join("new/two.txt").exists());
}
