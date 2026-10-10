use gitferry_agent::{snapshot_with, ReadBackend};
use std::path::Path;
use std::process::Command;

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
