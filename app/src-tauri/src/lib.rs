use gitferry_agent::{
    action_with_progress, blame, cancel_operation, commit_details, compare, diff_with_context,
    file_history, read_file, rebase_plan, save_file, search, snapshot, state, tracked_files, watch,
};
use gitferry_proto::{
    BlameResult, CommitDetails, CompareResult, DiffResult, EditableFile, FileHistoryResult,
    RebaseCommit, RepoAction, RepoSnapshot, RepoState, Request, Response, SavedFile, SearchResult,
};
use tauri::{Emitter, Manager};

mod askpass;
mod editor;
mod remote;

pub use askpass::helper as askpass_helper;

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

/// Colors the native Windows 11 title bar to match the app theme; other platforms keep their own.
#[tauri::command]
fn set_titlebar_color(
    window: tauri::WebviewWindow,
    background: String,
    text: String,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Graphics::Dwm::{
            DwmSetWindowAttribute, DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR,
        };
        // COLORREF is 0x00BBGGRR.
        let colorref = |hex: &str| -> Result<u32, String> {
            let hex = hex.trim_start_matches('#');
            let value = u32::from_str_radix(hex, 16)
                .ok()
                .filter(|_| hex.len() == 6)
                .ok_or("Expected a #rrggbb color")?;
            Ok(((value & 0xff) << 16) | (value & 0xff00) | ((value >> 16) & 0xff))
        };
        let hwnd = window.hwnd().map_err(|error| error.to_string())?.0;
        for (attribute, color) in [
            (DWMWA_CAPTION_COLOR, colorref(&background)?),
            (DWMWA_TEXT_COLOR, colorref(&text)?),
        ] {
            // Older Windows versions ignore these attributes; that is fine.
            unsafe {
                DwmSetWindowAttribute(
                    hwnd,
                    attribute as u32,
                    &color as *const u32 as *const _,
                    std::mem::size_of::<u32>() as u32,
                );
            }
        }
    }
    #[cfg(not(windows))]
    let _ = (window, background, text);
    Ok(())
}

/// UI settings mirrored from WebView localStorage, which has come back empty after Windows restarts.
fn settings_file(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?
        .join("settings.json"))
}

#[tauri::command]
fn load_settings(
    app: tauri::AppHandle,
) -> Result<Option<std::collections::HashMap<String, String>>, String> {
    let path = settings_file(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&path).map_err(|error| error.to_string())?;
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn save_settings(
    app: tauri::AppHandle,
    settings: std::collections::HashMap<String, String>,
) -> Result<(), String> {
    let path = settings_file(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    // Write a sibling file and rename it so a crash never leaves a half-written settings file.
    let temporary = path.with_extension("json.tmp");
    let text = serde_json::to_string(&settings).map_err(|error| error.to_string())?;
    std::fs::write(&temporary, text).map_err(|error| error.to_string())?;
    std::fs::rename(&temporary, &path).map_err(|error| error.to_string())
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
async fn repo_compare(
    app: tauri::AppHandle,
    path: String,
    base: String,
    head: String,
) -> Result<CompareResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if path.starts_with("ssh://") {
            let (_, remote_path) = remote::parse_uri(&path)?;
            let response = app.state::<remote::RemoteManager>().call(
                &path,
                &agent_resources(&app),
                Request::Compare {
                    path: remote_path.to_string(),
                    base,
                    head,
                },
            )?;
            match response {
                Response::Compare(result) => Ok(result),
                Response::Error(error) => Err(error),
                _ => Err("Unexpected remote response".to_string()),
            }
        } else {
            compare(&path, &base, &head)
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
    full_context: Option<bool>,
) -> Result<DiffResult, String> {
    let full_context = full_context.unwrap_or(false);
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
                    full_context,
                },
            )?;
            match response {
                Response::Diff(diff) => Ok(diff),
                Response::Error(error) => Err(error),
                _ => Err("Unexpected remote response".to_string()),
            }
        } else {
            diff_with_context(&path, &target, &file, ignore_whitespace, full_context)
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn repo_read_file(
    app: tauri::AppHandle,
    path: String,
    file: String,
) -> Result<EditableFile, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if path.starts_with("ssh://") {
            let (_, remote_path) = remote::parse_uri(&path)?;
            match app.state::<remote::RemoteManager>().call(
                &path,
                &agent_resources(&app),
                Request::ReadFile {
                    path: remote_path.to_string(),
                    file,
                },
            )? {
                Response::EditableFile(result) => Ok(result),
                Response::Error(error) => Err(error),
                _ => Err("Unexpected remote response".to_string()),
            }
        } else {
            read_file(&path, &file)
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn repo_save_file(
    app: tauri::AppHandle,
    path: String,
    file: String,
    content: String,
    expected_content: String,
    stage: bool,
) -> Result<SavedFile, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if path.starts_with("ssh://") {
            let (_, remote_path) = remote::parse_uri(&path)?;
            match app.state::<remote::RemoteManager>().call(
                &path,
                &agent_resources(&app),
                Request::SaveFile {
                    path: remote_path.to_string(),
                    file,
                    content,
                    expected_content,
                    stage,
                },
            )? {
                Response::SavedFile(result) => Ok(result),
                Response::Error(error) => Err(error),
                _ => Err("Unexpected remote response".to_string()),
            }
        } else {
            save_file(&path, &file, &content, &expected_content, stage)
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

#[tauri::command]
fn ssh_prompt_answer(
    askpass: tauri::State<std::sync::Arc<askpass::Askpass>>,
    id: u64,
    answer: Option<String>,
    remember: bool,
) {
    askpass.reply(id, answer, remember);
}

#[tauri::command]
fn ssh_current_prompt(askpass: tauri::State<std::sync::Arc<askpass::Askpass>>) -> Option<askpass::Prompt> {
    askpass.current()
}

#[tauri::command]
fn ssh_saved_credentials(askpass: tauri::State<std::sync::Arc<askpass::Askpass>>) -> Vec<String> {
    askpass.saved()
}

#[tauri::command]
fn ssh_forget_credential(askpass: tauri::State<std::sync::Arc<askpass::Askpass>>, key: String) {
    askpass.forget(&key);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let askpass = askpass::Askpass::start(app.handle().clone())?;
            app.manage(remote::RemoteManager::new(Some(askpass.clone())));
            app.manage(askpass);
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            repo_snapshot,
            repo_state,
            repo_watch,
            repo_rebase_plan,
            repo_search,
            repo_commit,
            repo_compare,
            load_settings,
            set_titlebar_color,
            save_settings,
            repo_file_history,
            repo_blame,
            repo_tracked_files,
            repo_diff,
            repo_read_file,
            repo_save_file,
            open_in_editor,
            repo_action,
            repo_cancel,
            ssh_prompt_answer,
            ssh_current_prompt,
            ssh_saved_credentials,
            ssh_forget_credential
        ])
        .run(tauri::generate_context!())
        .expect("error while running GitFerry");
}
