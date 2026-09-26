use gitferry_agent::{action, commit_details, diff, search, snapshot};
use gitferry_proto::RepoAction;
use std::path::Path;
use std::process::Command;

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
