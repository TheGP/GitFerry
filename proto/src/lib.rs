use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoSnapshot {
    pub path: String,
    pub name: String,
    pub branch: String,
    pub head: Option<String>,
    pub status: Vec<StatusEntry>,
    pub refs: Vec<RefEntry>,
    #[serde(default)]
    pub remotes: Vec<String>,
    pub commits: Vec<CommitSummary>,
    pub has_more: bool,
    pub operation: Option<String>,
    #[serde(default)]
    pub rebase_edit_pause: bool,
    /// Fingerprint of branch, remote and tag targets; changes when any ref moves.
    #[serde(default)]
    pub refs_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoState {
    pub branch: String,
    pub head: Option<String>,
    pub status: Vec<StatusEntry>,
    pub operation: Option<String>,
    #[serde(default)]
    pub rebase_edit_pause: bool,
    #[serde(default)]
    pub refs_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub commits: Vec<CommitSummary>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusEntry {
    pub path: String,
    pub index: String,
    pub worktree: String,
    pub original_path: Option<String>,
    #[serde(default)]
    pub worktree_revision: String,
    #[serde(default)]
    pub index_revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefEntry {
    pub name: String,
    pub kind: String,
    pub target: String,
    pub is_head: bool,
    #[serde(default)]
    pub ahead: u32,
    #[serde(default)]
    pub behind: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitSummary {
    pub hash: String,
    pub parents: Vec<String>,
    pub subject: String,
    pub author: String,
    pub timestamp: i64,
    pub decorations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetails {
    pub hash: String,
    pub subject: String,
    pub body: String,
    pub author: String,
    pub author_email: String,
    pub timestamp: i64,
    pub parents: Vec<String>,
    pub files: Vec<ChangedFile>,
    #[serde(default)]
    pub tree: String,
    /// Total line counts; `None` from older agents that do not report them.
    #[serde(default)]
    pub additions: Option<u64>,
    #[serde(default)]
    pub deletions: Option<u64>,
}

/// What `head` changes relative to its merge base with `base`, like a pull request diff.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareResult {
    pub merge_base: String,
    pub commits: u64,
    pub files: Vec<ChangedFile>,
    pub additions: u64,
    pub deletions: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    pub status: String,
    /// Line counts from `git diff --numstat`; `None` for binary files.
    #[serde(default)]
    pub additions: Option<u64>,
    #[serde(default)]
    pub deletions: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffResult {
    pub text: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditableFile {
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedFile {
    pub staged: bool,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHistoryEntry {
    pub hash: String,
    pub subject: String,
    pub author: String,
    pub timestamp: i64,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHistoryResult {
    pub commits: Vec<FileHistoryEntry>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameLine {
    pub line: usize,
    pub hash: String,
    pub author: String,
    pub timestamp: i64,
    pub summary: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameResult {
    pub lines: Vec<BlameLine>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseCommit {
    pub hash: String,
    pub subject: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseStep {
    pub hash: String,
    pub action: String,
    #[serde(default)]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum RepoAction {
    StageAll,
    StageFile {
        path: String,
    },
    StageHunk {
        path: String,
        index: usize,
        reverse: bool,
    },
    DiscardHunk {
        path: String,
        index: usize,
        diff: String,
    },
    StageLines {
        path: String,
        lines: Vec<usize>,
        diff: String,
    },
    UnstageLines {
        path: String,
        lines: Vec<usize>,
        diff: String,
    },
    DiscardLines {
        path: String,
        lines: Vec<usize>,
        diff: String,
    },
    UnstageFile {
        path: String,
    },
    DiscardFile {
        path: String,
    },
    StageFiles {
        paths: Vec<String>,
    },
    UnstageFiles {
        paths: Vec<String>,
    },
    DiscardFiles {
        paths: Vec<String>,
    },
    /// Deletes files only if Git reports them as untracked.
    DeleteUntracked {
        paths: Vec<String>,
    },
    Commit {
        message: String,
        amend: bool,
    },
    Fetch,
    Pull,
    PullMerge,
    PullRebase,
    Push,
    ForcePushWithLease,
    Checkout {
        branch: String,
    },
    TrackRemoteBranch {
        remote: String,
        branch: String,
    },
    CreateBranch {
        branch: String,
    },
    DeleteBranch {
        branch: String,
    },
    ForceDeleteBranch {
        branch: String,
    },
    RenameBranch {
        branch: String,
        new_name: String,
    },
    PushBranch {
        remote: String,
        branch: String,
    },
    DeleteRemoteBranch {
        remote: String,
        branch: String,
    },
    Stash {
        message: String,
    },
    ApplyStash {
        hash: String,
    },
    PopStash {
        hash: String,
    },
    Merge {
        branch: String,
    },
    Rebase {
        branch: String,
    },
    InteractiveRebase {
        branch: String,
        onto: String,
        steps: Vec<RebaseStep>,
    },
    AmendNoEdit,
    AbortOperation,
    ContinueOperation,
    CherryPick {
        hash: String,
    },
    Revert {
        hash: String,
    },
    Reset {
        hash: String,
        mode: String,
    },
    Detach {
        hash: String,
    },
    CreateTag {
        name: String,
        hash: String,
    },
    DeleteTag {
        name: String,
    },
    PushTag {
        remote: String,
        name: String,
    },
    DeleteRemoteTag {
        remote: String,
        name: String,
    },
    ResolveFile {
        path: String,
        side: String,
    },
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "method", content = "params", rename_all = "snake_case")]
pub enum Request {
    Snapshot {
        path: String,
        offset: usize,
        limit: usize,
    },
    State {
        path: String,
    },
    Watch {
        path: String,
        timeout_ms: u64,
    },
    RebasePlan {
        path: String,
        onto: String,
    },
    Search {
        path: String,
        query: String,
        offset: usize,
        limit: usize,
    },
    CommitDetails {
        path: String,
        hash: String,
    },
    Compare {
        path: String,
        base: String,
        head: String,
    },
    FileHistory {
        path: String,
        file: String,
        revision: String,
        offset: usize,
        limit: usize,
    },
    Blame {
        path: String,
        file: String,
        revision: String,
        start_line: usize,
        limit: usize,
    },
    TrackedFiles {
        path: String,
        query: String,
        limit: usize,
    },
    Diff {
        path: String,
        target: String,
        file: String,
        #[serde(default)]
        ignore_whitespace: bool,
        /// Whole file as one hunk instead of three lines of context.
        #[serde(default)]
        full_context: bool,
    },
    ReadFile {
        path: String,
        file: String,
    },
    SaveFile {
        path: String,
        file: String,
        content: String,
        expected_content: String,
        stage: bool,
    },
    Action {
        path: String,
        action: RepoAction,
        #[serde(default)]
        cancel_token: Option<String>,
    },
    Cancel {
        token: String,
    },
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum Response {
    Snapshot(RepoSnapshot),
    State(RepoState),
    Changed(bool),
    RebasePlan(Vec<RebaseCommit>),
    Search(SearchResult),
    CommitDetails(CommitDetails),
    Compare(CompareResult),
    FileHistory(FileHistoryResult),
    Blame(BlameResult),
    TrackedFiles(Vec<String>),
    Diff(DiffResult),
    EditableFile(EditableFile),
    SavedFile(SavedFile),
    Progress(String),
    Action(String),
    Error(String),
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RpcRequest {
    pub id: u64,
    #[serde(flatten)]
    pub request: Request,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RpcResponse {
    pub id: u64,
    #[serde(flatten)]
    pub response: Response,
}
