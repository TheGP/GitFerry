use gitferry_proto::{
    ChangedFile, CommitDetails, CommitSummary, DiffResult, RebaseCommit, RebaseStep, RefEntry,
    RepoAction, RepoSnapshot, RepoState, Request, Response, SearchResult, StatusEntry,
};
use notify::{EventKind, RecursiveMode, Watcher};
use std::collections::HashSet;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

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
        Request::Watch { path, timeout_ms } => watch(&path, timeout_ms).map(Response::Changed),
        Request::RebasePlan { path, onto } => rebase_plan(&path, &onto).map(Response::RebasePlan),
        Request::Search {
            path,
            query,
            offset,
            limit,
        } => search(&path, &query, offset, limit).map(Response::Search),
        Request::CommitDetails { path, hash } => {
            commit_details(&path, &hash).map(Response::CommitDetails)
        }
        Request::Diff {
            path,
            target,
            file,
            ignore_whitespace,
        } => diff_with_options(&path, &target, &file, ignore_whitespace).map(Response::Diff),
        Request::Action {
            path,
            action: operation,
            cancel_token,
        } => action_with_progress(&path, operation, cancel_token.as_deref(), |_| {})
            .map(Response::Action),
        Request::Cancel { token } => cancel_operation(&token).map(Response::Action),
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

struct OperationMarker {
    active: PathBuf,
    cancel: PathBuf,
}

impl Drop for OperationMarker {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.active);
        let _ = std::fs::remove_file(&self.cancel);
    }
}

fn marker_paths(token: &str) -> Result<(PathBuf, PathBuf), String> {
    if token.len() != 36
        || !token.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
    {
        return Err("Invalid operation token".to_string());
    }
    let directory = std::env::temp_dir().join("gitferry-ops");
    Ok((
        directory.join(format!("{token}.active")),
        directory.join(format!("{token}.cancel")),
    ))
}

pub fn cancel_operation(token: &str) -> Result<String, String> {
    let (active, cancel) = marker_paths(token)?;
    if !active.is_file() {
        return Err("Operation already finished".to_string());
    }
    std::fs::write(cancel, []).map_err(|error| error.to_string())?;
    Ok("Cancelling operation".to_string())
}

fn git_with_progress(
    repo: &Path,
    args: &[&str],
    cancel_token: Option<&str>,
    progress: &mut impl FnMut(&str),
) -> Result<Output, String> {
    let marker = cancel_token
        .map(|token| {
            let (active, cancel) = marker_paths(token)?;
            std::fs::create_dir_all(active.parent().ok_or("Invalid operation marker")?)
                .map_err(|error| error.to_string())?;
            let _ = std::fs::remove_file(&cancel);
            std::fs::write(&active, []).map_err(|error| error.to_string())?;
            Ok::<_, String>(OperationMarker { active, cancel })
        })
        .transpose()?;
    let mut command = Command::new("git");
    hide_console(&mut command);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
    }
    let mut child = command
        .arg("--no-optional-locks")
        .arg("-C")
        .arg(repo)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Cannot run Git: {error}"))?;
    let mut stdout = child.stdout.take().ok_or("Git stdout unavailable")?;
    let stderr_pipe = child.stderr.take().ok_or("Git stderr unavailable")?;
    let child = Arc::new(Mutex::new(child));
    let finished = Arc::new(AtomicBool::new(false));
    let watcher = marker.as_ref().map(|marker| {
        let child = Arc::clone(&child);
        let finished = Arc::clone(&finished);
        let cancel = marker.cancel.clone();
        std::thread::spawn(move || {
            while !finished.load(Ordering::Relaxed) {
                if cancel.is_file() {
                    #[cfg(windows)]
                    {
                        let pid = child.lock().ok().map(|process| process.id());
                        if let Some(pid) = pid {
                            let mut command = Command::new(r"C:\Windows\System32\taskkill.exe");
                            hide_console(&mut command);
                            let _ = command
                                .args(["/T", "/F", "/PID", &pid.to_string()])
                                .stdout(Stdio::null())
                                .stderr(Stdio::null())
                                .status();
                        }
                    }
                    #[cfg(unix)]
                    if let Ok(process) = child.lock() {
                        unsafe {
                            libc::kill(-(process.id() as i32), libc::SIGKILL);
                        }
                    }
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        })
    });
    let output_reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).map(|_| bytes)
    });
    let mut stderr = Vec::new();
    let mut line = Vec::new();
    let mut last = String::new();
    let mut stream = std::io::BufReader::new(stderr_pipe);
    let mut byte = [0];
    let read_result = loop {
        match stream.read(&mut byte) {
            Ok(0) => break Ok(()),
            Ok(_) => {
                stderr.push(byte[0]);
                if byte[0] == b'\r' || byte[0] == b'\n' {
                    let message = text(&line).trim().to_string();
                    if !message.is_empty() && message != last {
                        progress(&message);
                        last = message;
                    }
                    line.clear();
                } else {
                    line.push(byte[0]);
                }
            }
            Err(error) => break Err(error.to_string()),
        }
    };
    finished.store(true, Ordering::Relaxed);
    if let Some(watcher) = watcher {
        let _ = watcher.join();
    }
    read_result?;
    let output = Output {
        status: child
            .lock()
            .map_err(|error| error.to_string())?
            .wait()
            .map_err(|error| error.to_string())?,
        stdout: output_reader
            .join()
            .map_err(|_| "Git stdout reader failed".to_string())?
            .map_err(|error| error.to_string())?,
        stderr,
    };
    if marker
        .as_ref()
        .is_some_and(|marker| marker.cancel.is_file())
    {
        return Err("Operation cancelled".to_string());
    }
    if output.status.success() {
        Ok(output)
    } else {
        Err(text(&output.stderr).trim().to_string())
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

pub fn watch(path: &str, timeout_ms: u64) -> Result<bool, String> {
    let root = repo_root(path)?;
    let (sender, receiver) = std::sync::mpsc::channel();
    let mut watcher = notify::recommended_watcher(sender).map_err(|error| error.to_string())?;
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|error| error.to_string())?;
    let git_dir = git(&root, &["rev-parse", "--absolute-git-dir"])?;
    let git_dir = PathBuf::from(text(&git_dir.stdout).trim());
    if !git_dir.starts_with(&root) {
        watcher
            .watch(&git_dir, RecursiveMode::Recursive)
            .map_err(|error| error.to_string())?;
    }
    let deadline = std::time::Instant::now()
        + std::time::Duration::from_millis(timeout_ms.clamp(1_000, 60_000));
    loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return Ok(false);
        }
        match receiver.recv_timeout(remaining) {
            Ok(Ok(event)) => {
                if matches!(event.kind, EventKind::Access(_)) {
                    continue;
                }
                let relevant = event.paths.is_empty()
                    || event.paths.iter().any(|path| {
                        let mut in_git_dir = false;
                        for part in path.components() {
                            let name = part.as_os_str().to_string_lossy();
                            if name == "node_modules"
                                || name == "target"
                                || (in_git_dir && (name == "objects" || name == "logs"))
                            {
                                return false;
                            }
                            if name == ".git" {
                                in_git_dir = true;
                            }
                        }
                        true
                    });
                if relevant {
                    std::thread::sleep(std::time::Duration::from_millis(250));
                    return Ok(true);
                }
            }
            Ok(Err(error)) => return Err(error.to_string()),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => return Ok(false),
            Err(error) => return Err(error.to_string()),
        }
    }
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

fn operation(repo: &Path) -> Option<String> {
    let git_dir = git(repo, &["rev-parse", "--absolute-git-dir"]).ok()?;
    let dir = PathBuf::from(text(&git_dir.stdout).trim());
    if dir.join("rebase-merge").exists() || dir.join("rebase-apply").exists() {
        Some("rebase".to_string())
    } else if dir.join("MERGE_HEAD").exists() {
        Some("merge".to_string())
    } else if dir.join("CHERRY_PICK_HEAD").exists() {
        Some("cherry_pick".to_string())
    } else if dir.join("REVERT_HEAD").exists() {
        Some("revert".to_string())
    } else {
        None
    }
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
        operation: operation(&root),
    })
}

pub fn state(path: &str) -> Result<RepoState, String> {
    let root = repo_root(path)?;
    Ok(RepoState {
        branch: branch(&root),
        head: head(&root),
        status: status(&root)?,
        operation: operation(&root),
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
    diff_with_options(path, target, file, false)
}

pub fn diff_with_options(
    path: &str,
    target: &str,
    file: &str,
    ignore_whitespace: bool,
) -> Result<DiffResult, String> {
    let root = repo_root(path)?;
    let literal_file = literal_path(file)?;
    let run_diff = |args: &[&str]| {
        let mut args = args.to_vec();
        if ignore_whitespace {
            args.insert(1, "-w");
        }
        git(&root, &args)
    };
    let output = match target {
        "working" => run_diff(&["diff", "--no-ext-diff", "--no-color", "--", &literal_file])?,
        "staged" => run_diff(&[
            "diff",
            "--cached",
            "--no-ext-diff",
            "--no-color",
            "--",
            &literal_file,
        ])?,
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
                run_diff(&[
                    "diff",
                    "--no-ext-diff",
                    "--no-color",
                    &parent,
                    hash,
                    "--",
                    &literal_file,
                ])?
            } else {
                run_diff(&[
                    "show",
                    "--format=",
                    "--no-ext-diff",
                    "--no-color",
                    hash,
                    "--",
                    &literal_file,
                ])?
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
    action_with_progress(path, action, None, |_| {})
}

pub fn rebase_plan(path: &str, onto: &str) -> Result<Vec<RebaseCommit>, String> {
    let root = repo_root(path)?;
    validate_branch(&root, onto)?;
    let base = format!("refs/heads/{onto}");
    git(&root, &["rev-parse", "--verify", &base])?;
    let range = format!("{base}..HEAD");
    if !git(&root, &["rev-list", "--merges", "-n", "1", &range])?
        .stdout
        .is_empty()
    {
        return Err("Interactive rebase currently supports linear history only".to_string());
    }
    let output = git(
        &root,
        &[
            "log",
            "--reverse",
            "--topo-order",
            "--format=%H%x00%s%x1e",
            &range,
        ],
    )?;
    let commits: Vec<RebaseCommit> = text(&output.stdout)
        .split('\x1e')
        .filter_map(|record| record.trim_start_matches(['\r', '\n']).split_once('\0'))
        .map(|(hash, subject)| RebaseCommit {
            hash: hash.to_string(),
            subject: subject.trim_end_matches(['\r', '\n']).to_string(),
        })
        .collect();
    if commits.is_empty() {
        return Err(format!("No commits on this branch to rebase onto {onto}"));
    }
    Ok(commits)
}

struct TodoFile(PathBuf);

impl Drop for TodoFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn interactive_rebase(
    repo: &Path,
    branch: &str,
    onto: &str,
    steps: &[RebaseStep],
) -> Result<Output, String> {
    if operation(repo).is_some() {
        return Err("Finish or abort the current Git operation first".to_string());
    }
    if !text(&git(repo, &["status", "--porcelain"])?.stdout)
        .trim()
        .is_empty()
    {
        return Err("Commit or stash working changes before interactive rebase".to_string());
    }
    let current = git(repo, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .map_err(|_| "Check out a branch before interactive rebase".to_string())?;
    if text(&current.stdout).trim() != branch {
        return Err("Current branch changed; reopen the rebase plan".to_string());
    }
    let expected = rebase_plan(&repo.to_string_lossy(), onto)?;
    let known: HashSet<&str> = expected.iter().map(|item| item.hash.as_str()).collect();
    let selected: HashSet<&str> = steps.iter().map(|item| item.hash.as_str()).collect();
    if steps.len() != expected.len() || selected != known {
        return Err("Rebase plan changed; reopen it before starting".to_string());
    }
    let mut todo = String::new();
    let mut kept = false;
    for step in steps {
        match step.action.as_str() {
            "pick" => kept = true,
            "fixup" if kept => {}
            "fixup" => return Err("Fixup needs an earlier picked commit".to_string()),
            "drop" => {}
            _ => return Err("Invalid rebase action".to_string()),
        }
        let subject = expected
            .iter()
            .find(|item| item.hash == step.hash)
            .ok_or("Rebase plan changed; reopen it before starting")?
            .subject
            .replace(['\r', '\n'], " ");
        todo.push_str(&format!("{} {} {}\n", step.action, step.hash, subject));
    }
    let file = std::env::temp_dir().join(format!(
        "gitferry-rebase-{}-{}.todo",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_nanos()
    ));
    let mut writer = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&file)
        .map_err(|error| error.to_string())?;
    writer
        .write_all(todo.as_bytes())
        .map_err(|error| error.to_string())?;
    drop(writer);
    let _cleanup = TodoFile(file.clone());
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let executable = executable.to_string_lossy().replace('\\', "/");
    let file = file.to_string_lossy().replace('\\', "/");
    let editor = format!(
        "{} --write-todo {}",
        shell_quote(&executable),
        shell_quote(&file)
    );
    let base = format!("refs/heads/{onto}");
    git(
        repo,
        &[
            "-c",
            &format!("sequence.editor={editor}"),
            "-c",
            "core.editor=true",
            "rebase",
            "--interactive",
            "--no-autostash",
            "--reapply-cherry-picks",
            &base,
        ],
    )
}

pub fn write_rebase_todo(args: &[String]) -> Result<(), String> {
    if args.len() != 2 {
        return Err("Expected plan and Git todo paths".to_string());
    }
    let plan = std::fs::read(&args[0]).map_err(|error| error.to_string())?;
    if plan.len() > 1024 * 1024 || plan.is_empty() {
        return Err("Invalid rebase plan size".to_string());
    }
    std::fs::write(&args[1], plan).map_err(|error| error.to_string())
}

pub fn action_with_progress(
    path: &str,
    action: RepoAction,
    cancel_token: Option<&str>,
    mut progress: impl FnMut(&str),
) -> Result<String, String> {
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
        } => apply_hunk(
            &root,
            &path,
            index,
            if reverse {
                HunkAction::Unstage
            } else {
                HunkAction::Stage
            },
            None,
        )?,
        RepoAction::DiscardHunk { path, index, diff } => {
            apply_hunk(&root, &path, index, HunkAction::Discard, Some(&diff))?
        }
        RepoAction::StageLines { path, lines, diff } => {
            apply_lines(&root, &path, &lines, &diff, LineAction::Stage)?
        }
        RepoAction::UnstageLines { path, lines, diff } => {
            apply_lines(&root, &path, &lines, &diff, LineAction::Unstage)?
        }
        RepoAction::DiscardLines { path, lines, diff } => {
            apply_lines(&root, &path, &lines, &diff, LineAction::Discard)?
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
        RepoAction::Fetch => git_with_progress(
            &root,
            &["fetch", "--all", "--progress"],
            cancel_token,
            &mut progress,
        )?,
        RepoAction::Pull => git_with_progress(
            &root,
            &["pull", "--ff-only", "--progress"],
            cancel_token,
            &mut progress,
        )?,
        RepoAction::PullMerge => git_with_progress(
            &root,
            &["pull", "--no-rebase", "--no-edit", "--progress"],
            cancel_token,
            &mut progress,
        )?,
        RepoAction::PullRebase => git_with_progress(
            &root,
            &["pull", "--rebase", "--progress"],
            cancel_token,
            &mut progress,
        )?,
        RepoAction::Push => push(&root, cancel_token, &mut progress)?,
        RepoAction::ForcePushWithLease => {
            force_push_with_lease(&root, cancel_token, &mut progress)?
        }
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
        RepoAction::Merge { branch } => {
            validate_branch(&root, &branch)?;
            git(&root, &["merge", "--no-edit", &branch])?
        }
        RepoAction::Rebase { branch } => {
            validate_branch(&root, &branch)?;
            git(&root, &["rebase", "--no-autostash", &branch])?
        }
        RepoAction::InteractiveRebase {
            branch,
            onto,
            steps,
        } => interactive_rebase(&root, &branch, &onto, &steps)?,
        RepoAction::AbortOperation => match operation(&root).as_deref() {
            Some("merge") => git(&root, &["merge", "--abort"])?,
            Some("rebase") => git(&root, &["rebase", "--abort"])?,
            Some("cherry_pick") => git(&root, &["cherry-pick", "--abort"])?,
            Some("revert") => git(&root, &["revert", "--abort"])?,
            _ => return Err("No merge, rebase, cherry-pick, or revert is in progress".to_string()),
        },
        RepoAction::ContinueOperation => match operation(&root).as_deref() {
            Some("merge") => git(&root, &["-c", "core.editor=true", "merge", "--continue"])?,
            Some("rebase") => git(&root, &["-c", "core.editor=true", "rebase", "--continue"])?,
            Some("cherry_pick") => git(
                &root,
                &["-c", "core.editor=true", "cherry-pick", "--continue"],
            )?,
            Some("revert") => git(&root, &["-c", "core.editor=true", "revert", "--continue"])?,
            _ => return Err("No merge, rebase, cherry-pick, or revert is in progress".to_string()),
        },
        RepoAction::CherryPick { hash } => {
            if !valid_hash(&hash) {
                return Err("Invalid commit ID".to_string());
            }
            git(&root, &["cherry-pick", &hash])?
        }
        RepoAction::Revert { hash } => {
            if !valid_hash(&hash) {
                return Err("Invalid commit ID".to_string());
            }
            git(&root, &["revert", "--no-edit", &hash])?
        }
        RepoAction::Reset { hash, mode } => {
            if !valid_hash(&hash) {
                return Err("Invalid commit ID".to_string());
            }
            let option = match mode.as_str() {
                "soft" => "--soft",
                "mixed" => "--mixed",
                "hard" => "--hard",
                _ => return Err("Invalid reset mode".to_string()),
            };
            git(&root, &["reset", option, &hash])?
        }
        RepoAction::Detach { hash } => {
            if !valid_hash(&hash) {
                return Err("Invalid commit ID".to_string());
            }
            git(&root, &["switch", "--detach", &hash])?
        }
        RepoAction::CreateTag { name, hash } => {
            validate_tag(&root, &name)?;
            if !valid_hash(&hash) {
                return Err("Invalid commit ID".to_string());
            }
            git(&root, &["tag", &name, &hash])?
        }
        RepoAction::DeleteTag { name } => {
            validate_tag(&root, &name)?;
            git(&root, &["tag", "-d", &name])?
        }
        RepoAction::ResolveFile { path, side } => {
            let path = literal_path(&path)?;
            if git(&root, &["ls-files", "-u", "--", &path])?
                .stdout
                .is_empty()
            {
                return Err("This file has no unresolved merge entries".to_string());
            }
            let option = match side.as_str() {
                "ours" => "--ours",
                "theirs" => "--theirs",
                _ => return Err("Invalid conflict side".to_string()),
            };
            git(&root, &["checkout", option, "--", &path])?;
            git(&root, &["add", "--", &path])?
        }
    };
    let stdout = text(&output.stdout);
    let stderr = text(&output.stderr);
    Ok(format!("{}{}", stdout, stderr).trim().to_string())
}

enum HunkAction {
    Stage,
    Unstage,
    Discard,
}

fn apply_hunk(
    repo: &Path,
    file: &str,
    index: usize,
    action: HunkAction,
    expected_diff: Option<&str>,
) -> Result<Output, String> {
    let path = literal_path(file)?;
    let diff_args = match action {
        HunkAction::Unstage => vec![
            "diff",
            "--cached",
            "--no-ext-diff",
            "--no-color",
            "--",
            path.as_str(),
        ],
        _ => vec!["diff", "--no-ext-diff", "--no-color", "--", path.as_str()],
    };
    let patch = git(repo, &diff_args)?.stdout;
    if patch.len() > MAX_DIFF_BYTES {
        return Err("Diff is too large for hunk actions".to_string());
    }
    let patch = text(&patch);
    if expected_diff.is_some_and(|expected| expected != patch) {
        return Err("Diff changed; reopen the file before discarding this hunk".to_string());
    }
    let starts: Vec<usize> = patch
        .match_indices("\n@@")
        .map(|(position, _)| position + 1)
        .collect();
    let start = *starts
        .get(index)
        .ok_or("Hunk no longer exists; refresh the diff")?;
    let end = starts.get(index + 1).copied().unwrap_or(patch.len());
    let selected = format!("{}{}", &patch[..start], &patch[start..end]);
    let args: &[&str] = match action {
        HunkAction::Stage => &["apply", "--cached", "--unidiff-zero", "-"],
        HunkAction::Unstage => &["apply", "--cached", "--reverse", "--unidiff-zero", "-"],
        HunkAction::Discard => &["apply", "--reverse", "--unidiff-zero", "-"],
    };
    git_with_input(repo, args, selected.as_bytes())
}

#[derive(Clone, Copy)]
enum LineAction {
    Stage,
    Unstage,
    Discard,
}

fn apply_lines(
    repo: &Path,
    file: &str,
    selected: &[usize],
    expected_diff: &str,
    action: LineAction,
) -> Result<Output, String> {
    let path = literal_path(file)?;
    let diff_args = match action {
        LineAction::Unstage => vec![
            "diff",
            "--cached",
            "--no-ext-diff",
            "--no-color",
            "--",
            path.as_str(),
        ],
        _ => vec!["diff", "--no-ext-diff", "--no-color", "--", path.as_str()],
    };
    let output = git(repo, &diff_args)?;
    if output.stdout.len() > MAX_DIFF_BYTES {
        return Err("Diff is too large for line actions".to_string());
    }
    let current_diff = text(&output.stdout);
    if current_diff != expected_diff {
        return Err("Diff changed; reopen the file before applying lines".to_string());
    }
    if current_diff.contains("\\ No newline at end of file") {
        return Err("Use the whole hunk when a file has no final newline".to_string());
    }
    let requested: HashSet<usize> = selected.iter().copied().collect();
    if requested.is_empty() {
        return Err("Select changed lines first".to_string());
    }
    let lines: Vec<&str> = current_diff.split('\n').collect();
    let hunks: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter_map(|(index, line)| line.starts_with("@@ ").then_some(index))
        .collect();
    let first_hunk = *hunks.first().ok_or("This diff has no selectable lines")?;
    if lines[..first_hunk].iter().any(|line| {
        [
            "new file mode",
            "deleted file mode",
            "rename from",
            "rename to",
            "copy from",
            "copy to",
            "old mode",
            "new mode",
        ]
        .iter()
        .any(|prefix| line.starts_with(prefix))
    }) {
        return Err("Use the whole file for this kind of change".to_string());
    }
    let mut patch = lines[..first_hunk].join("\n");
    patch.push('\n');
    let mut used = HashSet::new();
    let reverse = !matches!(action, LineAction::Stage);
    for (number, &start) in hunks.iter().enumerate() {
        let end = hunks.get(number + 1).copied().unwrap_or(lines.len());
        let mut body = String::new();
        let mut has_selected = false;
        for index in start + 1..end {
            let line = lines[index];
            if line.is_empty() && index + 1 == lines.len() {
                continue;
            }
            match line.as_bytes().first() {
                Some(b'+') => {
                    if requested.contains(&index) {
                        body.push_str(line);
                        body.push('\n');
                        used.insert(index);
                        has_selected = true;
                    } else if reverse {
                        body.push(' ');
                        body.push_str(&line[1..]);
                        body.push('\n');
                    }
                }
                Some(b'-') => {
                    if requested.contains(&index) {
                        body.push_str(line);
                        used.insert(index);
                        has_selected = true;
                        body.push('\n');
                    } else if !reverse {
                        body.push(' ');
                        body.push_str(&line[1..]);
                        body.push('\n');
                    }
                }
                Some(b' ') => {
                    body.push_str(line);
                    body.push('\n');
                }
                _ => return Err("Cannot stage lines from this diff format".to_string()),
            }
        }
        if has_selected {
            patch.push_str(lines[start]);
            patch.push('\n');
            patch.push_str(&body);
        }
    }
    if used.len() != requested.len() {
        return Err("Select only added or deleted lines".to_string());
    }
    let apply_args: &[&str] = match action {
        LineAction::Stage => &["apply", "--cached", "--recount", "--unidiff-zero", "-"],
        LineAction::Unstage => &[
            "apply",
            "--cached",
            "--reverse",
            "--recount",
            "--unidiff-zero",
            "-",
        ],
        LineAction::Discard => &["apply", "--reverse", "--recount", "--unidiff-zero", "-"],
    };
    git_with_input(repo, apply_args, patch.as_bytes())
}

fn force_push_with_lease(
    repo: &Path,
    cancel_token: Option<&str>,
    progress: &mut impl FnMut(&str),
) -> Result<Output, String> {
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
    git_with_progress(
        repo,
        &[
            "push",
            "--force-with-lease",
            "--no-follow-tags",
            "--progress",
            &remote,
            &format!("HEAD:{target}"),
        ],
        cancel_token,
        progress,
    )
}

fn push(
    repo: &Path,
    cancel_token: Option<&str>,
    progress: &mut impl FnMut(&str),
) -> Result<Output, String> {
    let branch = git(repo, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .map(|output| text(&output.stdout).trim().to_string())
        .map_err(|_| "Select a branch before pushing".to_string())?;
    validate_branch(repo, &branch)?;
    let remote_names = text(&git(repo, &["remote"])?.stdout);
    let remotes: Vec<&str> = remote_names.lines().collect();
    let configured = git(
        repo,
        &["config", "--get", &format!("branch.{branch}.remote")],
    )
    .ok()
    .map(|output| text(&output.stdout).trim().to_string())
    .unwrap_or_default();
    let remote = if remotes.contains(&configured.as_str()) {
        configured.as_str()
    } else if remotes.contains(&"origin") {
        "origin"
    } else if remotes.len() == 1 {
        remotes[0]
    } else {
        return Err("Choose one remote for this branch with 'git branch --set-upstream-to', or add an origin remote".to_string());
    };
    if remote.starts_with('-') {
        return Err("Invalid remote name".to_string());
    }
    let merge = git(
        repo,
        &["config", "--get", &format!("branch.{branch}.merge")],
    )
    .ok()
    .map(|output| text(&output.stdout).trim().to_string())
    .unwrap_or_default();
    let has_upstream = remote == configured
        && merge.starts_with("refs/heads/")
        && merge.len() > "refs/heads/".len();
    let target = if has_upstream {
        merge
    } else {
        format!("refs/heads/{branch}")
    };
    let refspec = format!("HEAD:{target}");
    if has_upstream {
        git_with_progress(
            repo,
            &["push", "--progress", "--no-follow-tags", remote, &refspec],
            cancel_token,
            progress,
        )
    } else {
        git_with_progress(
            repo,
            &[
                "push",
                "--set-upstream",
                "--progress",
                "--no-follow-tags",
                remote,
                &refspec,
            ],
            cancel_token,
            progress,
        )
    }
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

fn validate_tag(repo: &Path, name: &str) -> Result<(), String> {
    if name.is_empty() || name.starts_with('-') {
        return Err("Invalid tag name".to_string());
    }
    git(repo, &["check-ref-format", &format!("refs/tags/{name}")]).map(|_| ())
}
