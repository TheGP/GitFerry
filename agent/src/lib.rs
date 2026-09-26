use gitferry_proto::{
    ChangedFile, CommitDetails, CommitSummary, DiffResult, RefEntry, RepoAction, RepoSnapshot,
    RepoState, Request, Response, SearchResult, StatusEntry,
};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

const MAX_DIFF_BYTES: usize = 512 * 1024;

fn hide_console(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    #[cfg(not(windows))]
    let _ = command;
}

pub fn handle(request: Request) -> Response {
    let result = match request {
        Request::Snapshot {
            path,
            offset,
            limit,
        } => snapshot(&path, offset, limit).map(Response::Snapshot),
        Request::State { path } => state(&path).map(Response::State),
        Request::Search {
            path,
            query,
            offset,
            limit,
        } => search(&path, &query, offset, limit).map(Response::Search),
        Request::CommitDetails { path, hash } => {
            commit_details(&path, &hash).map(Response::CommitDetails)
        }
        Request::Diff { path, target, file } => diff(&path, &target, &file).map(Response::Diff),
        Request::Action {
            path,
            action: operation,
        } => action(&path, operation).map(Response::Action),
    };
    result.unwrap_or_else(Response::Error)
}

fn git(repo: &Path, args: &[&str]) -> Result<Output, String> {
    let mut command = Command::new("git");
    hide_console(&mut command);
    let output = command
        .arg("--no-optional-locks")
        .arg("-C")
        .arg(repo)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .output()
        .map_err(|error| format!("Cannot run Git: {error}"))?;
    if output.status.success() {
        Ok(output)
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

fn repo_root(path: &str) -> Result<PathBuf, String> {
    let candidate = Path::new(path)
        .canonicalize()
        .map_err(|error| format!("Cannot open repository path: {error}"))?;
    let output = git(&candidate, &["rev-parse", "--show-toplevel"])?;
    let root = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if root.is_empty() {
        return Err("This path is not a Git working tree".to_string());
    }
    PathBuf::from(root)
        .canonicalize()
        .map_err(|error| error.to_string())
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn display_path(path: &Path) -> String {
    let path = path.to_string_lossy();
    #[cfg(windows)]
    let path = path.strip_prefix(r"\\?\").unwrap_or(&path);
    path.to_string()
}

fn branch(repo: &Path) -> String {
    git(repo, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .map(|output| text(&output.stdout).trim().to_string())
        .unwrap_or_else(|_| "Detached HEAD".to_string())
}

fn head(repo: &Path) -> Option<String> {
    git(repo, &["rev-parse", "--verify", "HEAD"])
        .ok()
        .map(|output| text(&output.stdout).trim().to_string())
}

fn status(repo: &Path) -> Result<Vec<StatusEntry>, String> {
    let output = git(
        repo,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?;
    let fields: Vec<&[u8]> = output.stdout.split(|byte| *byte == 0).collect();
    let mut entries = Vec::new();
    let mut index = 0;
    while index < fields.len() && !fields[index].is_empty() {
        let field = fields[index];
        if field.len() < 4 || field[2] != b' ' {
            return Err("Git returned an invalid status entry".to_string());
        }
        let index_state = field[0] as char;
        let worktree_state = field[1] as char;
        let original_path =
            if matches!(index_state, 'R' | 'C') || matches!(worktree_state, 'R' | 'C') {
                index += 1;
                Some(text(
                    fields
                        .get(index)
                        .ok_or("Git returned an incomplete rename")?,
                ))
            } else {
                None
            };
        entries.push(StatusEntry {
            path: text(&field[3..]),
            index: index_state.to_string(),
            worktree: worktree_state.to_string(),
            original_path,
        });
        index += 1;
    }
    Ok(entries)
}

fn refs(repo: &Path, current_branch: &str) -> Result<Vec<RefEntry>, String> {
    let output = git(
        repo,
        &[
            "for-each-ref",
            "--format=%(refname)%00%(objectname)%00%(upstream:track)%00%(*objectname)%00",
            "refs/heads",
            "refs/remotes",
            "refs/tags",
        ],
    )?;
    let mut entries = Vec::new();
    for line in output.stdout.split(|byte| *byte == b'\n') {
        let fields: Vec<&[u8]> = line.split(|byte| *byte == 0).collect();
        if fields.len() < 2 || fields[0].is_empty() {
            continue;
        }
        let full_name = text(fields[0]);
        let (kind, name) = if let Some(name) = full_name.strip_prefix("refs/heads/") {
            ("branch", name)
        } else if let Some(name) = full_name.strip_prefix("refs/remotes/") {
            ("remote", name)
        } else if let Some(name) = full_name.strip_prefix("refs/tags/") {
            ("tag", name)
        } else {
            continue;
        };
        let track = fields.get(2).map(|field| text(field)).unwrap_or_default();
        let tracking_count = |label: &str| {
            track
                .split([',', '[', ']'])
                .find_map(|part| part.trim().strip_prefix(label)?.parse::<u32>().ok())
                .unwrap_or(0)
        };
        entries.push(RefEntry {
            name: name.to_string(),
            kind: kind.to_string(),
            target: text(
                if kind == "tag" && fields.get(3).is_some_and(|field| !field.is_empty()) {
                    fields[3]
                } else {
                    fields[1]
                },
            ),
            is_head: kind == "branch" && name == current_branch,
            ahead: tracking_count("ahead "),
            behind: tracking_count("behind "),
        });
    }
    if let Ok(output) = git(repo, &["stash", "list", "--format=%gd%x00%H%x00%gs%x1e"]) {
        for record in output.stdout.split(|byte| *byte == 0x1e) {
            let fields: Vec<&[u8]> = record.trim_ascii().split(|byte| *byte == 0).collect();
            if fields.len() < 3 || fields[0].is_empty() {
                continue;
            }
            entries.push(RefEntry {
                name: format!("{} · {}", text(fields[0]), text(fields[2])),
                kind: "stash".to_string(),
                target: text(fields[1]),
                is_head: false,
                ahead: 0,
                behind: 0,
            });
        }
    }
    if let Ok(output) = git(repo, &["submodule", "status", "--recursive"]) {
        for line in output.stdout.split(|byte| *byte == b'\n') {
            if line.len() < 42 {
                continue;
            }
            entries.push(RefEntry {
                name: text(&line[42..]).trim().to_string(),
                kind: "submodule".to_string(),
                target: text(&line[1..41]),
                is_head: false,
                ahead: 0,
                behind: 0,
            });
        }
    }
    Ok(entries)
}

fn log(
    repo: &Path,
    offset: usize,
    limit: usize,
    filter: Option<(&str, &str)>,
) -> Result<(Vec<CommitSummary>, bool), String> {
    let limit = limit.clamp(1, 200);
    let skip_arg = format!("--skip={offset}");
    let count_arg = format!("--max-count={}", limit + 1);
    let mut args = vec![
        "log",
        "HEAD",
        "--all",
        &skip_arg,
        &count_arg,
        "--format=%H%x00%P%x00%s%x00%an%x00%at%x00%D%x1e",
    ];
    let pathspec;
    if let Some((kind, term)) = filter {
        match kind {
            "author" => args.extend(["--author", term]),
            "path" => {
                pathspec = literal_path(term)?;
                args.extend(["--", pathspec.as_str()]);
            }
            _ => args.extend(["--fixed-strings", "--grep", term]),
        }
    }
    let output = git(repo, &args)?;
    let mut commits = Vec::new();
    for record in output.stdout.split(|byte| *byte == 0x1e) {
        let record = record.trim_ascii_start();
        let fields: Vec<&[u8]> = record.split(|byte| *byte == 0).collect();
        if fields.len() < 6 || fields[0].is_empty() {
            continue;
        }
        commits.push(CommitSummary {
            hash: text(fields[0]),
            parents: text(fields[1])
                .split_whitespace()
                .map(str::to_string)
                .collect(),
            subject: text(fields[2]),
            author: text(fields[3]),
            timestamp: text(fields[4]).parse().unwrap_or_default(),
            decorations: text(fields[5])
                .trim()
                .split(", ")
                .filter(|part| !part.is_empty())
                .map(str::to_string)
                .collect(),
        });
    }
    let has_more = commits.len() > limit;
    commits.truncate(limit);
    Ok((commits, has_more))
}

pub fn snapshot(path: &str, offset: usize, limit: usize) -> Result<RepoSnapshot, String> {
    let root = repo_root(path)?;
    let current_branch = branch(&root);
    let (commits, has_more) = if head(&root).is_some() {
        log(&root, offset, limit, None)?
    } else {
        (Vec::new(), false)
    };
    Ok(RepoSnapshot {
        name: root
            .file_name()
            .unwrap_or(root.as_os_str())
            .to_string_lossy()
            .into_owned(),
        path: display_path(&root),
        branch: current_branch.clone(),
        head: head(&root),
        status: status(&root)?,
        refs: refs(&root, &current_branch)?,
        commits,
        has_more,
    })
}

pub fn state(path: &str) -> Result<RepoState, String> {
    let root = repo_root(path)?;
    Ok(RepoState {
        branch: branch(&root),
        head: head(&root),
        status: status(&root)?,
    })
}

pub fn search(
    path: &str,
    query: &str,
    offset: usize,
    limit: usize,
) -> Result<SearchResult, String> {
    let root = repo_root(path)?;
    if head(&root).is_none() {
        return Ok(SearchResult {
            commits: Vec::new(),
            has_more: false,
        });
    }
    let query = query.trim();
    if query.is_empty() {
        return Ok(SearchResult {
            commits: Vec::new(),
            has_more: false,
        });
    }
    let (kind, term) = if let Some(term) = query.strip_prefix("author:") {
        ("author", term.trim())
    } else if let Some(term) = query.strip_prefix("path:") {
        ("path", term.trim())
    } else {
        ("message", query)
    };
    if term.is_empty() {
        return Err("Search term cannot be empty".to_string());
    }
    let (commits, has_more) = log(&root, offset, limit, Some((kind, term)))?;
    Ok(SearchResult { commits, has_more })
}

fn valid_hash(hash: &str) -> bool {
    (hash.len() == 40 || hash.len() == 64) && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub fn commit_details(path: &str, hash: &str) -> Result<CommitDetails, String> {
    if !valid_hash(hash) {
        return Err("Invalid commit ID".to_string());
    }
    let root = repo_root(path)?;
    let output = git(
        &root,
        &[
            "show",
            "-s",
            "--format=%H%x00%s%x00%b%x00%an%x00%ae%x00%at%x00%P",
            hash,
        ],
    )?;
    let fields: Vec<&[u8]> = output
        .stdout
        .trim_ascii_end()
        .split(|byte| *byte == 0)
        .collect();
    if fields.len() != 7 {
        return Err("Git returned invalid commit details".to_string());
    }
    let parents: Vec<String> = text(fields[6])
        .split_whitespace()
        .map(str::to_string)
        .collect();
    let output = if let Some(parent) = parents.first() {
        git(&root, &["diff", "--name-status", "-z", parent, hash])?
    } else {
        git(
            &root,
            &[
                "diff-tree",
                "--root",
                "-r",
                "--no-commit-id",
                "--name-status",
                "-z",
                hash,
            ],
        )?
    };
    let fields_changed: Vec<&[u8]> = output.stdout.split(|byte| *byte == 0).collect();
    let mut files = Vec::new();
    let mut index = 0;
    while index + 1 < fields_changed.len() && !fields_changed[index].is_empty() {
        let state = text(fields_changed[index]);
        let path_index = if state.starts_with('R') || state.starts_with('C') {
            index + 2
        } else {
            index + 1
        };
        if let Some(file) = fields_changed.get(path_index) {
            files.push(ChangedFile {
                path: text(file),
                status: state,
            });
        }
        index = path_index + 1;
    }
    Ok(CommitDetails {
        hash: text(fields[0]),
        subject: text(fields[1]),
        body: text(fields[2]),
        author: text(fields[3]),
        author_email: text(fields[4]),
        timestamp: text(fields[5]).parse().unwrap_or_default(),
        parents,
        files,
    })
}

pub fn diff(path: &str, target: &str, file: &str) -> Result<DiffResult, String> {
    let root = repo_root(path)?;
    let literal_file = literal_path(file)?;
    let output = match target {
        "working" => git(
            &root,
            &["diff", "--no-ext-diff", "--no-color", "--", &literal_file],
        )?,
        "staged" => git(
            &root,
            &[
                "diff",
                "--cached",
                "--no-ext-diff",
                "--no-color",
                "--",
                &literal_file,
            ],
        )?,
        "untracked" => {
            let file_path = root.join(file);
            let canonical = file_path
                .canonicalize()
                .map_err(|error| error.to_string())?;
            if !canonical.starts_with(&root) {
                return Err("File is outside the repository".to_string());
            }
            let bytes = std::fs::read(&canonical).map_err(|error| error.to_string())?;
            let truncated = bytes.len() > MAX_DIFF_BYTES;
            let preview = &bytes[..bytes.len().min(MAX_DIFF_BYTES)];
            return Ok(DiffResult {
                text: if preview.contains(&0) {
                    "Binary file".to_string()
                } else {
                    text(preview)
                },
                truncated,
            });
        }
        hash if valid_hash(hash) => {
            let output = git(&root, &["rev-list", "--parents", "-n", "1", hash])?;
            let parent = text(&output.stdout)
                .split_whitespace()
                .nth(1)
                .map(str::to_string);
            if let Some(parent) = parent {
                git(
                    &root,
                    &[
                        "diff",
                        "--no-ext-diff",
                        "--no-color",
                        &parent,
                        hash,
                        "--",
                        &literal_file,
                    ],
                )?
            } else {
                git(
                    &root,
                    &[
                        "show",
                        "--format=",
                        "--no-ext-diff",
                        "--no-color",
                        hash,
                        "--",
                        &literal_file,
                    ],
                )?
            }
        }
        _ => return Err("Invalid diff target".to_string()),
    };
    let truncated = output.stdout.len() > MAX_DIFF_BYTES;
    Ok(DiffResult {
        text: text(&output.stdout[..output.stdout.len().min(MAX_DIFF_BYTES)]),
        truncated,
    })
}

pub fn action(path: &str, action: RepoAction) -> Result<String, String> {
    let root = repo_root(path)?;
    let output = match action {
        RepoAction::StageAll => git(&root, &["add", "-A"])?,
        RepoAction::StageFile { path } => {
            let path = literal_path(&path)?;
            git(&root, &["add", "--", &path])?
        }
        RepoAction::StageHunk {
            path,
            index,
            reverse,
        } => {
            let path = literal_path(&path)?;
            let diff_args = if reverse {
                vec![
                    "diff",
                    "--cached",
                    "--no-ext-diff",
                    "--no-color",
                    "--",
                    path.as_str(),
                ]
            } else {
                vec!["diff", "--no-ext-diff", "--no-color", "--", path.as_str()]
            };
            let patch = git(&root, &diff_args)?.stdout;
            if patch.len() > MAX_DIFF_BYTES {
                return Err("Diff is too large for hunk staging".to_string());
            }
            let patch = text(&patch);
            let starts: Vec<usize> = patch
                .match_indices("\n@@")
                .map(|(position, _)| position + 1)
                .collect();
            let start = *starts
                .get(index)
                .ok_or("Hunk no longer exists; refresh the diff")?;
            let end = starts.get(index + 1).copied().unwrap_or(patch.len());
            let selected = format!("{}{}", &patch[..start], &patch[start..end]);
            let args = if reverse {
                vec!["apply", "--cached", "--reverse", "--unidiff-zero", "-"]
            } else {
                vec!["apply", "--cached", "--unidiff-zero", "-"]
            };
            git_with_input(&root, &args, selected.as_bytes())?
        }
        RepoAction::UnstageFile { path } => {
            let path = literal_path(&path)?;
            if head(&root).is_some() {
                git(&root, &["restore", "--staged", "--", &path])?
            } else {
                git(&root, &["rm", "--cached", "--", &path])?
            }
        }
        RepoAction::DiscardFile { path } => {
            let path = literal_path(&path)?;
            git(&root, &["restore", "--worktree", "--", &path])?
        }
        RepoAction::Commit { message, amend } => {
            if message.trim().is_empty() {
                return Err("Commit message cannot be empty".to_string());
            }
            if amend && head(&root).is_none() {
                return Err("No commit to amend".to_string());
            }
            let mut args = vec!["commit", "-m", message.as_str()];
            if amend {
                args.push("--amend");
            }
            git(&root, &args)?
        }
        RepoAction::Fetch => git(&root, &["fetch", "--all", "--progress"])?,
        RepoAction::Pull => git(&root, &["pull", "--ff-only", "--progress"])?,
        RepoAction::Push => git(&root, &["push", "--progress"])?,
        RepoAction::ForcePushWithLease => force_push_with_lease(&root)?,
        RepoAction::Checkout { branch } => {
            validate_branch(&root, &branch)?;
            git(&root, &["switch", &branch])?
        }
        RepoAction::CreateBranch { branch } => {
            validate_branch(&root, &branch)?;
            git(&root, &["switch", "-c", &branch])?
        }
        RepoAction::DeleteBranch { branch } => {
            validate_branch(&root, &branch)?;
            git(&root, &["branch", "-d", &branch])?
        }
        RepoAction::Stash { message } => git(&root, &["stash", "push", "-u", "-m", &message])?,
        RepoAction::ApplyStash { hash } => restore_stash(&root, &hash, false)?,
        RepoAction::PopStash { hash } => restore_stash(&root, &hash, true)?,
    };
    let stdout = text(&output.stdout);
    let stderr = text(&output.stderr);
    Ok(format!("{}{}", stdout, stderr).trim().to_string())
}

fn force_push_with_lease(repo: &Path) -> Result<Output, String> {
    let branch = git(repo, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .map(|output| text(&output.stdout).trim().to_string())
        .map_err(|_| "Select a branch before pushing".to_string())?;
    let upstream_error = || "Set an upstream branch before force pushing with lease".to_string();
    let remote = git(
        repo,
        &["config", "--get", &format!("branch.{branch}.remote")],
    )
    .map(|output| text(&output.stdout).trim().to_string())
    .map_err(|_| upstream_error())?;
    let target = git(
        repo,
        &["config", "--get", &format!("branch.{branch}.merge")],
    )
    .map(|output| text(&output.stdout).trim().to_string())
    .map_err(|_| upstream_error())?;
    if remote.is_empty()
        || remote == "."
        || remote.starts_with('-')
        || !target.starts_with("refs/heads/")
        || target == "refs/heads/"
    {
        return Err(upstream_error());
    }
    git(
        repo,
        &[
            "push",
            "--force-with-lease",
            "--no-follow-tags",
            "--progress",
            &remote,
            &format!("HEAD:{target}"),
        ],
    )
}

fn restore_stash(repo: &Path, hash: &str, pop: bool) -> Result<Output, String> {
    if !valid_hash(hash) {
        return Err("Invalid stash hash".to_string());
    }
    let list = git(repo, &["stash", "list", "--format=%gd%x00%H%x1e"])?;
    let stash = list
        .stdout
        .split(|byte| *byte == 0x1e)
        .find_map(|record| {
            let mut fields = record.trim_ascii().split(|byte| *byte == 0);
            let name = fields.next()?;
            let target = fields.next()?;
            (target == hash.as_bytes()).then(|| text(name))
        })
        .ok_or("Stash no longer exists; refresh the repository")?;
    git(repo, &["stash", if pop { "pop" } else { "apply" }, &stash])
}

fn git_with_input(repo: &Path, args: &[&str], input: &[u8]) -> Result<Output, String> {
    let mut command = Command::new("git");
    hide_console(&mut command);
    let mut child = command
        .arg("-C")
        .arg(repo)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| error.to_string())?;
    child
        .stdin
        .take()
        .ok_or("Git stdin unavailable")?
        .write_all(input)
        .map_err(|error| error.to_string())?;
    let output = child
        .wait_with_output()
        .map_err(|error| error.to_string())?;
    if output.status.success() {
        Ok(output)
    } else {
        Err(text(&output.stderr).trim().to_string())
    }
}

fn literal_path(path: &str) -> Result<String, String> {
    if path.is_empty()
        || !Path::new(path)
            .components()
            .all(|part| matches!(part, std::path::Component::Normal(_)))
    {
        return Err("Invalid file path".to_string());
    }
    Ok(format!(":(literal){path}"))
}

fn validate_branch(repo: &Path, branch: &str) -> Result<(), String> {
    if branch.is_empty() || branch.starts_with('-') {
        return Err("Invalid branch name".to_string());
    }
    git(repo, &["check-ref-format", "--branch", branch]).map(|_| ())
}
