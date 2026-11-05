use std::collections::VecDeque;
use std::sync::Mutex;

use gitferry_proto::{Request, Response, WorkingFile};
use tauri::{Emitter, Manager};

const MAX_URL_BYTES: usize = 64 * 1024;
const MAX_PENDING: usize = 128;

#[derive(Debug, PartialEq)]
struct FileLink {
    file: String,
    repository: Option<String>,
    line: u32,
    column: u32,
}

fn decode(value: &str) -> Result<String, String> {
    let bytes = value.as_bytes();
    for (index, byte) in bytes.iter().enumerate() {
        if *byte == b'%'
            && (index + 2 >= bytes.len()
                || !bytes[index + 1].is_ascii_hexdigit()
                || !bytes[index + 2].is_ascii_hexdigit())
        {
            return Err("The file link contains invalid percent encoding".into());
        }
    }
    let value = value.replace('+', " ");
    let decoded = percent_encoding::percent_decode_str(&value)
        .decode_utf8()
        .map_err(|_| "File links must contain valid UTF-8 paths")?
        .into_owned();
    if decoded.chars().any(char::is_control) {
        return Err("File links cannot contain control characters".into());
    }
    Ok(decoded)
}

fn position(value: &str, name: &str) -> Result<u32, String> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(format!("{name} must be a positive 1-based integer"));
    }
    value
        .parse::<u32>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| format!("{name} must be between 1 and {}", u32::MAX))
}

fn parse(raw: &str) -> Result<FileLink, String> {
    if raw.len() > MAX_URL_BYTES {
        return Err("The file link exceeds the 64 KiB limit".into());
    }
    if raw.chars().any(char::is_control) {
        return Err("File links cannot contain control characters".into());
    }
    let url = url::Url::parse(raw).map_err(|_| "Invalid GitFerry URL")?;
    if url.scheme() != "gitferry"
        || url.host_str() != Some("open")
        || !matches!(url.path(), "" | "/")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
    {
        return Err("Expected gitferry://open?file=<absolute path>&line=1&column=1".into());
    }
    let mut file = None;
    let mut repository = None;
    let mut line = None;
    let mut column = None;
    for pair in url
        .query()
        .unwrap_or("")
        .split('&')
        .filter(|pair| !pair.is_empty())
    {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        let key = decode(key)?;
        let value = decode(value)?;
        match key.as_str() {
            "file" if file.is_none() => file = Some(value),
            "repository" if repository.is_none() => repository = Some(value),
            "line" if line.is_none() => line = Some(position(&value, "line")?),
            "column" if column.is_none() => column = Some(position(&value, "column")?),
            "file" | "repository" | "line" | "column" => {
                return Err(format!("Duplicate file-link parameter: {key}"))
            }
            _ => return Err(format!("Unknown file-link parameter: {key}")),
        }
    }
    let file = file
        .filter(|file| !file.is_empty())
        .ok_or("The file link requires file=<absolute path>")?;
    if repository.as_deref() == Some("") {
        return Err("The explicit repository cannot be empty".into());
    }
    Ok(FileLink {
        file,
        repository,
        line: line.unwrap_or(1),
        column: column.unwrap_or(1),
    })
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingLink {
    id: u64,
    url: Option<String>,
    error: Option<String>,
}

#[derive(Default)]
struct Inbox {
    next_id: u64,
    pending: VecDeque<PendingLink>,
    dropped: usize,
}

impl Inbox {
    fn push(&mut self, url: String) {
        if self.pending.len() >= MAX_PENDING {
            self.dropped += 1;
            return;
        }
        self.next_id += 1;
        let (url, error) = if url.len() > MAX_URL_BYTES {
            (None, Some("The file link exceeds the 64 KiB limit".into()))
        } else {
            (Some(url), None)
        };
        self.pending.push_back(PendingLink {
            id: self.next_id,
            url,
            error,
        });
    }

    fn take(&mut self) -> LinkBatch {
        LinkBatch {
            links: self.pending.drain(..).collect(),
            dropped: std::mem::take(&mut self.dropped),
        }
    }
}

#[derive(Default)]
pub struct FileLinks(Mutex<Inbox>);

#[cfg(windows)]
pub fn report_error(app: &tauri::AppHandle, message: String) {
    let state = app.state::<FileLinks>();
    if let Ok(mut inbox) = state.0.lock() {
        if inbox.pending.len() < MAX_PENDING {
            inbox.next_id += 1;
            let id = inbox.next_id;
            inbox.pending.push_back(PendingLink {
                id,
                url: None,
                error: Some(message),
            });
        } else {
            inbox.dropped += 1;
        }
    }
    let _ = app.emit("file-links-pending", ());
}

#[derive(serde::Serialize)]
pub struct LinkBatch {
    links: Vec<PendingLink>,
    dropped: usize,
}

/// Both cold-launch arguments and warm OS events enter the same inbox. The notification is only
/// a wakeup; the UI drains stored requests after registering its listener, so no startup event is lost.
pub fn receive(app: &tauri::AppHandle, urls: impl IntoIterator<Item = String>) {
    let state = app.state::<FileLinks>();
    if let Ok(mut inbox) = state.0.lock() {
        for url in urls {
            if url
                .split_once(':')
                .is_some_and(|(scheme, _)| scheme.eq_ignore_ascii_case("gitferry"))
            {
                inbox.push(url);
            }
        }
    }
    let _ = app.emit("file-links-pending", ());
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[tauri::command]
pub fn take_file_links(state: tauri::State<'_, FileLinks>) -> Result<LinkBatch, String> {
    Ok(state.0.lock().map_err(|error| error.to_string())?.take())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedLink {
    repository: String,
    file: String,
    content: String,
    line: u32,
    column: u32,
}

#[derive(Debug, PartialEq)]
struct RemoteTarget<'a> {
    uri: &'a str,
    host: &'a str,
    file: &'a str,
    repository: Option<&'a str>,
}

fn remote_target(link: &FileLink) -> Result<Option<RemoteTarget<'_>>, String> {
    let remote_file = link.file.starts_with("ssh://");
    let remote_repo = link
        .repository
        .as_deref()
        .is_some_and(|repo| repo.starts_with("ssh://"));
    if !remote_file && !remote_repo {
        return Ok(None);
    }
    let uri = link
        .repository
        .as_deref()
        .filter(|_| remote_repo)
        .or_else(|| remote_file.then_some(link.file.as_str()))
        .ok_or("An SSH URL is required")?;
    let (host, _) = crate::remote::parse_uri(uri)?;
    let file = if remote_file {
        let (file_host, file) = crate::remote::parse_uri(&link.file)?;
        if host != file_host {
            return Err("The file and repository must use the same SSH host".into());
        }
        file
    } else {
        link.file.as_str()
    };
    let repository = match link.repository.as_deref() {
        Some(repository) if remote_repo => Some(crate::remote::parse_uri(repository)?.1),
        Some(_) => return Err("An SSH file cannot be paired with a local repository".into()),
        None => None,
    };
    if !file.starts_with('/') {
        return Err("SSH file links require an absolute remote path".into());
    }
    Ok(Some(RemoteTarget {
        uri,
        host,
        file,
        repository,
    }))
}

#[tauri::command]
pub async fn resolve_file_link(app: tauri::AppHandle, url: String) -> Result<ResolvedLink, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let link = parse(&url)?;
        let location = if let Some(target) = remote_target(&link)? {
            let response = app.state::<crate::remote::RemoteManager>().call(
                target.uri,
                &crate::agent_resources(&app),
                Request::WorkingFile {
                    file: target.file.to_string(),
                    repository: target.repository.map(str::to_string),
                },
            )?;
            match response {
                Response::WorkingFile(mut location) => {
                    location.repository = format!("ssh://{}{}", target.host, location.repository);
                    location
                }
                Response::Error(error) => return Err(error),
                _ => {
                    return Err(
                        "The SSH agent returned an unexpected file-link response; update the agent"
                            .into(),
                    )
                }
            }
        } else {
            gitferry_agent::working_file(&link.file, link.repository.as_deref())?
        };
        let WorkingFile {
            repository,
            file,
            content,
        } = location;
        Ok(ResolvedLink {
            repository,
            file,
            content,
            line: link.line,
            column: link.column,
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_paths_once_and_defaults_positions() {
        let request =
            parse("gitferry://open?file=%2Ftmp%2F%E6%96%87%E4%BB%B6%20%23%25%2B%26.txt").unwrap();
        assert_eq!(request.file, "/tmp/文件 #%+&.txt");
        assert_eq!((request.line, request.column), (1, 1));
        assert_eq!(
            parse("gitferry://open?file=%2Ftmp%2F%2520.txt&line=77&column=2")
                .unwrap()
                .file,
            "/tmp/%20.txt"
        );
        assert_eq!(
            parse("gitferry://open?file=C%3A%5CRepo%5CFile.txt")
                .unwrap()
                .file,
            r"C:\Repo\File.txt"
        );
        assert_eq!(
            parse("gitferry://open?file=/srv/a&repository=ssh%3A%2F%2Fuser%40host%2Fsrv")
                .unwrap()
                .repository
                .as_deref(),
            Some("ssh://user@host/srv")
        );
    }

    #[test]
    fn local_and_ssh_locations_never_infer_each_others_context() {
        let local = parse("gitferry://open?file=%2Ftmp%2Fa.txt").unwrap();
        assert_eq!(remote_target(&local).unwrap(), None);
        let remote = parse("gitferry://open?file=%2Fsrv%2Frepo%2Fa.txt&repository=ssh%3A%2F%2Fuser%40host%2Fsrv%2Frepo").unwrap();
        assert_eq!(
            remote_target(&remote).unwrap(),
            Some(RemoteTarget {
                uri: "ssh://user@host/srv/repo",
                host: "user@host",
                file: "/srv/repo/a.txt",
                repository: Some("/srv/repo")
            })
        );
        let remote = parse("gitferry://open?file=ssh%3A%2F%2Fhost%2Fsrv%2Frepo%2Fa.txt").unwrap();
        assert_eq!(
            remote_target(&remote).unwrap(),
            Some(RemoteTarget {
                uri: "ssh://host/srv/repo/a.txt",
                host: "host",
                file: "/srv/repo/a.txt",
                repository: None
            })
        );
        for (file, repository) in [
            ("ssh://host-a/repo/a", Some("ssh://host-b/repo")),
            ("ssh://host/repo/a", Some("/local/repo")),
            (r"C:\repo\a", Some("ssh://host/repo")),
            ("ssh://-bad/repo/a", None),
        ] {
            let link = FileLink {
                file: file.into(),
                repository: repository.map(str::to_string),
                line: 1,
                column: 1,
            };
            assert!(remote_target(&link).is_err(), "accepted {link:?}");
        }
    }

    #[test]
    fn rejects_ambiguous_and_malformed_links() {
        for url in [
            "gitferry://close?file=/a",
            "https://open?file=/a",
            "gitferry://open/other?file=/a",
            "gitferry://open?file=/a#fragment",
            "gitferry://open?file=/a&file=/b",
            "gitferry://open?file=/a&line=0",
            "gitferry://open?file=/a&line=-1",
            "gitferry://open?file=/a&line=1.5",
            "gitferry://open?file=/a&column=4294967296",
            "gitferry://open?file=/a&column=",
            "gitferry://open?file=/a&run=1",
            "gitferry://open?line=2",
            "gitferry://open?file=%FF",
            "gitferry://open?file=%0A",
            "gitferry://open?file=%0",
            "gitferry://open?file=%XZ",
            "gitferry://open?file=/a&repository=",
        ] {
            assert!(parse(url).is_err(), "accepted {url}");
        }
    }

    #[test]
    fn queues_cold_warm_and_repeated_clicks_without_replaying_drained_links() {
        let mut inbox = Inbox::default();
        let url = "gitferry://open?file=/tmp/a".to_string();
        inbox.push(url.clone());
        inbox.push(url.clone());
        let batch = inbox.take();
        assert_eq!(batch.links.len(), 2);
        assert_ne!(batch.links[0].id, batch.links[1].id);
        assert!(inbox.take().links.is_empty());
        inbox.push(url);
        assert_eq!(inbox.take().links[0].id, 3);
    }

    #[test]
    fn bounds_inbox_and_reports_overflow() {
        let mut inbox = Inbox::default();
        for _ in 0..MAX_PENDING + 2 {
            inbox.push("gitferry://open?file=/tmp/a".into());
        }
        let batch = inbox.take();
        assert_eq!(batch.links.len(), MAX_PENDING);
        assert_eq!(batch.dropped, 2);
        assert_eq!(inbox.take().dropped, 0);
        inbox.push("x".repeat(MAX_URL_BYTES + 1));
        assert!(inbox.take().links[0].error.is_some());
    }
}
