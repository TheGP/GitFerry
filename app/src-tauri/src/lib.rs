use gitferry_agent::{
    action_with_progress, blame, cancel_operation, commit_details, diff_with_options, file_history,
    rebase_plan, search, snapshot, state, tracked_files, watch,
};
use gitferry_proto::{
    BlameResult, CommitDetails, DiffResult, FileHistoryResult, RebaseCommit, RepoAction,
    RepoSnapshot, RepoState, Request, Response, SearchResult,
};
use tauri::{Emitter, Manager};

mod editor;
mod remote;

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GitProgress {
    path: String,
    message: String,
}

fn report_progress(app: &tauri::AppHandle, path: &str, message: &str) {
    let _ = app.emit(
        "git-progress",
        GitProgress {
            path: path.to_string(),
            message: message.to_string(),
        },
    );
}

fn agent_resources(app: &tauri::AppHandle) -> std::path::PathBuf {
    let bundled = app.path().resource_dir().unwrap_or_default();
    if bundled.join("gitferry-agent-linux-x64").is_file() {
        bundled
    } else {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources")
    }
}

#[tauri::command]
async fn repo_snapshot(
    app: tauri::AppHandle,
    path: String,
    offset: usize,
) -> Result<RepoSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if path.starts_with("ssh://") {
            let (_, remote_path) = remote::parse_uri(&path)?;
            let response = app.state::<remote::RemoteManager>().call(
                &path,
                &agent_resources(&app),
                Request::Snapshot {
                    path: remote_path.to_string(),
                    offset,
                    limit: 100,
                },
            )?;
            match response {
                Response::Snapshot(mut repo) => {
                    repo.path = path;
                    Ok(repo)
                }
                Response::Error(error) => Err(error),
                _ => Err("Unexpected remote response".to_string()),
            }
        } else {
            snapshot(&path, offset, 100)
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn repo_state(app: tauri::AppHandle, path: String) -> Result<RepoState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if path.starts_with("ssh://") {
            let (_, remote_path) = remote::parse_uri(&path)?;
            let response = app.state::<remote::RemoteManager>().call(
                &path,
                &agent_resources(&app),
                Request::State {
                    path: remote_path.to_string(),
                },
            )?;
            match response {
                Response::State(state) => Ok(state),
                Response::Error(error) => Err(error),
                _ => Err("Unexpected remote response".to_string()),
            }
        } else {
            state(&path)
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn repo_watch(app: tauri::AppHandle, path: String, timeout_ms: u64) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if path.starts_with("ssh://") {
            let (_, remote_path) = remote::parse_uri(&path)?;
            let response = app.state::<remote::RemoteManager>().call(
                &path,
                &agent_resources(&app),
                Request::Watch {
                    path: remote_path.to_string(),
                    timeout_ms,
                },
            )?;
            match response {
                Response::Changed(changed) => Ok(changed),
                Response::Error(error) => Err(error),
                _ => Err("Unexpected remote response".to_string()),
            }
        } else {
            watch(&path, timeout_ms)
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn repo_rebase_plan(
    app: tauri::AppHandle,
    path: String,
    onto: String,
) -> Result<Vec<RebaseCommit>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if path.starts_with("ssh://") {
            let (_, remote_path) = remote::parse_uri(&path)?;
            let response = app.state::<remote::RemoteManager>().call(
                &path,
                &agent_resources(&app),
                Request::RebasePlan {
                    path: remote_path.to_string(),
                    onto,
                },
            )?;
            match response {
                Response::RebasePlan(commits) => Ok(commits),
                Response::Error(error) => Err(error),
                _ => Err("Unexpected remote response".to_string()),
            }
        } else {
            rebase_plan(&path, &onto)
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn repo_search(
    app: tauri::AppHandle,
    path: String,
    query: String,
    offset: usize,
) -> Result<SearchResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if path.starts_with("ssh://") {
            let (_, remote_path) = remote::parse_uri(&path)?;
            let response = app.state::<remote::RemoteManager>().call(
                &path,
                &agent_resources(&app),
                Request::Search {
                    path: remote_path.to_string(),
                    query,
                    offset,
                    limit: 100,
                },
            )?;
            match response {
                Response::Search(result) => Ok(result),
                Response::Error(error) => Err(error),
                _ => Err("Unexpected remote response".to_string()),
            }
        } else {
            search(&path, &query, offset, 100)
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn repo_commit(
    app: tauri::AppHandle,
    path: String,
    hash: String,
) -> Result<CommitDetails, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if path.starts_with("ssh://") {
            let (_, remote_path) = remote::parse_uri(&path)?;
            let response = app.state::<remote::RemoteManager>().call(
                &path,
                &agent_resources(&app),
                Request::CommitDetails {
                    path: remote_path.to_string(),
                    hash,
                },
            )?;
            match response {
                Response::CommitDetails(details) => Ok(details),
                Response::Error(error) => Err(error),
                _ => Err("Unexpected remote response".to_string()),
            }
        } else {
            commit_details(&path, &hash)
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn repo_file_history(
    app: tauri::AppHandle,
    path: String,
    file: String,
    revision: String,
    offset: usize,
) -> Result<FileHistoryResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if path.starts_with("ssh://") {
            let (_, remote_path) = remote::parse_uri(&path)?;
            let response = app.state::<remote::RemoteManager>().call(
                &path,
                &agent_resources(&app),
                Request::FileHistory {
                    path: remote_path.to_string(),
                    file,
                    revision,
                    offset,
                    limit: 100,
                },
            )?;
            match response {
                Response::FileHistory(history) => Ok(history),
                Response::Error(error) => Err(error),
                _ => Err("Unexpected remote response".to_string()),
            }
        } else {
            file_history(&path, &file, &revision, offset, 100)
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn repo_blame(
    app: tauri::AppHandle,
    path: String,
    file: String,
    revision: String,
    start_line: usize,
) -> Result<BlameResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if path.starts_with("ssh://") {
            let (_, remote_path) = remote::parse_uri(&path)?;
            let response = app.state::<remote::RemoteManager>().call(
                &path,
                &agent_resources(&app),
                Request::Blame {
                    path: remote_path.to_string(),
                    file,
                    revision,
                    start_line,
                    limit: 300,
                },
            )?;
            match response {
                Response::Blame(blame) => Ok(blame),
                Response::Error(error) => Err(error),
                _ => Err("Unexpected remote response".to_string()),
            }
        } else {
            blame(&path, &file, &revision, start_line, 300)
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn repo_tracked_files(
    app: tauri::AppHandle,
    path: String,
    query: String,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if path.starts_with("ssh://") {
            let (_, remote_path) = remote::parse_uri(&path)?;
            let response = app.state::<remote::RemoteManager>().call(
                &path,
                &agent_resources(&app),
                Request::TrackedFiles {
                    path: remote_path.to_string(),
                    query,
                    limit: 100,
                },
            )?;
            match response {
                Response::TrackedFiles(files) => Ok(files),
                Response::Error(error) => Err(error),
                _ => Err("Unexpected remote response".to_string()),
            }
        } else {
            tracked_files(&path, &query, 100)
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn repo_diff(
    app: tauri::AppHandle,
    path: String,
    target: String,
    file: String,
    ignore_whitespace: bool,
) -> Result<DiffResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if path.starts_with("ssh://") {
            let (_, remote_path) = remote::parse_uri(&path)?;
            let response = app.state::<remote::RemoteManager>().call(
                &path,
                &agent_resources(&app),
                Request::Diff {
                    path: remote_path.to_string(),
                    target,
                    file,
                    ignore_whitespace,
                },
            )?;
            match response {
                Response::Diff(diff) => Ok(diff),
                Response::Error(error) => Err(error),
                _ => Err("Unexpected remote response".to_string()),
            }
        } else {
            diff_with_options(&path, &target, &file, ignore_whitespace)
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn open_in_editor(
    repo: String,
    file: String,
    line: u32,
    editor: String,
    executable: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        editor::open(&repo, &file, line, &editor, &executable)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn repo_action(
    app: tauri::AppHandle,
    path: String,
    operation: RepoAction,
    cancel_token: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if path.starts_with("ssh://") {
            let (_, remote_path) = remote::parse_uri(&path)?;
            let response = app.state::<remote::RemoteManager>().call_with_progress(
                &path,
                &agent_resources(&app),
                Request::Action {
                    path: remote_path.to_string(),
                    action: operation,
                    cancel_token: cancel_token.clone(),
                },
                |message| report_progress(&app, &path, message),
            )?;
            match response {
                Response::Action(output) => Ok(output),
                Response::Error(error) => Err(error),
                _ => Err("Unexpected remote response".to_string()),
            }
        } else {
            action_with_progress(&path, operation, cancel_token.as_deref(), |message| {
                report_progress(&app, &path, message)
            })
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn repo_cancel(app: tauri::AppHandle, path: String, token: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if path.starts_with("ssh://") {
            let response = app.state::<remote::RemoteManager>().call(
                &path,
                &agent_resources(&app),
                Request::Cancel { token },
            )?;
            match response {
                Response::Action(message) => Ok(message),
                Response::Error(error) => Err(error),
                _ => Err("Unexpected remote response".to_string()),
            }
        } else {
            cancel_operation(&token)
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(remote::RemoteManager::new())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            repo_snapshot,
            repo_state,
            repo_watch,
            repo_rebase_plan,
            repo_search,
            repo_commit,
            repo_file_history,
            repo_blame,
            repo_tracked_files,
            repo_diff,
            open_in_editor,
            repo_action,
            repo_cancel
        ])
        .run(tauri::generate_context!())
        .expect("error while running GitFerry");
}
