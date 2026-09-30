//! Repository reads served in-process by gitoxide instead of `git` processes.
//!
//! Every refresh reads status, refs and history; starting processes for that dominated its time.
//! Each function returns the same data as the Git command it replaces in `lib.rs`.

use crate::worktree_revision;
use gitferry_proto::{CommitSummary, RefEntry, StatusEntry};
use gix::bstr::{BStr, BString, ByteSlice};
use gix::ObjectId;
use std::collections::{BTreeMap, BinaryHeap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

type Result<T> = std::result::Result<T, String>;

fn fail(error: impl std::fmt::Display) -> String {
    error.to_string()
}

/// Opens the repository at `root` for one request. A handle kept between requests would keep pack files
/// memory-mapped, which on Windows stops Git from deleting them during gc; opening takes about a millisecond.
pub fn open(root: &Path) -> Result<gix::Repository> {
    let mut repo = gix::open(root).map_err(fail)?;
    repo.object_cache_size_if_unset(4 * 1024 * 1024);
    Ok(repo)
}

pub struct Head {
    /// Short branch name, or "Detached HEAD" where `git symbolic-ref --short HEAD` fails.
    pub branch: String,
    /// Full name of the branch HEAD points to, even before its first commit.
    pub branch_ref: Option<BString>,
    pub id: Option<ObjectId>,
}

pub fn head(repo: &gix::Repository) -> Result<Head> {
    let name = repo.head_name().map_err(fail)?;
    Ok(Head {
        branch: name.as_ref().map_or_else(
            || "Detached HEAD".to_string(),
            |name| name.shorten().to_string(),
        ),
        branch_ref: name.map(|name| name.as_bstr().to_owned()),
        id: repo.head_id().ok().map(|id| id.detach()),
    })
}

/// Every reference under `refs/`, sorted by name like `git for-each-ref`.
pub fn raw_references(repo: &gix::Repository) -> Result<Vec<gix::refs::Reference>> {
    let platform = repo.references().map_err(fail)?;
    let mut references = Vec::new();
    for reference in platform.all().map_err(fail)? {
        references.push(reference.map_err(fail)?.inner);
    }
    references.sort_by(|a, b| a.name.as_bstr().cmp(b.name.as_bstr()));
    Ok(references)
}

/// Cheap fingerprint of every ref and its target, so callers can tell when refs moved.
pub fn refs_hash(references: &[gix::refs::Reference]) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    for reference in references {
        reference.name.as_bstr().hash(&mut hasher);
        match &reference.target {
            gix::refs::Target::Object(id) => id.hash(&mut hasher),
            gix::refs::Target::Symbolic(name) => name.as_bstr().hash(&mut hasher),
        }
    }
    format!("{:016x}", hasher.finish())
}

/// A reference resolved through symbolic refs (`target`) and annotated tags (`peeled`).
pub struct RefInfo {
    pub name: BString,
    pub target: Option<ObjectId>,
    pub peeled: Option<ObjectId>,
    /// `peeled` when it is a commit, the only kind history and decorations use.
    pub commit: Option<ObjectId>,
}

fn is_commit_namespace(name: &BStr) -> bool {
    // Branches and the stash always point at commits, so they skip the object lookup tags need.
    name.starts_with(b"refs/heads/") || name.starts_with(b"refs/remotes/") || name == "refs/stash"
}

pub fn resolve(repo: &gix::Repository, references: Vec<gix::refs::Reference>) -> Vec<RefInfo> {
    let direct: HashMap<BString, ObjectId> = references
        .iter()
        .filter_map(|reference| {
            let id = reference.target.try_id()?.to_owned();
            Some((reference.name.as_bstr().to_owned(), id))
        })
        .collect();
    references
        .into_iter()
        .map(|reference| {
            let name = reference.name.as_bstr().to_owned();
            let target = match &reference.target {
                gix::refs::Target::Object(id) => Some(*id),
                gix::refs::Target::Symbolic(to) => {
                    direct.get(to.as_bstr()).copied().or_else(|| {
                        let mut target = repo.try_find_reference(to.as_bstr()).ok()??;
                        target.peel_to_id().ok().map(|id| id.detach())
                    })
                }
            };
            let (peeled, commit) = match target {
                Some(id) if is_commit_namespace(name.as_ref()) => {
                    (reference.peeled.or(Some(id)), reference.peeled.or(Some(id)))
                }
                Some(id) => peel(repo, reference.peeled.unwrap_or(id)),
                None => (None, None),
            };
            RefInfo {
                name,
                target,
                peeled,
                commit,
            }
        })
        .collect()
}

/// Follows annotated tags from `id` to the first other object, reporting it and whether it is a commit.
fn peel(repo: &gix::Repository, id: ObjectId) -> (Option<ObjectId>, Option<ObjectId>) {
    let Ok(header) = repo.find_header(id) else {
        return (None, None);
    };
    let (id, kind) = if header.kind() == gix::object::Kind::Tag {
        match repo
            .find_object(id)
            .ok()
            .and_then(|object| object.peel_tags_to_end().ok())
        {
            Some(object) => (object.id, object.kind),
            None => return (None, None),
        }
    } else {
        (id, header.kind())
    };
    (Some(id), (kind == gix::object::Kind::Commit).then_some(id))
}

fn find<'a>(references: &'a [RefInfo], name: &BStr) -> Option<&'a RefInfo> {
    references
        .binary_search_by(|reference| reference.name.as_bstr().cmp(name))
        .ok()
        .map(|index| &references[index])
}

/// Branches, remote branches and tags like `git for-each-ref`, then stashes like `git stash list`.
pub fn ref_entries(repo: &gix::Repository, references: &[RefInfo], head: &Head) -> Vec<RefEntry> {
    let mut entries = Vec::new();
    for reference in references {
        let full = reference.name.as_bstr();
        let (kind, name) = if let Some(name) = full.strip_prefix(b"refs/heads/") {
            ("branch", name)
        } else if let Some(name) = full.strip_prefix(b"refs/remotes/") {
            ("remote", name)
        } else if let Some(name) = full.strip_prefix(b"refs/tags/") {
            ("tag", name)
        } else {
            continue;
        };
        let Some(target) = reference.target else {
            continue;
        };
        let (ahead, behind) = if kind == "branch" {
            tracking(repo, references, full, target)
        } else {
            (0, 0)
        };
        entries.push(RefEntry {
            name: name.to_str_lossy().into_owned(),
            kind: kind.to_string(),
            target: if kind == "tag" {
                reference.peeled.unwrap_or(target)
            } else {
                target
            }
            .to_string(),
            is_head: kind == "branch"
                && head.branch_ref.as_ref().map(|branch| branch.as_bstr()) == Some(full),
            ahead,
            behind,
        });
    }
    entries.extend(stash_entries(repo, references));
    entries
}

/// The tracking ref of `branch` as Git's `%(upstream)` resolves it, if one is configured.
fn upstream(repo: &gix::Repository, branch: &BStr) -> Option<BString> {
    let short = branch.strip_prefix(b"refs/heads/")?.as_bstr();
    let config = repo.config_snapshot();
    let file = config.plumbing();
    let remote = file.string_by("branch", Some(short), "remote")?;
    let merge = file.string_by("branch", Some(short), "merge")?;
    if remote == "." {
        // A local upstream is the merged branch itself.
        return Some(if merge.starts_with(b"refs/") {
            merge
        } else {
            format!("refs/heads/{merge}").into()
        });
    }
    let name: &gix::refs::FullNameRef = branch.try_into().ok()?;
    let tracking = repo
        .branch_remote_tracking_ref_name(name, gix::remote::Direction::Fetch)?
        .ok()?;
    Some(tracking.as_bstr().to_owned())
}

/// Commits on `branch` missing from its upstream and the reverse, like `%(upstream:track)`.
fn tracking(
    repo: &gix::Repository,
    references: &[RefInfo],
    branch: &BStr,
    local: ObjectId,
) -> (u32, u32) {
    let Some(upstream) = upstream(repo, branch)
        .and_then(|name| find(references, name.as_bstr()))
        .and_then(|reference| reference.commit)
    else {
        return (0, 0);
    };
    if upstream == local {
        return (0, 0);
    }
    let count = |from: ObjectId, hidden: ObjectId| {
        repo.rev_walk([from])
            .with_hidden([hidden])
            .all()
            .map(|walk| walk.take_while(|commit| commit.is_ok()).count() as u32)
            .unwrap_or(0)
    };
    (count(local, upstream), count(upstream, local))
}

/// Stashes newest first, named like `git stash list --format=%gd · %gs`.
fn stash_entries(repo: &gix::Repository, references: &[RefInfo]) -> Vec<RefEntry> {
    if find(references, "refs/stash".into()).is_none() {
        return Vec::new();
    }
    let Ok(log) = std::fs::read(repo.common_dir().join("logs").join("refs").join("stash")) else {
        return Vec::new();
    };
    let lines: Vec<&[u8]> = log.lines().filter(|line| !line.is_empty()).collect();
    lines
        .into_iter()
        .rev()
        .enumerate()
        .filter_map(|(number, line)| {
            // Reflog lines are "<old> <new> <committer> <time> <zone>\t<message>".
            let (fields, message) = line.split_once_str("\t").unwrap_or((line, b""));
            let target = fields.split(|byte| *byte == b' ').nth(1)?;
            Some(RefEntry {
                name: format!("stash@{{{number}}} · {}", message.trim().to_str_lossy()),
                kind: "stash".to_string(),
                target: target.to_str_lossy().into_owned(),
                is_head: false,
                ahead: 0,
                behind: 0,
            })
        })
        .collect()
}

pub fn remote_names(repo: &gix::Repository) -> Vec<String> {
    repo.remote_names()
        .into_iter()
        .map(|name| name.to_str_lossy().into_owned())
        .collect()
}

/// Ref labels per commit, formatted and ordered like `git log --format=%D`.
struct Decorations(HashMap<ObjectId, Vec<String>>);

impl Decorations {
    fn new(references: &[RefInfo], head: &Head) -> Self {
        // Git adds refs in name order and HEAD last, each in front of the commit's list; Git's default
        // decoration filter shows branches, remote branches, tags and the stash.
        let mut added: HashMap<ObjectId, Vec<&BStr>> = HashMap::new();
        for reference in references {
            let name = reference.name.as_bstr();
            let shown = name.starts_with(b"refs/heads/")
                || name.starts_with(b"refs/remotes/")
                || name.starts_with(b"refs/tags/")
                || name == "refs/stash";
            if let (true, Some(commit)) = (shown, reference.commit) {
                added.entry(commit).or_default().push(name);
            }
        }
        let head_label: &BStr = "HEAD".into();
        if let Some(id) = head.id {
            added.entry(id).or_default().push(head_label);
        }
        let short = |name: &BStr| {
            let name = name
                .strip_prefix(b"refs/heads/")
                .or_else(|| name.strip_prefix(b"refs/tags/"))
                .or_else(|| name.strip_prefix(b"refs/remotes/"))
                .unwrap_or(name);
            name.to_str_lossy().into_owned()
        };
        let labels = added
            .into_iter()
            .map(|(commit, mut names)| {
                names.reverse();
                // With HEAD on a branch at this commit, Git prints "HEAD -> branch" in HEAD's place.
                let current = head
                    .branch_ref
                    .as_ref()
                    .map(|branch| branch.as_bstr())
                    .filter(|branch| names.contains(&head_label) && names.contains(branch));
                let labels = names
                    .into_iter()
                    .filter(|name| Some(*name) != current)
                    .map(|name| match current {
                        _ if name.starts_with(b"refs/tags/") => format!("tag: {}", short(name)),
                        Some(branch) if name == head_label => format!("HEAD -> {}", short(branch)),
                        _ => short(name),
                    })
                    .collect();
                (commit, labels)
            })
            .collect();
        Decorations(labels)
    }
}

/// A commit waiting in the walk queue.
struct Queued {
    time: i64,
    order: u64,
    id: ObjectId,
    parents: Vec<ObjectId>,
    /// The raw commit when it was read from the object database; commit-graph entries leave it to be read if shown.
    data: Option<Vec<u8>>,
}

impl PartialEq for Queued {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other).is_eq()
    }
}

impl Eq for Queued {}

impl PartialOrd for Queued {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Queued {
    // Newest committer date first, and first queued first among equal dates.
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.time
            .cmp(&other.time)
            .then_with(|| other.order.cmp(&self.order))
    }
}

/// Git's default `git log` order: a queue by committer date that visits each commit once.
struct LogWalk<'a> {
    repo: &'a gix::Repository,
    /// Parents and dates come from the commit-graph file when it has the commit, as in Git.
    graph: Option<gix::commitgraph::Graph>,
    queue: BinaryHeap<Queued>,
    seen: HashSet<ObjectId>,
    shallow: HashSet<ObjectId>,
    order: u64,
}

impl<'a> LogWalk<'a> {
    fn new(
        repo: &'a gix::Repository,
        tips: impl IntoIterator<Item = ObjectId>,
        replaced: bool,
    ) -> Result<Self> {
        let shallow: HashSet<ObjectId> = repo
            .shallow_commits()
            .ok()
            .flatten()
            .map(|commits| commits.iter().copied().collect())
            .unwrap_or_default();
        // Like Git, trust the commit-graph only where no grafts or replacements change parents.
        let graph = if shallow.is_empty() && !replaced {
            repo.commit_graph_if_enabled().ok().flatten()
        } else {
            None
        };
        let mut walk = LogWalk {
            repo,
            graph,
            queue: BinaryHeap::new(),
            seen: HashSet::new(),
            shallow,
            order: 0,
        };
        for tip in tips {
            walk.push(tip)?;
        }
        Ok(walk)
    }

    fn push(&mut self, id: ObjectId) -> Result<()> {
        if !self.seen.insert(id) {
            return Ok(());
        }
        let from_graph = self.graph.as_ref().and_then(|graph| {
            let commit = graph.commit_by_id(id)?;
            let parents = commit
                .iter_parents()
                .map(|parent| parent.map(|position| graph.id_at(position).to_owned()))
                .collect::<std::result::Result<Vec<_>, _>>()
                .ok()?;
            Some((commit.committer_timestamp() as i64, parents))
        });
        let (time, parents, data) = match from_graph {
            Some((time, parents)) => (time, parents, None),
            None => {
                // Parents cut off by a shallow clone are absent; Git grafts them away the same way.
                let Some(object) = self.repo.try_find_object(id).map_err(fail)? else {
                    return Ok(());
                };
                if object.kind != gix::object::Kind::Commit {
                    return Ok(());
                }
                let data = object.detach().data;
                let (time, parents) = {
                    let commit = gix::objs::CommitRef::from_bytes(&data, self.repo.object_hash())
                        .map_err(fail)?;
                    let time = commit
                        .committer()
                        .map(|committer| committer.seconds())
                        .unwrap_or_default();
                    let parents = if self.shallow.contains(&id) {
                        Vec::new()
                    } else {
                        commit.parents().collect()
                    };
                    (time, parents)
                };
                (time, parents, Some(data))
            }
        };
        self.queue.push(Queued {
            time,
            order: self.order,
            id,
            parents,
            data,
        });
        self.order += 1;
        Ok(())
    }

    fn next(&mut self) -> Result<Option<Queued>> {
        let Some(commit) = self.queue.pop() else {
            return Ok(None);
        };
        for parent in &commit.parents {
            self.push(*parent)?;
        }
        Ok(Some(commit))
    }
}

/// The commit subject as Git's `%s` prints it: the first paragraph with its lines joined by spaces.
fn subject(message: &[u8]) -> String {
    let mut subject = Vec::new();
    for line in message.split(|byte| *byte == b'\n') {
        let line = line.trim_end_with(|char| matches!(char, ' ' | '\t' | '\r'));
        if line.is_empty() {
            if subject.is_empty() {
                continue;
            }
            break;
        }
        if !subject.is_empty() {
            subject.push(b' ');
        }
        subject.extend_from_slice(line);
    }
    String::from_utf8_lossy(&subject).into_owned()
}

/// Stash helper commits (index and untracked files) that no branch, remote branch or tag reaches.
/// The history hides them so a stash shows as one commit.
fn hidden_stash_helpers(
    repo: &gix::Repository,
    references: &[RefInfo],
    stash: ObjectId,
    head: Option<ObjectId>,
) -> Result<HashSet<ObjectId>> {
    let mut hidden = HashSet::new();
    let mut oldest = i64::MAX;
    for helper in repo.find_commit(stash).map_err(fail)?.parent_ids().skip(1) {
        let helper = helper.detach();
        if Some(helper) != head {
            oldest = oldest.min(
                repo.find_commit(helper)
                    .map_err(fail)?
                    .time()
                    .map_err(fail)?
                    .seconds,
            );
            hidden.insert(helper);
        }
    }
    if hidden.is_empty() {
        return Ok(hidden);
    }
    let tips: Vec<ObjectId> = references
        .iter()
        .filter(|reference| {
            let name = reference.name.as_bstr();
            name.starts_with(b"refs/heads/")
                || name.starts_with(b"refs/remotes/")
                || name.starts_with(b"refs/tags/")
        })
        .filter_map(|reference| reference.commit)
        .collect();
    // Commits that contain a helper were made after it, so only history newer than the oldest helper is
    // searched, allowing a day of clock skew; the untracked-files helper has no parents, so searching all
    // history for it would visit every commit.
    let walk = repo
        .rev_walk(tips)
        .sorting(gix::revision::walk::Sorting::ByCommitTimeCutoff {
            order: gix::traverse::commit::simple::CommitTimeOrder::NewestFirst,
            seconds: oldest - 24 * 60 * 60,
        })
        .all()
        .map_err(fail)?;
    for commit in walk {
        hidden.remove(&commit.map_err(fail)?.id);
        if hidden.is_empty() {
            break;
        }
    }
    Ok(hidden)
}

/// HEADs of the repository's other worktrees that are detached; `git log --all` includes them.
fn other_worktree_heads(repo: &gix::Repository) -> Vec<ObjectId> {
    let common = repo.common_dir();
    let current = repo.git_dir().canonicalize().ok();
    let mut dirs = vec![common.to_path_buf()];
    if let Ok(entries) = std::fs::read_dir(common.join("worktrees")) {
        dirs.extend(entries.flatten().map(|entry| entry.path()));
    }
    dirs.into_iter()
        .filter(|dir| dir.canonicalize().ok() != current)
        .filter_map(|dir| std::fs::read(dir.join("HEAD")).ok())
        .filter_map(|head| ObjectId::from_hex(head.trim()).ok())
        .collect()
}

/// One page of `git log HEAD --all` without stash helpers, and whether more commits follow.
pub fn log(
    repo: &gix::Repository,
    references: &[RefInfo],
    head: &Head,
    offset: usize,
    limit: usize,
) -> Result<(Vec<CommitSummary>, bool)> {
    let limit = limit.clamp(1, 200);
    let stash = find(references, "refs/stash".into()).and_then(|reference| reference.commit);
    let hidden = match stash {
        Some(stash) => hidden_stash_helpers(repo, references, stash, head.id)?,
        None => HashSet::new(),
    };
    // Git queues HEAD, then every ref in name order, then other worktrees' HEADs.
    let tips = head
        .id
        .into_iter()
        .chain(references.iter().filter_map(|reference| reference.commit))
        .chain(other_worktree_heads(repo));
    let replaced = references
        .iter()
        .any(|reference| reference.name.starts_with(b"refs/replace/"));
    let mut walk = LogWalk::new(repo, tips, replaced)?;
    let decorations = Decorations::new(references, head);
    let mut commits = Vec::new();
    let mut skipped = 0;
    while commits.len() <= limit {
        let Some(commit) = walk.next()? else {
            break;
        };
        if hidden.contains(&commit.id) {
            continue;
        }
        if skipped < offset {
            skipped += 1;
            continue;
        }
        let data = match commit.data {
            Some(data) => data,
            None => repo.find_object(commit.id).map_err(fail)?.detach().data,
        };
        let parsed = gix::objs::CommitRef::from_bytes(&data, repo.object_hash()).map_err(fail)?;
        let author = parsed.author().ok();
        let mut parents: Vec<String> = commit.parents.iter().map(ObjectId::to_string).collect();
        if stash == Some(commit.id) {
            parents.truncate(1);
        }
        commits.push(CommitSummary {
            hash: commit.id.to_string(),
            parents,
            subject: subject(parsed.message),
            author: author
                .map(|author| {
                    author
                        .name
                        .trim_end_with(char::is_whitespace)
                        .to_str_lossy()
                        .into_owned()
                })
                .unwrap_or_default(),
            timestamp: author.map(|author| author.seconds()).unwrap_or_default(),
            decorations: decorations.0.get(&commit.id).cloned().unwrap_or_default(),
        });
    }
    let has_more = commits.len() > limit;
    commits.truncate(limit);
    Ok((commits, has_more))
}

#[derive(Default)]
struct Change {
    index: Option<u8>,
    worktree: Option<u8>,
    source: Option<BString>,
    index_id: Option<ObjectId>,
    conflict: Option<&'static [u8; 2]>,
}

fn record_worktree_item(
    item: gix::status::index_worktree::Item,
    tracked: &mut BTreeMap<BString, Change>,
) {
    use gix::status::index_worktree::Item;
    use gix::status::plumbing::index_as_worktree::{Change as Worktree, Conflict, EntryStatus};
    match item {
        Item::Modification {
            rela_path, status, ..
        } => {
            let change = match status {
                EntryStatus::Conflict { summary, .. } => {
                    tracked.entry(rela_path).or_default().conflict = Some(match summary {
                        Conflict::BothDeleted => b"DD",
                        Conflict::AddedByUs => b"AU",
                        Conflict::DeletedByThem => b"UD",
                        Conflict::AddedByThem => b"UA",
                        Conflict::DeletedByUs => b"DU",
                        Conflict::BothAdded => b"AA",
                        Conflict::BothModified => b"UU",
                    });
                    return;
                }
                EntryStatus::Change(Worktree::Removed) => b'D',
                EntryStatus::Change(Worktree::Type { .. }) => b'T',
                EntryStatus::Change(Worktree::SubmoduleModification(status)) => {
                    if status.is_dirty() == Some(false) {
                        return;
                    }
                    b'M'
                }
                EntryStatus::Change(Worktree::Modification { .. }) => b'M',
                EntryStatus::IntentToAdd => b'A',
                EntryStatus::NeedsUpdate(_) => return,
            };
            tracked.entry(rela_path).or_default().worktree = Some(change);
        }
        // Untracked files come from `untracked_files()`, and rename tracking is off.
        Item::DirectoryContents { .. } | Item::Rewrite { .. } => {}
    }
}

/// Directories this many levels deep are walked on worker threads instead of the first walk.
const SPLIT_DEPTH: usize = 2;

/// Collects untracked paths from a gix-dir walk, optionally handing directories at [`SPLIT_DEPTH`] to other threads.
struct UntrackedCollector<'a> {
    untracked: &'a mut Vec<BString>,
    deferred: Option<&'a mut Vec<BString>>,
}

impl gix::dir::walk::Delegate for UntrackedCollector<'_> {
    fn emit(
        &mut self,
        entry: gix::dir::EntryRef<'_>,
        _collapsed_directory_status: Option<gix::dir::entry::Status>,
    ) -> gix::dir::walk::Action {
        // A deferred directory is emitted right after `can_recurse` declines it; its walk reports its contents.
        let deferred = self.deferred.as_ref().is_some_and(|dirs| {
            dirs.last()
                .is_some_and(|dir| dir.as_bstr() == entry.rela_path.as_ref())
        });
        if entry.status == gix::dir::entry::Status::Untracked && !deferred {
            let mut path = entry.rela_path.into_owned();
            // Git lists a nested repository as its directory.
            if matches!(
                entry.disk_kind,
                Some(gix::dir::entry::Kind::Repository | gix::dir::entry::Kind::Directory)
            ) {
                path.push(b'/');
            }
            self.untracked.push(path);
        }
        std::ops::ControlFlow::Continue(())
    }

    fn can_recurse(
        &mut self,
        entry: gix::dir::EntryRef<'_>,
        for_deletion: Option<gix::dir::walk::ForDeletionMode>,
        worktree_root_is_repository: bool,
    ) -> bool {
        let recurse = entry.status.can_recurse(
            entry.disk_kind,
            entry.pathspec_match,
            for_deletion,
            worktree_root_is_repository,
        );
        match &mut self.deferred {
            Some(dirs)
                if recurse
                    && entry.rela_path.split(|byte| *byte == b'/').count() >= SPLIT_DEPTH =>
            {
                dirs.push(entry.rela_path.into_owned());
                false
            }
            _ => recurse,
        }
    }
}

fn no_pathspec_attributes(
    _: &BStr,
    _: gix::pathspec::attributes::glob::pattern::Case,
    _: bool,
    _: &mut gix::pathspec::attributes::search::Outcome,
) -> bool {
    false
}

/// One thread's gix-dir setup, reused for every directory that thread walks.
struct UntrackedWalk<'repo> {
    repo: &'repo gix::Repository,
    workdir: PathBuf,
    excludes: gix::AttributeStack<'repo>,
    pathspec: gix::pathspec::Search,
    git_dir_realpath: PathBuf,
    options: gix::dir::walk::Options<'static>,
}

impl<'repo> UntrackedWalk<'repo> {
    fn new(repo: &'repo gix::Repository, index: &gix::index::State) -> Result<Self> {
        let workdir = repo
            .workdir()
            .ok_or("The repository has no working tree")?
            .to_owned();
        Ok(UntrackedWalk {
            excludes: repo
                .excludes(
                    index,
                    None,
                    gix::worktree::stack::state::ignore::Source::WorktreeThenIdMappingIfNotSkipped,
                )
                .map_err(fail)?,
            pathspec: gix::pathspec::Search::from_specs(None, None, &workdir).map_err(fail)?,
            git_dir_realpath: gix::path::realpath_opts(
                repo.git_dir(),
                repo.current_dir(),
                gix::path::realpath::MAX_SYMLINKS,
            )
            .map_err(fail)?,
            options: repo
                .dirwalk_options()
                .map_err(fail)?
                .emit_untracked(gix::dir::walk::EmissionMode::Matching)
                // Git for Windows treats directory junctions as directories when matching ignore patterns.
                .symlinks_to_directories_are_ignored_like_directories(cfg!(windows))
                .into(),
            workdir,
            repo,
        })
    }

    /// Collects untracked paths under `start`, or the whole working tree.
    fn walk(
        &mut self,
        index: &gix::index::State,
        icase: Option<&gix::index::AccelerateLookup<'_>>,
        start: Option<&BStr>,
        untracked: &mut Vec<BString>,
        deferred: Option<&mut Vec<BString>>,
    ) -> Result<()> {
        let root = match start {
            Some(dir) => self.workdir.join(gix::path::from_bstr(dir)),
            None => self.workdir.clone(),
        };
        gix::dir::walk(
            &self.workdir,
            gix::dir::walk::Context {
                should_interrupt: None,
                git_dir_realpath: &self.git_dir_realpath,
                current_dir: self.repo.current_dir(),
                index,
                ignore_case_index_lookup: icase,
                pathspec: &mut self.pathspec,
                pathspec_attributes: &mut no_pathspec_attributes,
                excludes: Some(&mut self.excludes),
                objects: &self.repo.objects,
                explicit_traversal_root: Some(&root),
            },
            self.options,
            &mut UntrackedCollector {
                untracked,
                deferred,
            },
        )
        .map_err(fail)?;
        Ok(())
    }
}

/// Untracked files like `git status --untracked-files=all`.
///
/// gix-dir classifies every entry as `gix status` does; only the traversal is split across threads, because
/// reading directories one after another dominated status on large working trees.
fn untracked_files(
    shared: &gix::ThreadSafeRepository,
    index: &gix::index::State,
) -> Result<Vec<BString>> {
    let repo = shared.to_thread_local();
    let icase = repo
        .filesystem_options()
        .map_err(fail)?
        .ignore_case
        .then(|| index.prepare_icase_backing());
    let mut untracked = Vec::new();
    let mut deferred = Vec::new();
    UntrackedWalk::new(&repo, index)?.walk(
        index,
        icase.as_ref(),
        None,
        &mut untracked,
        Some(&mut deferred),
    )?;
    let threads = std::thread::available_parallelism()
        .map_or(4, usize::from)
        .min(8)
        .min(deferred.len());
    let queue = Mutex::new(deferred);
    std::thread::scope(|scope| {
        let workers: Vec<_> = (0..threads)
            .map(|_| {
                scope.spawn(|| -> Result<Vec<BString>> {
                    let repo = shared.to_thread_local();
                    let mut walk = UntrackedWalk::new(&repo, index)?;
                    let mut found = Vec::new();
                    loop {
                        let next = queue.lock().map_err(|_| "Walk queue failed")?.pop();
                        let Some(dir) = next else {
                            return Ok(found);
                        };
                        walk.walk(index, icase.as_ref(), Some(dir.as_bstr()), &mut found, None)?;
                    }
                })
            })
            .collect();
        for worker in workers {
            untracked.extend(
                worker
                    .join()
                    .map_err(|_| "Untracked file walk failed".to_string())??,
            );
        }
        Ok::<_, String>(())
    })?;
    Ok(untracked)
}

fn record_tree_change(change: gix::diff::index::Change, tracked: &mut BTreeMap<BString, Change>) {
    use gix::diff::index::ChangeRef;
    let kind = |mode: gix::index::entry::Mode| {
        if mode == gix::index::entry::Mode::SYMLINK {
            1
        } else if mode == gix::index::entry::Mode::COMMIT {
            2
        } else {
            0
        }
    };
    let (location, code, id, source) = match change {
        ChangeRef::Addition { location, id, .. } => (location, b'A', Some(id.into_owned()), None),
        ChangeRef::Deletion { location, .. } => (location, b'D', None, None),
        ChangeRef::Modification {
            location,
            previous_entry_mode,
            entry_mode,
            id,
            ..
        } => {
            let code = if kind(previous_entry_mode) == kind(entry_mode) {
                b'M'
            } else {
                b'T'
            };
            (location, code, Some(id.into_owned()), None)
        }
        ChangeRef::Rewrite {
            source_location,
            location,
            id,
            copy,
            ..
        } => (
            location,
            if copy { b'C' } else { b'R' },
            Some(id.into_owned()),
            Some(source_location.into_owned()),
        ),
    };
    let change = tracked.entry(location.into_owned()).or_default();
    change.index = Some(code);
    change.index_id = id;
    change.source = source;
}

/// Working-tree changes like `git status --porcelain=v1 --untracked-files=all`, with the staged blob ids
/// `git diff --cached --raw` reports.
pub fn status(repo: &gix::Repository, root: &Path) -> Result<Vec<StatusEntry>> {
    let mut tracked: BTreeMap<BString, Change> = BTreeMap::new();
    let index = repo.index_or_empty().map_err(fail)?;
    let head_tree = repo.head_tree_id_or_empty().map_err(fail)?.detach();
    // A valid cached tree equal to HEAD's tree means nothing is staged, so the HEAD-to-index diff is skipped as Git does.
    let nothing_staged = index
        .tree()
        .is_some_and(|tree| tree.num_entries.is_some() && tree.id == head_tree);
    let platform = repo
        .status(gix::progress::Discard)
        .map_err(fail)?
        .index(gix::worktree::IndexPersistedOrInMemory::Persisted(
            index.clone(),
        ))
        .untracked_files(gix::status::UntrackedFiles::None)
        .index_worktree_rewrites(None)
        .index_worktree_submodules(gix::status::Submodule::AsConfigured { check_dirty: true });
    let shared = repo.clone().into_sync();
    let mut untracked = std::thread::scope(|scope| {
        let untracked = scope.spawn(|| untracked_files(&shared, &index));
        if nothing_staged {
            for item in platform
                .into_index_worktree_iter(Vec::<BString>::new())
                .map_err(fail)?
            {
                record_worktree_item(item.map_err(fail)?, &mut tracked);
            }
        } else {
            for item in platform.into_iter(Vec::<BString>::new()).map_err(fail)? {
                match item.map_err(fail)? {
                    gix::status::Item::IndexWorktree(item) => {
                        record_worktree_item(item, &mut tracked)
                    }
                    gix::status::Item::TreeIndex(change) => {
                        record_tree_change(change, &mut tracked)
                    }
                }
            }
        }
        untracked
            .join()
            .map_err(|_| "Untracked file walk failed".to_string())?
    })?;
    let null = ObjectId::null(repo.object_hash()).to_string();
    let mut entries = Vec::new();
    for (path, change) in tracked {
        let (index, worktree) = match change.conflict {
            Some([index, worktree]) => (*index, *worktree),
            None => (
                change.index.unwrap_or(b' '),
                change.worktree.unwrap_or(b' '),
            ),
        };
        let path = path.to_str_lossy().into_owned();
        entries.push(StatusEntry {
            worktree_revision: worktree_revision(root, &path),
            index_revision: if index == b' ' {
                String::new()
            } else if change.conflict.is_some() || index == b'D' {
                null.clone()
            } else {
                change.index_id.map(|id| id.to_string()).unwrap_or_default()
            },
            path,
            index: char::from(index).to_string(),
            worktree: char::from(worktree).to_string(),
            original_path: change
                .source
                .filter(|_| change.conflict.is_none())
                .map(|source| source.to_str_lossy().into_owned()),
        });
    }
    untracked.sort();
    entries.extend(untracked.into_iter().map(|path| {
        let path = path.to_str_lossy().into_owned();
        StatusEntry {
            worktree_revision: worktree_revision(root, &path),
            path,
            index: "?".to_string(),
            worktree: "?".to_string(),
            original_path: None,
            index_revision: String::new(),
        }
    }));
    Ok(entries)
}
