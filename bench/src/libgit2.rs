//! The same reads through libgit2, for comparison only; GitFerry does not ship it.

use git2::{Oid, Repository, Sort, Status, StatusOptions};
use std::collections::{HashMap, HashSet};
use std::path::Path;

type Result<T> = std::result::Result<T, String>;

fn fail(error: git2::Error) -> String {
    error.message().to_string()
}

pub fn open(root: &Path) -> Result<Repository> {
    Repository::open(root).map_err(fail)
}

/// Current branch name (or "Detached HEAD") and HEAD's commit.
pub fn head(repo: &Repository) -> Result<(String, Option<Oid>)> {
    let head = repo.find_reference("HEAD").map_err(fail)?;
    let branch = match head.symbolic_target().map_err(fail)? {
        Some(target) => target
            .strip_prefix("refs/heads/")
            .unwrap_or(target)
            .to_string(),
        None => "Detached HEAD".to_string(),
    };
    Ok((branch, head.resolve().ok().and_then(|head| head.target())))
}

/// Porcelain-style two-letter codes per path.
pub fn status(repo: &Repository) -> Result<Vec<(String, String)>> {
    let mut options = StatusOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .renames_head_to_index(true)
        .include_ignored(false);
    let statuses = repo.statuses(Some(&mut options)).map_err(fail)?;
    let mut entries = Vec::new();
    for entry in statuses.iter() {
        let status = entry.status();
        let code = |pairs: &[(Status, char)]| {
            pairs
                .iter()
                .find(|(flag, _)| status.contains(*flag))
                .map_or(' ', |(_, code)| *code)
        };
        let (index, worktree) = if status.contains(Status::CONFLICTED) {
            ('U', 'U')
        } else if status.contains(Status::WT_NEW)
            && !status.intersects(Status::INDEX_NEW | Status::INDEX_MODIFIED)
        {
            ('?', '?')
        } else {
            (
                code(&[
                    (Status::INDEX_NEW, 'A'),
                    (Status::INDEX_MODIFIED, 'M'),
                    (Status::INDEX_DELETED, 'D'),
                    (Status::INDEX_RENAMED, 'R'),
                    (Status::INDEX_TYPECHANGE, 'T'),
                ]),
                code(&[
                    (Status::WT_MODIFIED, 'M'),
                    (Status::WT_DELETED, 'D'),
                    (Status::WT_TYPECHANGE, 'T'),
                    (Status::WT_RENAMED, 'R'),
                ]),
            )
        };
        let path = entry
            .head_to_index()
            .and_then(|delta| {
                delta
                    .new_file()
                    .path()
                    .map(|path| path.to_string_lossy().into_owned())
            })
            .or_else(|| entry.path().ok().map(str::to_string))
            .unwrap_or_default();
        entries.push((path, format!("{index}{worktree}")));
    }
    Ok(entries)
}

pub struct Ref {
    pub name: String,
    pub target: Oid,
    pub ahead: usize,
    pub behind: usize,
}

/// Branches, remote branches and tags with ahead/behind counts, plus stashes.
pub fn refs(repo: &Repository) -> Result<Vec<Ref>> {
    let mut entries = Vec::new();
    for reference in repo.references().map_err(fail)? {
        let reference = reference.map_err(fail)?;
        let Ok(name) = reference.name().map(str::to_string) else {
            continue;
        };
        if !(name.starts_with("refs/heads/")
            || name.starts_with("refs/remotes/")
            || name.starts_with("refs/tags/"))
        {
            continue;
        }
        let Ok(target) = reference.peel_to_commit().map(|commit| commit.id()) else {
            continue;
        };
        let (mut ahead, mut behind) = (0, 0);
        if name.starts_with("refs/heads/") {
            if let Some(upstream) = repo
                .branch_upstream_name(&name)
                .ok()
                .and_then(|upstream| upstream.as_str().ok().map(str::to_string))
                .and_then(|upstream| repo.refname_to_id(&upstream).ok())
            {
                (ahead, behind) = repo.graph_ahead_behind(target, upstream).map_err(fail)?;
            }
        }
        entries.push(Ref {
            name,
            target,
            ahead,
            behind,
        });
    }
    if let Ok(log) = repo.reflog("refs/stash") {
        for (number, entry) in log.iter().enumerate() {
            entries.push(Ref {
                name: format!(
                    "stash@{{{number}}} · {}",
                    entry.message().ok().flatten().unwrap_or("")
                ),
                target: entry.id_new(),
                ahead: 0,
                behind: 0,
            });
        }
    }
    Ok(entries)
}

pub struct Commit {
    pub hash: String,
    pub decorations: Vec<String>,
}

/// A page of history from HEAD and every ref, newest committer date first, with ref labels.
pub fn log(repo: &Repository, offset: usize, limit: usize) -> Result<Vec<Commit>> {
    let mut walk = repo.revwalk().map_err(fail)?;
    walk.set_sorting(Sort::TIME).map_err(fail)?;
    let mut labels: HashMap<Oid, Vec<String>> = HashMap::new();
    if let Ok(head) = repo.head().and_then(|head| head.peel_to_commit()) {
        walk.push(head.id()).map_err(fail)?;
        labels
            .entry(head.id())
            .or_default()
            .push("HEAD".to_string());
    }
    for reference in repo.references().map_err(fail)? {
        let reference = reference.map_err(fail)?;
        let Ok(commit) = reference.peel_to_commit() else {
            continue;
        };
        walk.push(commit.id()).map_err(fail)?;
        if let Ok(name) = reference.shorthand() {
            labels
                .entry(commit.id())
                .or_default()
                .push(name.to_string());
        }
    }
    let mut commits = Vec::new();
    for id in walk.skip(offset).take(limit + 1) {
        let id = id.map_err(fail)?;
        let commit = repo.find_commit(id).map_err(fail)?;
        // Read what the history row shows, like the other backends do.
        let _ = (
            commit.summary(),
            commit.author().name().map(str::len),
            commit.time(),
            commit.parent_ids().count(),
        );
        commits.push(Commit {
            hash: id.to_string(),
            decorations: labels.get(&id).cloned().unwrap_or_default(),
        });
    }
    Ok(commits)
}

/// What the agent's `state` returns: branch, HEAD, status and a refs fingerprint.
pub fn state(repo: &Repository) -> Result<u64> {
    use std::hash::{Hash, Hasher};
    head(repo)?;
    status(repo)?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    for reference in repo.references().map_err(fail)? {
        let reference = reference.map_err(fail)?;
        reference.name().ok().hash(&mut hasher);
        reference
            .target()
            .map(|id| id.to_string())
            .hash(&mut hasher);
    }
    Ok(hasher.finish())
}

/// What the agent's `snapshot` returns: `state` plus refs, remotes and the first history page.
pub fn snapshot(repo: &Repository) -> Result<()> {
    head(repo)?;
    status(repo)?;
    refs(repo)?;
    repo.remotes().map_err(fail)?;
    log(repo, 0, 100)?;
    Ok(())
}

/// Describes how libgit2's data differs from the Git CLI's snapshot JSON.
pub fn compare(repo: &Repository, git: &serde_json::Value) -> String {
    let mut notes = Vec::new();
    match status(repo) {
        Ok(entries) => {
            let ours: HashSet<(String, String)> = entries.into_iter().collect();
            let theirs: HashSet<(String, String)> = git["status"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|entry| {
                    let code = format!(
                        "{}{}",
                        entry["index"].as_str().unwrap_or(""),
                        entry["worktree"].as_str().unwrap_or("")
                    );
                    (entry["path"].as_str().unwrap_or("").to_string(), code)
                })
                .collect();
            notes.push(if ours == theirs {
                "status same".to_string()
            } else {
                format!(
                    "status differs in {} paths",
                    ours.symmetric_difference(&theirs).count()
                )
            });
        }
        Err(error) => notes.push(format!("status failed: {error}")),
    }
    match refs(repo) {
        Ok(entries) => {
            let tracking = |name: &str, target: &str, ahead: u64, behind: u64| {
                format!("{name} {target} {ahead} {behind}")
            };
            let ours: HashSet<String> = entries
                .iter()
                .filter(|entry| entry.name.starts_with("refs/heads/"))
                .map(|entry| {
                    tracking(
                        &entry.name["refs/heads/".len()..],
                        &entry.target.to_string(),
                        entry.ahead as u64,
                        entry.behind as u64,
                    )
                })
                .collect();
            let theirs: HashSet<String> = git["refs"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|entry| entry["kind"] == "branch")
                .map(|entry| {
                    tracking(
                        entry["name"].as_str().unwrap_or(""),
                        entry["target"].as_str().unwrap_or(""),
                        entry["ahead"].as_u64().unwrap_or(0),
                        entry["behind"].as_u64().unwrap_or(0),
                    )
                })
                .collect();
            notes.push(if ours == theirs {
                "branch ahead/behind same".to_string()
            } else {
                format!(
                    "{} branches differ",
                    ours.symmetric_difference(&theirs).count()
                )
            });
        }
        Err(error) => notes.push(format!("refs failed: {error}")),
    }
    match log(repo, 0, 100) {
        Ok(commits) => {
            let ours: Vec<&str> = commits
                .iter()
                .take(100)
                .map(|commit| commit.hash.as_str())
                .collect();
            let theirs: Vec<&str> = git["commits"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|commit| commit["hash"].as_str())
                .collect();
            let same_set =
                ours.iter().collect::<HashSet<_>>() == theirs.iter().collect::<HashSet<_>>();
            let labeled = commits
                .iter()
                .take(100)
                .filter(|commit| !commit.decorations.is_empty())
                .count();
            let git_labeled = git["commits"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|commit| {
                    commit["decorations"]
                        .as_array()
                        .is_some_and(|labels| !labels.is_empty())
                })
                .count();
            if labeled != git_labeled {
                notes.push(format!("labels on {labeled} commits vs {git_labeled}"));
            }
            notes.push(if ours == theirs {
                "history order same".to_string()
            } else if same_set {
                "history has the same commits in a different order".to_string()
            } else {
                "history page differs (includes stash helper commits)".to_string()
            });
        }
        Err(error) => notes.push(format!("history failed: {error}")),
    }
    notes.join(", ")
}
