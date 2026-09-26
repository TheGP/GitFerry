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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoState {
    pub branch: String,
    pub head: Option<String>,
    pub status: Vec<StatusEntry>,
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
    },
    Action {
        path: String,
        action: RepoAction,
    },
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum Response {
    Snapshot(RepoSnapshot),
    State(RepoState),
    Search(SearchResult),
    CommitDetails(CommitDetails),
    Diff(DiffResult),
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
