use gitferry_agent::{action, commit_details, diff, search, snapshot, state};
use gitferry_proto::{
    CommitDetails, DiffResult, RepoAction, RepoSnapshot, RepoState, Request, Response, SearchResult,
};
use tauri::Manager;

mod remote;

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
async fn repo_diff(
    app: tauri::AppHandle,
    path: String,
    target: String,
    file: String,
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
                },
            )?;
            match response {
                Response::Diff(diff) => Ok(diff),
                Response::Error(error) => Err(error),
                _ => Err("Unexpected remote response".to_string()),
            }
        } else {
            diff(&path, &target, &file)
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn repo_action(
    app: tauri::AppHandle,
    path: String,
    operation: RepoAction,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if path.starts_with("ssh://") {
            let (_, remote_path) = remote::parse_uri(&path)?;
            let response = app.state::<remote::RemoteManager>().call(
                &path,
                &agent_resources(&app),
                Request::Action {
                    path: remote_path.to_string(),
                    action: operation,
                },
            )?;
            match response {
                Response::Action(output) => Ok(output),
                Response::Error(error) => Err(error),
                _ => Err("Unexpected remote response".to_string()),
            }
        } else {
            action(&path, operation)
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
            repo_search,
            repo_commit,
            repo_diff,
            repo_action
        ])
        .run(tauri::generate_context!())
        .expect("error while running GitFerry");
}
