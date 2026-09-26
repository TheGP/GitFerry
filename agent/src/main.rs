use gitferry_agent::{action_with_progress, amend_rebase_message, handle, write_rebase_todo};
use gitferry_proto::{Request, Response, RpcRequest, RpcResponse};
use std::io::{self, BufRead, Write};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().is_some_and(|arg| arg == "--write-todo") {
        if let Err(error) = write_rebase_todo(&args[1..]) {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    if args.first().is_some_and(|arg| arg == "--amend-message") {
        if let Err(error) = amend_rebase_message(&args[1..]) {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let response = match serde_json::from_str::<RpcRequest>(&line) {
            Ok(RpcRequest { id, request }) => {
                let response = match request {
                    Request::Action {
                        path,
                        action,
                        cancel_token,
                    } => action_with_progress(&path, action, cancel_token.as_deref(), |message| {
                        let update = RpcResponse {
                            id,
                            response: Response::Progress(message.to_string()),
                        };
                        let _ = serde_json::to_writer(&mut stdout, &update);
                        let _ = writeln!(stdout);
                        let _ = stdout.flush();
                    })
                    .map(Response::Action)
                    .unwrap_or_else(Response::Error),
                    other => handle(other),
                };
                RpcResponse { id, response }
            }
            Err(error) => RpcResponse {
                id: 0,
                response: Response::Error(format!("Invalid request: {error}")),
            },
        };
        if serde_json::to_writer(&mut stdout, &response).is_err()
            || writeln!(stdout).is_err()
            || stdout.flush().is_err()
        {
            break;
        }
    }
}
