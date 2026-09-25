use gitferry_agent::handle;
use gitferry_proto::{Response, RpcRequest, RpcResponse};
use std::io::{self, BufRead, Write};

fn main() {
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let response = match serde_json::from_str::<RpcRequest>(&line) {
            Ok(request) => RpcResponse {
                id: request.id,
                response: handle(request.request),
            },
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
