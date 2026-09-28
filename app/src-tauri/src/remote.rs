use crate::askpass::Askpass;
use gitferry_proto::{Request, Response, RpcRequest, RpcResponse};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};

pub struct RemoteManager {
    sessions: Mutex<HashMap<String, Arc<Mutex<Connection>>>>,
    /// Answers ssh's password and host key prompts; without it ssh runs in batch mode.
    askpass: Option<Arc<Askpass>>,
}

impl RemoteManager {
    pub fn new(askpass: Option<Arc<Askpass>>) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            askpass,
        }
    }

    pub fn call(
        &self,
        uri: &str,
        resource_dir: &Path,
        request: Request,
    ) -> Result<Response, String> {
        self.call_with_progress(uri, resource_dir, request, |_| {})
    }

    pub fn call_with_progress(
        &self,
        uri: &str,
        resource_dir: &Path,
        request: Request,
        mut progress: impl FnMut(&str),
    ) -> Result<Response, String> {
        let (host, _) = parse_uri(uri)?;
        // Keep repository reads responsive while a fetch or push is running.
        // Actions use a separate session; Git itself still serializes conflicting writes.
        let channel = match &request {
            Request::Action { .. } => "action",
            Request::Cancel { .. } => "cancel",
            Request::Watch { .. } => "watch",
            _ => "read",
        };
        let key = format!("{uri}#{channel}");
        let existing = self
            .sessions
            .lock()
            .map_err(|error| error.to_string())?
            .get(&key)
            .cloned();
        let connection = if let Some(connection) = existing {
            connection
        } else {
            let created = Arc::new(Mutex::new(Connection::start(
                host,
                resource_dir,
                self.askpass.as_ref(),
            )?));
            let mut sessions = self.sessions.lock().map_err(|error| error.to_string())?;
            Arc::clone(sessions.entry(key.clone()).or_insert(created))
        };
        let result = connection
            .lock()
            .map_err(|error| error.to_string())?
            .call(request, &mut progress);
        if result.is_err() {
            let mut sessions = self.sessions.lock().map_err(|error| error.to_string())?;
            if sessions
                .get(&key)
                .is_some_and(|current| Arc::ptr_eq(current, &connection))
            {
                sessions.remove(&key);
            }
        }
        result
    }
}

pub fn parse_uri(uri: &str) -> Result<(&str, &str), String> {
    let value = uri
        .strip_prefix("ssh://")
        .ok_or("Invalid SSH repository URI")?;
    let (host, tail) = value
        .split_once('/')
        .ok_or("SSH repository needs an absolute path")?;
    if !host
        .bytes()
        .next()
        .is_some_and(|byte| byte.is_ascii_alphanumeric())
        || !host
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'@' | b'.' | b'-' | b'_'))
    {
        return Err("Invalid SSH host".to_string());
    }
    if tail.is_empty() {
        return Err("SSH repository needs an absolute path".to_string());
    }
    Ok((host, &value[host.len()..]))
}

struct Connection {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

impl Connection {
    fn start(host: &str, resource_dir: &Path, askpass: Option<&Arc<Askpass>>) -> Result<Self, String> {
        let x64 = std::fs::read(resource_dir.join("gitferry-agent-linux-x64"))
            .map_err(|_| "The Linux x64 agent is missing from this GitFerry build".to_string())?;
        let arm64 = std::fs::read(resource_dir.join("gitferry-agent-linux-arm64"))
            .map_err(|_| "The Linux arm64 agent is missing from this GitFerry build".to_string())?;
        let x64_hash = format!("{:x}", Sha256::digest(&x64));
        let arm64_hash = format!("{:x}", Sha256::digest(&arm64));
        let script = format!(
            r#"set -eu
arch="$(uname -sm)"
printf "GITFERRY_ARCH %s\n" "$arch"
directory="$HOME/.cache/gitferry"
mkdir -p "$directory"
case "$arch" in
  "Linux x86_64") agent="$directory/agent-{x64_hash}"; size={x64_size} ;;
  "Linux aarch64") agent="$directory/agent-{arm64_hash}"; size={arm64_size} ;;
  *) printf "GITFERRY_UNSUPPORTED %s\n" "$arch"; exit 1 ;;
esac
if [ ! -x "$agent" ]; then
  printf "GITFERRY_UPLOAD\n"
  temporary="$agent.tmp.$$"
  head -c "$size" > "$temporary"
  chmod 700 "$temporary"
  mv "$temporary" "$agent"
fi
printf "GITFERRY_READY\n"
exec "$agent""#,
            x64_size = x64.len(),
            arm64_size = arm64.len()
        );
        let ssh = if cfg!(windows) {
            Path::new(r"C:\Windows\System32\OpenSSH\ssh.exe")
        } else {
            Path::new("ssh")
        };
        let mut command = Command::new(ssh);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        // Keys and the agent are tried first; ssh asks through GitFerry only when they are not enough.
        let attempt = askpass.map(|askpass| askpass.begin(host, &mut command));
        let mut child = command
            .args([
                "-T",
                "-o",
                if attempt.is_some() {
                    "BatchMode=no"
                } else {
                    "BatchMode=yes"
                },
                "-o",
                "ConnectTimeout=10",
                "-o",
                "ServerAliveInterval=15",
                "--",
                host,
            ])
            .arg(format!("sh -c '{}'", script))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("Cannot start SSH: {error}"))?;
        let stdin = child.stdin.take().ok_or("SSH stdin unavailable")?;
        let stdout = child.stdout.take().ok_or("SSH stdout unavailable")?;
        let mut session = Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
            next_id: 1,
        };
        // The first line arrives once ssh has signed in.
        let arch = session.read_line();
        if let Some(attempt) = attempt {
            if attempt.finish(arch.is_ok()) && arch.is_err() {
                return Err("SSH sign-in was cancelled".to_string());
            }
        }
        let arch = arch?;
        let binary = match arch.as_str() {
            "GITFERRY_ARCH Linux x86_64" => &x64,
            "GITFERRY_ARCH Linux aarch64" => &arm64,
            _ => return Err(format!("Unsupported remote host: {arch}")),
        };
        let state = session.read_line()?;
        let state = if state == "GITFERRY_UPLOAD" {
            session
                .stdin
                .write_all(binary)
                .map_err(|error| error.to_string())?;
            session.stdin.flush().map_err(|error| error.to_string())?;
            session.read_line()?
        } else {
            state
        };
        if state != "GITFERRY_READY" {
            return Err(format!("Remote agent failed: {state}"));
        }
        Ok(session)
    }

    fn read_line(&mut self) -> Result<String, String> {
        let mut line = String::new();
        if self
            .stdout
            .read_line(&mut line)
            .map_err(|error| error.to_string())?
            == 0
        {
            let mut stderr = String::new();
            if let Some(mut stream) = self.child.stderr.take() {
                use std::io::Read;
                let _ = stream.read_to_string(&mut stderr);
            }
            return Err(format!("SSH connection closed: {}", stderr.trim()));
        }
        Ok(line.trim_end_matches(['\r', '\n']).to_string())
    }

    fn call(
        &mut self,
        request: Request,
        progress: &mut impl FnMut(&str),
    ) -> Result<Response, String> {
        let id = self.next_id;
        self.next_id += 1;
        serde_json::to_writer(&mut self.stdin, &RpcRequest { id, request })
            .map_err(|error| error.to_string())?;
        self.stdin
            .write_all(b"\n")
            .map_err(|error| error.to_string())?;
        self.stdin.flush().map_err(|error| error.to_string())?;
        loop {
            let response: RpcResponse = serde_json::from_str(&self.read_line()?)
                .map_err(|error| format!("Invalid remote response: {error}"))?;
            if response.id != id {
                return Err("Remote response ID mismatch".to_string());
            }
            match response.response {
                Response::Progress(message) => progress(&message),
                other => return Ok(other),
            }
        }
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_invalid_remote_uris() {
        assert!(parse_uri("ssh://root@warmer/tmp/repo").is_ok());
        assert!(parse_uri("ssh://-bad/tmp/repo").is_err());
        assert!(parse_uri("ssh://root@warmer").is_err());
        assert!(parse_uri("ssh://root@warmer/").is_err());
    }

    #[test]
    fn live_remote_snapshot_when_requested() {
        let Ok(uri) = std::env::var("GITFERRY_TEST_REMOTE") else {
            return;
        };
        let (_, path) = parse_uri(&uri).unwrap();
        let manager = RemoteManager::new(None);
        let resources = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources");
        let response = manager
            .call(
                &uri,
                &resources,
                Request::Snapshot {
                    path: path.to_string(),
                    offset: 0,
                    limit: 10,
                },
            )
            .unwrap();
        match response {
            Response::Snapshot(repo) => {
                assert!(!repo.commits.is_empty());
                let hash = repo.commits[0].hash.clone();
                let details = manager
                    .call(
                        &uri,
                        &resources,
                        Request::CommitDetails {
                            path: path.to_string(),
                            hash: hash.clone(),
                        },
                    )
                    .unwrap();
                assert!(matches!(details, Response::CommitDetails(_)));
                let diff = manager
                    .call(
                        &uri,
                        &resources,
                        Request::Diff {
                            path: path.to_string(),
                            target: hash,
                            file: "example.txt".to_string(),
                            ignore_whitespace: false,
                            full_context: false,
                        },
                    )
                    .unwrap();
                assert!(matches!(diff, Response::Diff(_)));
                let state = manager
                    .call(
                        &uri,
                        &resources,
                        Request::State {
                            path: path.to_string(),
                        },
                    )
                    .unwrap();
                if let Response::State(state) = state {
                    if state
                        .status
                        .iter()
                        .any(|entry| entry.path == "remote-smoke.txt")
                    {
                        let staged = manager
                            .call(
                                &uri,
                                &resources,
                                Request::Action {
                                    path: path.to_string(),
                                    action: gitferry_proto::RepoAction::StageFile {
                                        path: "remote-smoke.txt".to_string(),
                                    },
                                    cancel_token: None,
                                },
                            )
                            .unwrap();
                        assert!(matches!(staged, Response::Action(_)));
                        let committed = manager
                            .call(
                                &uri,
                                &resources,
                                Request::Action {
                                    path: path.to_string(),
                                    action: gitferry_proto::RepoAction::Commit {
                                        message: "Remote smoke".to_string(),
                                        amend: false,
                                    },
                                    cancel_token: None,
                                },
                            )
                            .unwrap();
                        assert!(matches!(committed, Response::Action(_)));
                        if std::env::var_os("GITFERRY_TEST_PUSH").is_some() {
                            let pushed = manager
                                .call(
                                    &uri,
                                    &resources,
                                    Request::Action {
                                        path: path.to_string(),
                                        action: gitferry_proto::RepoAction::Push,
                                        cancel_token: None,
                                    },
                                )
                                .unwrap();
                            assert!(matches!(pushed, Response::Action(_)));
                        }
                    }
                } else {
                    panic!("expected state response");
                }
                let searched = manager
                    .call(
                        &uri,
                        &resources,
                        Request::Search {
                            path: path.to_string(),
                            query: "Remote smoke".to_string(),
                            offset: 0,
                            limit: 10,
                        },
                    )
                    .unwrap();
                assert!(matches!(searched, Response::Search(result) if !result.commits.is_empty()));
            }
            response => panic!("unexpected response: {response:?}"),
        }
    }
}
