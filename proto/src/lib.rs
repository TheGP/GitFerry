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
    pub commits: Vec<CommitSummary>,
    pub has_more: bool,
    pub operation: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoState {
    pub branch: String,
    pub head: Option<String>,
    pub status: Vec<StatusEntry>,
    pub operation: Option<String>,
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffResult {
    pub text: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseCommit {
    pub hash: String,
    pub subject: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseStep {
    pub hash: String,
    pub action: String,
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
    CreateBranch {
        branch: String,
    },
    DeleteBranch {
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
    Diff {
        path: String,
        target: String,
        file: String,
        #[serde(default)]
        ignore_whitespace: bool,
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
    Diff(DiffResult),
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
