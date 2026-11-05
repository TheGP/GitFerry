use std::path::{Path, PathBuf};
use std::process::Command;

use gitferry_agent::{handle, working_file};
use gitferry_proto::{Request, Response};

fn git(root: &Path, args: &[&str]) -> Vec<u8> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    output.stdout
}

fn repository(parent: &Path, name: &str) -> PathBuf {
    let root = parent.join(name);
    std::fs::create_dir_all(&root).unwrap();
    git(&root, &["init", "-qb", "main"]);
    git(&root, &["config", "user.name", "Test"]);
    git(&root, &["config", "user.email", "test@example.test"]);
    root
}

fn assert_root(actual: &str, expected: &Path) {
    assert_eq!(
        Path::new(actual).canonicalize().unwrap(),
        expected.canonicalize().unwrap()
    );
}

#[test]
fn opens_clean_modified_and_untracked_text_without_changing_git_or_files() {
    let temp = tempfile::tempdir().unwrap();
    let root = repository(temp.path(), "repository with spaces 文件");
    std::fs::write(root.join("clean.txt"), "clean\n").unwrap();
    std::fs::write(root.join("modified.txt"), "base\n").unwrap();
    git(&root, &["add", "."]);
    git(&root, &["commit", "-qm", "Base"]);
    std::fs::write(root.join("modified.txt"), "modified\n").unwrap();
    std::fs::write(root.join("文件 # % + &.txt"), "untracked\n").unwrap();
    let head = git(&root, &["rev-parse", "HEAD"]);
    let status = git(&root, &["status", "--porcelain=v1", "-z"]);
    let index = std::fs::read(root.join(".git/index")).unwrap();
    for (name, content) in [
        ("clean.txt", "clean\n"),
        ("modified.txt", "modified\n"),
        ("文件 # % + &.txt", "untracked\n"),
    ] {
        let location = working_file(root.join(name).to_str().unwrap(), None).unwrap();
        assert_root(&location.repository, &root);
        assert_eq!(location.file, name);
        assert_eq!(location.content, content);
        assert_eq!(std::fs::read_to_string(root.join(name)).unwrap(), content);
    }
    assert_eq!(git(&root, &["rev-parse", "HEAD"]), head);
    assert_eq!(std::fs::read(root.join(".git/index")).unwrap(), index);
    assert_eq!(git(&root, &["status", "--porcelain=v1", "-z"]), status);
}

#[test]
fn discovers_new_nested_repositories_and_the_exact_linked_worktree() {
    let temp = tempfile::tempdir().unwrap();
    let root = repository(temp.path(), "primary");
    std::fs::write(root.join("file.txt"), "base\n").unwrap();
    git(&root, &["add", "."]);
    git(&root, &["commit", "-qm", "Base"]);
    let nested = root.join("nested");
    std::fs::create_dir_all(&nested).unwrap();
    let file = nested.join("new.txt");
    std::fs::write(&file, "untracked\n").unwrap();
    assert_root(
        &working_file(file.to_str().unwrap(), None)
            .unwrap()
            .repository,
        &root,
    );
    git(&nested, &["init", "-qb", "nested"]);
    assert_root(
        &working_file(file.to_str().unwrap(), None)
            .unwrap()
            .repository,
        &nested,
    );
    assert!(working_file(file.to_str().unwrap(), root.to_str()).is_err());
    let linked = temp.path().join("linked checkout");
    git(
        &root,
        &["worktree", "add", "-qb", "topic", linked.to_str().unwrap()],
    );
    let location = working_file(linked.join("file.txt").to_str().unwrap(), None).unwrap();
    assert_root(&location.repository, &linked);
    assert_eq!(location.file, "file.txt");
    assert_eq!(git(&root, &["branch", "--show-current"]), b"main\n");
    assert_eq!(git(&linked, &["branch", "--show-current"]), b"topic\n");
}

#[test]
fn rejects_missing_relative_directory_and_wrong_repository_targets() {
    let temp = tempfile::tempdir().unwrap();
    let root = repository(temp.path(), "repo");
    let other = repository(temp.path(), "other");
    std::fs::write(root.join("file.txt"), "text").unwrap();
    assert!(working_file("relative.txt", None).is_err());
    assert!(
        working_file(root.join("missing.txt").to_str().unwrap(), None)
            .unwrap_err()
            .contains("Cannot open file")
    );
    assert!(working_file(root.to_str().unwrap(), None)
        .unwrap_err()
        .contains("regular file"));
    assert!(
        working_file(root.join("file.txt").to_str().unwrap(), other.to_str())
            .unwrap_err()
            .contains("different repository")
    );
}

#[test]
fn rpc_reads_script_contents_without_executing_them() {
    let temp = tempfile::tempdir().unwrap();
    let root = repository(temp.path(), "repo");
    let file = root.join("$(touch PWNED).sh");
    std::fs::write(&file, "#!/bin/sh\ntouch PWNED\n").unwrap();
    let response = handle(Request::WorkingFile {
        file: file.to_str().unwrap().into(),
        repository: root.to_str().map(str::to_string),
    });
    let Response::WorkingFile(location) = response else {
        panic!("Working-file RPC failed: {response:?}")
    };
    assert!(location.content.contains("touch PWNED"));
    assert!(!root.join("PWNED").exists());
}
