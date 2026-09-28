// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // ssh runs GitFerry as its SSH_ASKPASS program to ask for passwords.
    if std::env::var_os("GITFERRY_ASKPASS").is_some() {
        std::process::exit(gitferry_lib::askpass_helper());
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().is_some_and(|arg| arg == "--write-todo") {
        if let Err(error) = gitferry_agent::write_rebase_todo(&args[1..]) {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    gitferry_lib::run()
}
