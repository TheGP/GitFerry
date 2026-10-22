use gitferry_agent::{action, snapshot_with, watch, ReadBackend};
use gitferry_proto::{RepoAction, Request, Response, RpcRequest, RpcResponse};
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

fn git(dir: &Path, args: &[&str]) {
    let output = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
}

#[test]
fn snapshots_identify_linked_worktrees_and_keep_same_name_clones_separate() {
    let temp = tempfile::tempdir().unwrap();
    let primary = temp.path().join("app");
    let linked = temp.path().join("linked with spaces é");
    let clone = temp.path().join("elsewhere").join("app");
    git(temp.path(), &["init", "-q", "-b", "main", primary.to_str().unwrap()]);
    git(&primary, &["config", "user.name", "Test"]);
    git(&primary, &["config", "user.email", "test@example.com"]);
    std::fs::write(primary.join("file.txt"), "base\n").unwrap();
    git(&primary, &["add", "file.txt"]);
    git(&primary, &["commit", "-qm", "Base"]);
    git(&primary, &["worktree", "add", "-qb", "topic", linked.to_str().unwrap()]);
    std::fs::create_dir_all(clone.parent().unwrap()).unwrap();
    git(temp.path(), &["clone", "-q", primary.to_str().unwrap(), clone.to_str().unwrap()]);
    std::fs::write(linked.join("file.txt"), "working\n").unwrap();
    for backend in [ReadBackend::Git, ReadBackend::Gix] {
        let main = snapshot_with(primary.to_str().unwrap(), 0, 10, backend).unwrap();
        let topic = snapshot_with(linked.to_str().unwrap(), 0, 10, backend).unwrap();
        let independent = snapshot_with(clone.to_str().unwrap(), 0, 10, backend).unwrap();
        assert_eq!(main.common_git_dir, topic.common_git_dir);
        assert_ne!(main.common_git_dir, independent.common_git_dir);
        assert_eq!(topic.repository_name, "app");
        assert_eq!(topic.name, "linked with spaces é");
        assert_eq!(topic.branch, "topic");
        assert_eq!(topic.worktrees.len(), 2);
        assert!(topic.worktrees.iter().any(|entry| entry.path == topic.path && entry.branch == "topic"));
        assert_eq!(topic.status.len(), 1);
        assert!(main.status.is_empty());
    }
}

#[test]
fn detached_and_prunable_worktrees_keep_their_identity() {
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path().join("main");
    let detached = temp.path().join("detached");
    let gone = temp.path().join("gone");
    git(temp.path(), &["init", "-q", "-b", "main", dir.to_str().unwrap()]);
    git(&dir, &["config", "user.name", "Test"]);
    git(&dir, &["config", "user.email", "test@example.com"]);
    git(&dir, &["commit", "-qm", "Base", "--allow-empty"]);
    git(&dir, &["worktree", "add", "-q", "--detach", detached.to_str().unwrap()]);
    git(&dir, &["worktree", "add", "-qb", "gone", gone.to_str().unwrap()]);
    std::fs::remove_dir_all(&gone).unwrap();
    let snap = snapshot_with(dir.to_str().unwrap(), 0, 10, ReadBackend::Git).unwrap();
    assert!(snap.worktrees.iter().any(|entry| entry.branch == "Detached HEAD" && entry.head.is_some()));
    assert!(snap.worktrees.iter().any(|entry| entry.prunable && entry.branch == "gone"));
}

#[test]
fn worktree_merge_badges_use_ancestry_and_prefer_fetched_base() {
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path().join("app");
    let topic = temp.path().join("topic");
    let pending = temp.path().join("pending");
    let detached = temp.path().join("detached");
    git(temp.path(), &["init", "-q", "-b", "main", dir.to_str().unwrap()]);
    git(&dir, &["config", "user.name", "Test"]);
    git(&dir, &["config", "user.email", "test@example.com"]);
    git(&dir, &["commit", "-qm", "Base", "--allow-empty"]);
    git(&dir, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(&dir, &["worktree", "add", "-qb", "topic", topic.to_str().unwrap()]);
    git(&dir, &["worktree", "add", "-qb", "pending", pending.to_str().unwrap()]);
    git(&topic, &["commit", "-qm", "Topic", "--allow-empty"]);
    git(&pending, &["commit", "-qm", "Not merged", "--allow-empty"]);
    git(&dir, &["merge", "--ff-only", "topic"]);
    git(&dir, &["worktree", "add", "-q", "--detach", detached.to_str().unwrap()]);
    git(&dir, &["commit", "-qm", "Main moved ahead", "--allow-empty"]);
    for backend in [ReadBackend::Git, ReadBackend::Gix] {
        let snap = snapshot_with(dir.to_str().unwrap(), 0, 1, backend).unwrap();
        // Local main contains topic, but the fetched remote main does not yet.
        assert!(snap.worktrees.iter().all(|tree| tree.merged_into.is_none()));
    }
    git(&dir, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
    std::fs::write(topic.join("uncommitted.txt"), "Not part of the merged commits\n").unwrap();
    for backend in [ReadBackend::Git, ReadBackend::Gix] {
        let snap = snapshot_with(dir.to_str().unwrap(), 0, 1, backend).unwrap();
        assert_eq!(snap.worktrees.iter().find(|tree| tree.branch == "topic").unwrap().merged_into.as_deref(), Some("origin/main"));
        assert_eq!(snap.worktrees.iter().find(|tree| tree.branch == "Detached HEAD").unwrap().merged_into.as_deref(), Some("origin/main"));
        assert!(snap.worktrees.iter().filter(|tree| tree.branch == "main" || tree.branch == "pending").all(|tree| tree.merged_into.is_none()));
    }
    git(&topic, &["add", "uncommitted.txt"]);
    for backend in [ReadBackend::Git, ReadBackend::Gix] {
        let snap = snapshot_with(dir.to_str().unwrap(), 0, 1, backend).unwrap();
        assert!(snap.worktrees.iter().find(|tree| tree.branch == "topic").unwrap().merged_into.is_none(), "An unopened worktree's staged changes hide its merged badge");
        assert!(snap.worktrees.iter().find(|tree| tree.branch == "Detached HEAD").unwrap().merged_into.is_some(), "Equal HEADs must not share index status");
    }
    git(&topic, &["reset", "--mixed", "HEAD"]);
    for backend in [ReadBackend::Git, ReadBackend::Gix] {
        let snap = snapshot_with(dir.to_str().unwrap(), 0, 1, backend).unwrap();
        assert_eq!(snap.worktrees.iter().find(|tree| tree.branch == "topic").unwrap().merged_into.as_deref(), Some("origin/main"), "Unstaging restores the badge");
    }
    std::fs::write(detached.join("staged.txt"), "Detached staged change\n").unwrap();
    git(&detached, &["add", "staged.txt"]);
    assert!(snapshot_with(dir.to_str().unwrap(), 0, 1, ReadBackend::Git).unwrap().worktrees.iter()
        .find(|tree| tree.branch == "Detached HEAD").unwrap().merged_into.is_none());
    git(&detached, &["reset", "--mixed", "HEAD"]);
    git(&topic, &["commit", "-qm", "More work", "--allow-empty"]);
    let snap = snapshot_with(dir.to_str().unwrap(), 0, 1, ReadBackend::Git).unwrap();
    assert!(snap.worktrees.iter().find(|tree| tree.branch == "topic").unwrap().merged_into.is_none());
    // Without remote refs, a local main line is the fallback.
    git(&dir, &["update-ref", "-d", "refs/remotes/origin/main"]);
    let snap = snapshot_with(dir.to_str().unwrap(), 0, 1, ReadBackend::Git).unwrap();
    assert_eq!(snap.worktrees.iter().find(|tree| tree.branch == "Detached HEAD").unwrap().merged_into.as_deref(), Some("main"));
}

#[test]
fn rpc_snapshots_resolve_metadata_from_the_repository_not_the_app_directory() {
    let temp = tempfile::tempdir().unwrap();
    let primary = temp.path().join("repo with spaces é");
    let linked = temp.path().join("linked checkout é");
    git(temp.path(), &["init", "-q", "-b", "main", primary.to_str().unwrap()]);
    git(&primary, &["config", "user.name", "Test"]);
    git(&primary, &["config", "user.email", "test@example.com"]);
    git(&primary, &["commit", "-qm", "Base", "--allow-empty"]);
    git(&primary, &["worktree", "add", "-qb", "topic", linked.to_str().unwrap()]);
    // Set this test-only variable to exercise a real older Git without changing the system Git.
    let git_dir = std::env::var_os("GITFERRY_TEST_GIT_BIN_DIR");
    for backend in ["git", "gix"] {
        let mut command = Command::new(env!("CARGO_BIN_EXE_gitferry-agent"));
        command.current_dir(temp.path()).env("GITFERRY_READS", backend)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        if let Some(dir) = &git_dir {
            let inherited = std::env::var_os("PATH").unwrap_or_default();
            let paths = std::iter::once(std::path::PathBuf::from(dir))
                .chain(std::env::split_paths(&inherited));
            command.env("PATH", std::env::join_paths(paths).unwrap());
        }
        let mut child = command.spawn().unwrap();
        let mut input = child.stdin.take().unwrap();
        for (id, path) in [(1, &primary), (2, &linked)] {
            serde_json::to_writer(&mut input, &RpcRequest { id, request: Request::Snapshot {
                path: path.to_str().unwrap().to_string(), offset: 0, limit: 1,
            }}).unwrap();
            writeln!(input).unwrap();
        }
        drop(input);
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        let snapshots: Vec<_> = String::from_utf8(output.stdout).unwrap().lines().map(|line| {
            let response: RpcResponse = serde_json::from_str(line).unwrap();
            match response.response {
                Response::Snapshot(snapshot) => snapshot,
                other => panic!("Snapshot failed using {backend}: {other:?}"),
            }
        }).collect();
        assert_eq!(snapshots.len(), 2);
        assert_eq!(snapshots[0].common_git_dir, snapshots[1].common_git_dir);
        assert_eq!(snapshots[1].worktrees.len(), 2);
        assert_eq!(snapshots[1].branch, "topic");
        assert_eq!(snapshots[1].repository_name, "repo with spaces é");
        assert!(snapshots[1].worktrees.iter().any(|tree| tree.path == snapshots[1].path));
    }
}

#[test]
fn remove_worktree_requires_confirmation_membership_cleanliness_and_keeps_branch() {
    let temp = tempfile::tempdir().unwrap();
    let primary = temp.path().join("main");
    let linked = temp.path().join("linked with spaces é");
    let outside = temp.path().join("outside");
    git(temp.path(), &["init", "-q", "-b", "main", primary.to_str().unwrap()]);
    git(&primary, &["config", "user.name", "Test"]);
    git(&primary, &["config", "user.email", "test@example.com"]);
    std::fs::write(primary.join("tracked.txt"), "base\n").unwrap();
    git(&primary, &["add", "."]);
    git(&primary, &["commit", "-qm", "Base"]);
    git(&primary, &["worktree", "add", "-qb", "topic", linked.to_str().unwrap()]);
    std::fs::create_dir(&outside).unwrap();
    std::fs::write(outside.join("keep.txt"), "Never remove another folder\n").unwrap();
    let snap = snapshot_with(primary.to_str().unwrap(), 0, 1, ReadBackend::Git).unwrap();
    let tree = snap.worktrees.iter().find(|tree| tree.branch == "topic").unwrap();
    let remove = |path: &Path, head: Option<String>, branch: &str, confirmed: bool| RepoAction::RemoveWorktree {
        path: path.to_str().unwrap().into(), expected_head: head, branch: branch.into(), confirmed,
    };
    let send = |operation| action(primary.to_str().unwrap(), operation);
    assert!(send(remove(&linked, tree.head.clone(), "topic", false)).unwrap_err().contains("Confirm"));
    assert!(send(remove(&outside, tree.head.clone(), "topic", true)).unwrap_err().contains("not a worktree"));
    assert!(send(remove(&primary, tree.head.clone(), "main", true)).unwrap_err().contains("primary"));
    assert!(send(remove(Path::new("relative"), tree.head.clone(), "topic", true)).unwrap_err().contains("absolute"));
    assert!(send(remove(&linked, Some("0".repeat(40)), "topic", true)).unwrap_err().contains("changed"));
    assert!(send(remove(&linked, tree.head.clone(), "renamed", true)).unwrap_err().contains("changed"));
    std::fs::write(linked.join("untracked.txt"), "keep\n").unwrap();
    assert!(send(remove(&linked, tree.head.clone(), "topic", true)).is_err());
    assert!(linked.join("untracked.txt").is_file());
    std::fs::remove_file(linked.join("untracked.txt")).unwrap();
    std::fs::write(linked.join("tracked.txt"), "staged changes\n").unwrap();
    git(&linked, &["add", "tracked.txt"]);
    assert!(send(remove(&linked, tree.head.clone(), "topic", true)).is_err());
    assert_eq!(std::fs::read_to_string(linked.join("tracked.txt")).unwrap(), "staged changes\n");
    git(&linked, &["restore", "--staged", "--worktree", "tracked.txt"]);
    git(&primary, &["worktree", "lock", linked.to_str().unwrap()]);
    assert!(send(remove(&linked, tree.head.clone(), "topic", true)).unwrap_err().contains("locked"));
    git(&primary, &["worktree", "unlock", linked.to_str().unwrap()]);
    // An active desktop watcher must not prevent removing the selected checkout on Windows.
    watch(linked.to_str().unwrap(), 1000).unwrap();
    action(linked.to_str().unwrap(), remove(&linked, tree.head.clone(), "topic", true)).unwrap();
    assert!(!linked.exists());
    assert!(primary.is_dir() && outside.join("keep.txt").is_file());
    git(&primary, &["show-ref", "--verify", "refs/heads/topic"]);
    assert_eq!(snapshot_with(primary.to_str().unwrap(), 0, 1, ReadBackend::Git).unwrap().worktrees.len(), 1);
}

#[test]
fn removing_detached_worktrees_preserves_commits_without_a_branch() {
    let temp = tempfile::tempdir().unwrap();
    let primary = temp.path().join("main");
    let linked = temp.path().join("detached");
    git(temp.path(), &["init", "-q", "-b", "main", primary.to_str().unwrap()]);
    git(&primary, &["config", "user.name", "Test"]);
    git(&primary, &["config", "user.email", "test@example.com"]);
    git(&primary, &["commit", "-qm", "Base", "--allow-empty"]);
    git(&primary, &["worktree", "add", "-q", "--detach", linked.to_str().unwrap()]);
    git(&linked, &["commit", "-qm", "Detached work", "--allow-empty"]);
    let snap = snapshot_with(primary.to_str().unwrap(), 0, 1, ReadBackend::Git).unwrap();
    let tree = snap.worktrees.iter().find(|tree| tree.branch == "Detached HEAD").unwrap();
    let remove = RepoAction::RemoveWorktree { path: linked.to_str().unwrap().into(), expected_head: tree.head.clone(), branch: tree.branch.clone(), confirmed: true };
    assert!(action(primary.to_str().unwrap(), remove.clone()).unwrap_err().contains("Create a branch"));
    assert!(linked.is_dir());
    git(&linked, &["branch", "saved-detached"]);
    action(primary.to_str().unwrap(), remove).unwrap();
    assert!(!linked.exists());
    git(&primary, &["show-ref", "--verify", "refs/heads/saved-detached"]);
}

#[cfg(windows)]
#[test]
fn partial_worktree_removal_reports_unregistered_checkout_and_leftover_folder() {
    use std::os::windows::fs::OpenOptionsExt;
    let temp = tempfile::tempdir().unwrap();
    let primary = temp.path().join("main");
    let linked = temp.path().join("held-file");
    git(temp.path(), &["init", "-q", "-b", "main", primary.to_str().unwrap()]);
    git(&primary, &["config", "user.name", "Test"]);
    git(&primary, &["config", "user.email", "test@example.com"]);
    std::fs::write(primary.join("held.txt"), "Preserve this file when cleanup fails\n").unwrap();
    git(&primary, &["add", "."]);
    git(&primary, &["commit", "-qm", "Base"]);
    git(&primary, &["worktree", "add", "-qb", "topic", linked.to_str().unwrap()]);
    let snapshot = snapshot_with(primary.to_str().unwrap(), 0, 1, ReadBackend::Git).unwrap();
    let tree = snapshot.worktrees.iter().find(|tree| tree.branch == "topic").unwrap();
    let held = std::fs::OpenOptions::new().read(true).share_mode(1).open(linked.join("held.txt")).unwrap();
    let error = action(primary.to_str().unwrap(), RepoAction::RemoveWorktree {
        path: linked.to_str().unwrap().into(), expected_head: tree.head.clone(), branch: tree.branch.clone(), confirmed: true,
    }).unwrap_err();
    assert!(error.contains("Worktree removed from Git, but folder cleanup failed"), "{error}");
    assert!(linked.join("held.txt").exists());
    assert_eq!(snapshot_with(primary.to_str().unwrap(), 0, 1, ReadBackend::Git).unwrap().worktrees.len(), 1);
    drop(held);
}

#[test]
fn forgetting_stale_registration_keeps_files_branch_index_and_other_worktrees() {
    let temp = tempfile::tempdir().unwrap();
    let primary = temp.path().join("main");
    let linked = temp.path().join("broken with spaces é");
    let other = temp.path().join("other broken checkout");
    git(temp.path(), &["init", "-q", "-b", "main", primary.to_str().unwrap()]);
    git(&primary, &["config", "user.name", "Test"]);
    git(&primary, &["config", "user.email", "test@example.com"]);
    std::fs::write(primary.join("tracked.txt"), "base\n").unwrap();
    git(&primary, &["add", "."]); git(&primary, &["commit", "-qm", "Base"]);
    git(&primary, &["worktree", "add", "-qb", "topic", linked.to_str().unwrap()]);
    git(&primary, &["worktree", "add", "-qb", "other", other.to_str().unwrap()]);
    let link = std::fs::read_to_string(linked.join(".git")).unwrap();
    let admin = std::path::PathBuf::from(link.trim().strip_prefix("gitdir: ").unwrap());
    std::fs::write(linked.join("tracked.txt"), "staged work\n").unwrap();
    git(&linked, &["add", "tracked.txt"]);
    let index = std::fs::read(admin.join("index")).unwrap();
    let gitdir = std::fs::read(admin.join("gitdir")).unwrap();
    std::fs::write(linked.join("keep.txt"), "remaining user data\n").unwrap();
    std::fs::remove_file(linked.join(".git")).unwrap();
    std::fs::remove_file(other.join(".git")).unwrap();
    let snapshot = || snapshot_with(primary.to_str().unwrap(), 0, 1, ReadBackend::Git).unwrap();
    let snap = snapshot();
    let tree = snap.worktrees.iter().find(|tree| tree.branch == "topic").unwrap();
    assert!(tree.prunable);
    let forget = RepoAction::ForgetWorktree { path: tree.path.clone(), expected_head: tree.head.clone(), branch: tree.branch.clone(), confirmed: true };
    for invalid in [primary.clone(), temp.path().join("unregistered"), std::path::PathBuf::from("relative")] {
        let mut request = forget.clone();
        if let RepoAction::ForgetWorktree { path, .. } = &mut request { *path = invalid.to_string_lossy().into(); }
        assert!(action(primary.to_str().unwrap(), request).is_err());
    }
    let mut unconfirmed = forget.clone();
    if let RepoAction::ForgetWorktree { confirmed, .. } = &mut unconfirmed { *confirmed = false; }
    assert!(action(primary.to_str().unwrap(), unconfirmed).unwrap_err().contains("Confirm"));
    let mut changed = forget.clone();
    if let RepoAction::ForgetWorktree { expected_head, .. } = &mut changed { *expected_head = Some("0".repeat(40)); }
    assert!(action(primary.to_str().unwrap(), changed).unwrap_err().contains("changed"));
    std::fs::write(admin.join("locked"), "keep this checkout").unwrap();
    assert!(action(primary.to_str().unwrap(), forget.clone()).is_err());
    assert!(admin.is_dir());
    std::fs::remove_file(admin.join("locked")).unwrap();
    // A repaired checkout must never be forgotten using an earlier stale confirmation.
    std::fs::write(linked.join(".git"), &link).unwrap();
    assert!(action(primary.to_str().unwrap(), forget.clone()).unwrap_err().contains("live worktree"));
    std::fs::remove_file(linked.join(".git")).unwrap();
    #[cfg(unix)]
    {
        let outside = temp.path().join("outside-recovery");
        std::fs::create_dir(&outside).unwrap();
        let redirected = primary.join(".git/gitferry-removed-worktrees");
        std::os::unix::fs::symlink(&outside, &redirected).unwrap();
        assert!(action(primary.to_str().unwrap(), forget.clone()).unwrap_err().contains("redirected"));
        assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 0);
        assert!(admin.exists());
        std::fs::remove_file(redirected).unwrap();
    }
    let message = action(primary.to_str().unwrap(), forget).unwrap();
    assert!(message.contains("remaining folder files were kept"));
    assert!(!admin.exists());
    assert_eq!(std::fs::read_to_string(linked.join("tracked.txt")).unwrap(), "staged work\n");
    assert_eq!(std::fs::read_to_string(linked.join("keep.txt")).unwrap(), "remaining user data\n");
    let backup = std::fs::read_dir(primary.join(".git/gitferry-removed-worktrees")).unwrap().next().unwrap().unwrap().path();
    assert_eq!(std::fs::read(backup.join("index")).unwrap(), index);
    assert_eq!(std::fs::read(backup.join("gitdir")).unwrap(), gitdir);
    assert_eq!(snapshot().worktrees.len(), 2);
    assert!(snapshot().worktrees.iter().any(|tree| tree.branch == "other" && tree.prunable));
    git(&primary, &["show-ref", "--verify", "refs/heads/topic"]);
}

#[test]
fn forgetting_stale_detached_worktree_requires_reachable_commits() {
    let temp = tempfile::tempdir().unwrap();
    let primary = temp.path().join("main");
    let linked = temp.path().join("broken detached");
    git(temp.path(), &["init", "-q", "-b", "main", primary.to_str().unwrap()]);
    git(&primary, &["config", "user.name", "Test"]); git(&primary, &["config", "user.email", "test@example.com"]);
    git(&primary, &["commit", "-qm", "Base", "--allow-empty"]);
    git(&primary, &["worktree", "add", "-q", "--detach", linked.to_str().unwrap()]);
    git(&linked, &["commit", "-qm", "Unique detached commit", "--allow-empty"]);
    std::fs::remove_file(linked.join(".git")).unwrap();
    let snap = snapshot_with(primary.to_str().unwrap(), 0, 1, ReadBackend::Git).unwrap();
    let tree = snap.worktrees.iter().find(|tree| tree.prunable).unwrap();
    let forget = RepoAction::ForgetWorktree { path: tree.path.clone(), expected_head: tree.head.clone(), branch: tree.branch.clone(), confirmed: true };
    assert!(action(primary.to_str().unwrap(), forget.clone()).unwrap_err().contains("Create a branch"));
    git(&primary, &["branch", "saved-detached", tree.head.as_deref().unwrap()]);
    action(primary.to_str().unwrap(), forget).unwrap();
    assert!(linked.is_dir());
    git(&primary, &["show-ref", "--verify", "refs/heads/saved-detached"]);
}
