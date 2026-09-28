//! Answers ssh's prompts (passwords, key passphrases, unknown host keys) from GitFerry.
//!
//! ssh runs GitFerry itself as its SSH_ASKPASS program. That short-lived process forwards the
//! prompt to the running app over a loopback socket; the app answers from memory or the OS
//! keychain, or asks in a dialog.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::Command;
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

/// `<port>:<attempt>:<token>` for the helper; only ssh processes started by GitFerry have it.
const ENV: &str = "GITFERRY_ASKPASS";
const KEYCHAIN_SERVICE: &str = "GitFerry SSH";

#[derive(Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Password,
    Passphrase,
    Confirm,
    Other,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prompt {
    id: u64,
    kind: Kind,
    /// `user@host` for a password, the key file for a passphrase.
    target: String,
    text: String,
    error: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct HelperRequest {
    token: String,
    attempt: u64,
    prompt: String,
    mode: String,
}

#[derive(Serialize, Deserialize)]
struct HelperReply {
    answer: Option<String>,
}

/// One ssh connection attempt.
#[derive(Default)]
struct Attempt {
    host: String,
    /// Secrets given to this attempt, and whether each came from memory or the keychain.
    answered: HashMap<String, bool>,
    remember: HashMap<String, String>,
    cancelled: bool,
}

#[derive(Default)]
struct State {
    next_id: u64,
    attempts: HashMap<u64, Attempt>,
    /// Secrets that worked (or are being tried) this run, by credential key.
    cache: HashMap<String, String>,
    current: Option<Prompt>,
    replies: HashMap<u64, mpsc::Sender<Option<(String, bool)>>>,
}

pub struct Askpass {
    app: AppHandle,
    port: u16,
    token: String,
    state: Mutex<State>,
    /// Shows one dialog at a time; connections that open together wait and reuse the first answer.
    dialog: Mutex<()>,
    index: Mutex<()>,
}

impl Askpass {
    pub fn start(app: AppHandle) -> Result<Arc<Self>, String> {
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|error| error.to_string())?;
        let port = listener.local_addr().map_err(|error| error.to_string())?.port();
        let mut bytes = [0u8; 24];
        getrandom::fill(&mut bytes).map_err(|error| error.to_string())?;
        let token = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        let askpass = Arc::new(Self {
            app,
            port,
            token,
            state: Mutex::default(),
            dialog: Mutex::new(()),
            index: Mutex::new(()),
        });
        let server = Arc::clone(&askpass);
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let server = Arc::clone(&server);
                std::thread::spawn(move || server.serve(stream));
            }
        });
        Ok(askpass)
    }

    /// Registers a connection attempt to `host` and points `command`'s ssh at the helper.
    pub fn begin(self: &Arc<Self>, host: &str, command: &mut Command) -> AttemptGuard {
        let mut state = self.state.lock().unwrap();
        state.next_id += 1;
        let id = state.next_id;
        state.attempts.insert(
            id,
            Attempt {
                host: host.to_string(),
                ..Attempt::default()
            },
        );
        if let Ok(exe) = std::env::current_exe() {
            command
                .env("SSH_ASKPASS", exe)
                .env("SSH_ASKPASS_REQUIRE", "force")
                .env(ENV, format!("{}:{id}:{}", self.port, self.token));
        }
        AttemptGuard {
            askpass: Arc::clone(self),
            id,
            finished: false,
        }
    }

    fn finish(&self, id: u64, connected: bool) -> bool {
        let mut state = self.state.lock().unwrap();
        let Some(attempt) = state.attempts.remove(&id) else {
            return false;
        };
        if connected {
            drop(state);
            for (key, secret) in attempt.remember {
                if keychain(&key).is_some_and(|entry| entry.set_password(&secret).is_ok()) {
                    self.update_index(|keys| {
                        if !keys.contains(&key) {
                            keys.push(key)
                        }
                    });
                }
            }
        } else {
            // A secret that did not get this attempt in should not be offered to the next one.
            for key in attempt.answered.keys() {
                state.cache.remove(key);
            }
        }
        attempt.cancelled
    }

    fn serve(&self, stream: TcpStream) {
        let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
        let mut line = String::new();
        if BufReader::new(&stream).read_line(&mut line).is_err() {
            return;
        }
        let Ok(request) = serde_json::from_str::<HelperRequest>(&line) else {
            return;
        };
        if request.token != self.token {
            return;
        }
        let answer = self.answer(request.attempt, &request.prompt, &request.mode);
        let Ok(reply) = serde_json::to_string(&HelperReply { answer }) else {
            return;
        };
        let _ = (&stream).write_all(format!("{reply}\n").as_bytes());
    }

    fn answer(&self, attempt_id: u64, text: &str, mode: &str) -> Option<String> {
        let (kind, target, key, error) = {
            let mut state = self.state.lock().unwrap();
            let State {
                attempts, cache, ..
            } = &mut *state;
            let attempt = attempts.get_mut(&attempt_id)?;
            if attempt.cancelled {
                return None;
            }
            let (kind, target) = classify(text, mode, &attempt.host);
            let key = matches!(kind, Kind::Password | Kind::Passphrase)
                .then(|| credential_key(kind, &target));
            let mut error = None;
            if let Some(key) = &key {
                // ssh asks again only after the previous answer was rejected.
                if let Some(saved) = attempt.answered.get(key).copied() {
                    cache.remove(key);
                    attempt.remember.remove(key);
                    if saved {
                        self.forget_saved(key);
                    }
                    error = Some(match (kind, saved) {
                        (Kind::Passphrase, true) => "The saved passphrase was rejected.",
                        (Kind::Passphrase, false) => "Wrong passphrase. Try again.",
                        (_, true) => "The saved password was rejected.",
                        _ => "Wrong password. Try again.",
                    });
                } else if let Some(secret) = cache
                    .get(key)
                    .cloned()
                    .or_else(|| keychain(key)?.get_password().ok())
                {
                    cache.insert(key.clone(), secret.clone());
                    attempt.answered.insert(key.clone(), true);
                    return Some(secret);
                }
            }
            (kind, target, key, error)
        };

        let _dialog = self.dialog.lock().unwrap();
        let (id, receiver) = {
            let mut state = self.state.lock().unwrap();
            let State {
                attempts, cache, ..
            } = &mut *state;
            let attempt = attempts.get_mut(&attempt_id)?;
            if attempt.cancelled {
                return None;
            }
            // Another connection may have been answered while this one waited for the dialog.
            if let (Some(key), None) = (&key, error) {
                if let Some(secret) = cache.get(key).cloned() {
                    attempt.answered.insert(key.clone(), true);
                    return Some(secret);
                }
            }
            state.next_id += 1;
            let id = state.next_id;
            let (sender, receiver) = mpsc::channel();
            state.replies.insert(id, sender);
            let prompt = Prompt {
                id,
                kind,
                target,
                text: text.trim().to_string(),
                error: error.map(str::to_string),
            };
            state.current = Some(prompt.clone());
            let _ = self.app.emit("ssh-prompt", prompt);
            (id, receiver)
        };
        if let Some(window) = self.app.get_webview_window("main") {
            let _ = window.request_user_attention(Some(tauri::UserAttentionType::Informational));
        }
        let reply = receiver
            .recv_timeout(Duration::from_secs(600))
            .ok()
            .flatten();

        let mut state = self.state.lock().unwrap();
        state.replies.remove(&id);
        if state.current.as_ref().is_some_and(|prompt| prompt.id == id) {
            state.current = None;
        }
        let _ = self.app.emit("ssh-prompt-closed", id);
        let State {
            attempts, cache, ..
        } = &mut *state;
        let attempt = attempts.get_mut(&attempt_id)?;
        let Some((secret, remember)) = reply else {
            // Without this, ssh would ask again for every remaining attempt and method.
            attempt.cancelled = true;
            return None;
        };
        if let Some(key) = key {
            cache.insert(key.clone(), secret.clone());
            attempt.answered.insert(key.clone(), false);
            if remember {
                attempt.remember.insert(key, secret.clone());
            }
        }
        Some(if kind == Kind::Confirm {
            "yes".to_string()
        } else {
            secret
        })
    }

    pub fn reply(&self, id: u64, answer: Option<String>, remember: bool) {
        let state = self.state.lock().unwrap();
        if let Some(sender) = state.replies.get(&id) {
            let _ = sender.send(answer.map(|answer| (answer, remember)));
        }
    }

    pub fn current(&self) -> Option<Prompt> {
        self.state.lock().unwrap().current.clone()
    }

    pub fn saved(&self) -> Vec<String> {
        self.read_index()
    }

    pub fn forget(&self, key: &str) {
        self.state.lock().unwrap().cache.remove(key);
        self.forget_saved(key);
    }

    fn forget_saved(&self, key: &str) {
        if let Some(entry) = keychain(key) {
            let _ = entry.delete_credential();
        }
        self.update_index(|keys| keys.retain(|item| item != key));
    }

    /// Keys of the credentials saved in the keychain, which cannot list them itself.
    fn index_file(&self) -> Option<PathBuf> {
        Some(
            self.app
                .path()
                .app_config_dir()
                .ok()?
                .join("ssh-credentials.json"),
        )
    }

    fn read_index(&self) -> Vec<String> {
        self.index_file()
            .and_then(|path| std::fs::read_to_string(path).ok())
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    fn update_index(&self, change: impl FnOnce(&mut Vec<String>)) {
        let Some(path) = self.index_file() else {
            return;
        };
        let _index = self.index.lock().unwrap();
        let mut keys = self.read_index();
        change(&mut keys);
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(text) = serde_json::to_string(&keys) {
            let _ = std::fs::write(path, text);
        }
    }
}

pub struct AttemptGuard {
    askpass: Arc<Askpass>,
    id: u64,
    finished: bool,
}

impl AttemptGuard {
    /// Call once ssh has signed in or failed; saves remembered secrets on success.
    /// Returns whether the user cancelled a prompt.
    pub fn finish(mut self, connected: bool) -> bool {
        self.finished = true;
        self.askpass.finish(self.id, connected)
    }
}

impl Drop for AttemptGuard {
    fn drop(&mut self) {
        if !self.finished {
            self.askpass.finish(self.id, false);
        }
    }
}

fn keychain(key: &str) -> Option<keyring::Entry> {
    keyring::Entry::new(KEYCHAIN_SERVICE, key).ok()
}

fn credential_key(kind: Kind, target: &str) -> String {
    match kind {
        Kind::Passphrase => format!("passphrase:{target}"),
        _ => format!("password:{target}"),
    }
}

/// Works out what ssh is asking for from its prompt text.
fn classify(text: &str, mode: &str, host: &str) -> (Kind, String) {
    let lower = text.to_lowercase();
    if mode == "confirm" || lower.contains("(yes/no") {
        return (Kind::Confirm, host.to_string());
    }
    if lower.contains("passphrase") {
        // "Enter passphrase for key 'C:\Users\me/.ssh/id_ed25519': "
        let key = text
            .split_once('\'')
            .and_then(|(_, rest)| rest.rsplit_once('\''))
            .map(|(path, _)| path.to_string());
        return (Kind::Passphrase, key.unwrap_or_else(|| text.trim().to_string()));
    }
    if lower.contains("password") {
        // "user@host's password: " or keyboard-interactive's "(user@host) Password: "
        let target = text
            .trim()
            .split_once("'s password")
            .map(|(target, _)| target.to_string())
            .or_else(|| {
                text.trim()
                    .strip_prefix('(')
                    .and_then(|rest| rest.split_once(')'))
                    .map(|(target, _)| target.to_string())
            })
            .unwrap_or_else(|| host.to_string());
        return (Kind::Password, target);
    }
    (Kind::Other, host.to_string())
}

/// Entry point when ssh runs GitFerry as SSH_ASKPASS; prints the answer and returns the exit code.
pub fn helper() -> i32 {
    let mode = std::env::var("SSH_ASKPASS_PROMPT").unwrap_or_default();
    // ssh shows "none" prompts as notices (such as "touch your security key") and ignores the reply.
    if mode == "none" {
        return 0;
    }
    let Ok(value) = std::env::var(ENV) else {
        return 1;
    };
    let mut parts = value.splitn(3, ':');
    let (Some(port), Some(Ok(attempt)), Some(token)) = (
        parts.next(),
        parts.next().map(str::parse::<u64>),
        parts.next(),
    ) else {
        return 1;
    };
    let request = HelperRequest {
        token: token.to_string(),
        attempt,
        prompt: std::env::args().nth(1).unwrap_or_default(),
        mode,
    };
    let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port.parse().unwrap_or(0))) else {
        return 1;
    };
    let Ok(text) = serde_json::to_string(&request) else {
        return 1;
    };
    if stream.write_all(format!("{text}\n").as_bytes()).is_err() {
        return 1;
    }
    let mut line = String::new();
    if BufReader::new(&stream).read_line(&mut line).is_err() {
        return 1;
    }
    match serde_json::from_str::<HelperReply>(&line) {
        Ok(HelperReply {
            answer: Some(answer),
        }) => {
            let mut stdout = std::io::stdout();
            let _ = stdout.write_all(format!("{answer}\n").as_bytes());
            let _ = stdout.flush();
            0
        }
        _ => 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_ssh_prompts() {
        let (kind, target) = classify("root@10.0.0.2's password: ", "", "warmer");
        assert!(kind == Kind::Password && target == "root@10.0.0.2");
        let (kind, target) = classify("(git@box) Password: ", "", "box");
        assert!(kind == Kind::Password && target == "git@box");
        let (kind, target) = classify("Password: ", "", "root@warmer");
        assert!(kind == Kind::Password && target == "root@warmer");
        let (kind, target) = classify(
            "Enter passphrase for key 'C:\\Users\\me/.ssh/id_ed25519': ",
            "",
            "warmer",
        );
        assert!(kind == Kind::Passphrase && target == "C:\\Users\\me/.ssh/id_ed25519");
        let (kind, _) = classify(
            "The authenticity of host 'x' can't be established.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ",
            "",
            "x",
        );
        assert!(kind == Kind::Confirm);
        let (kind, _) = classify("Verification code: ", "", "x");
        assert!(kind == Kind::Other);
    }
}
