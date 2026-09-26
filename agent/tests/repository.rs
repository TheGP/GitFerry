use gitferry_agent::{
    action, action_with_progress, cancel_operation, commit_details, diff, rebase_plan, search,
    snapshot, watch,
};
use gitferry_proto::{RebaseStep, RepoAction};
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
