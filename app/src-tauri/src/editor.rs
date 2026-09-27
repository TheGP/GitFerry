use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

use crate::remote;

fn relative_file(file: &str) -> Result<(), String> {
    let path = Path::new(file);
    if file.is_empty()
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
        || file
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err("Invalid repository file path".to_string());
    }
    Ok(())
}

fn editor_command(editor: &str, executable: &str) -> Result<String, String> {
    if !executable.trim().is_empty() {
        return Ok(executable.trim().to_string());
    }
    let default = match editor {
        "antigravity" => {
            if cfg!(windows) {
                "antigravity.cmd"
            } else {
                "antigravity"
            }
        }
        "vscode" => {
            if cfg!(windows) {
                "code.cmd"
            } else {
                "code"
            }
        }
        "sublime" => {
            if cfg!(windows) {
                "subl.exe"
            } else {
                "subl"
            }
        }
        _ => return Err("Choose an editor in Settings".to_string()),
    };
    Ok(default.to_string())
}

fn destination(repo: &str, file: &str, editor: &str) -> Result<(String, Option<String>), String> {
    relative_file(file)?;
    if repo.starts_with("ssh://") {
        if editor == "sublime" {
            return Err("Sublime Text needs a local checkout to open files. Choose Antigravity or VS Code with Remote SSH for this repository.".to_string());
        }
        let (host, root) = remote::parse_uri(repo)?;
        let path = format!("{}/{}", root.trim_end_matches('/'), file);
        return Ok((path, Some(format!("ssh-remote+{host}"))));
    }
    let root = PathBuf::from(repo)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let file_path = root
        .join(file)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !file_path.starts_with(&root) || !file_path.is_file() {
        return Err("File is unavailable in the current working tree".to_string());
    }
    Ok((plain_path(&file_path), None))
}

/// `canonicalize` returns verbatim `\\?\C:\...` paths on Windows, which editors do not open as regular files.
fn plain_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else if let Some(local) = text.strip_prefix(r"\\?\") {
        local.to_string()
    } else {
        text.into_owned()
    }
}

pub fn open(
    repo: &str,
    file: &str,
    line: u32,
    editor: &str,
    executable: &str,
) -> Result<(), String> {
    if line == 0 {
        return Err("Line number must be positive".to_string());
    }
    if !matches!(editor, "antigravity" | "vscode" | "sublime") {
        return Err("Choose an editor in Settings".to_string());
    }
    let (path, remote) = destination(repo, file, editor)?;
    let program = editor_command(editor, executable)?;
    let mut command = Command::new(&program);
    if let Some(authority) = remote {
        command.args(["--remote", &authority]);
    }
    if editor != "sublime" {
        command.arg("--goto");
    }
    command.arg(format!("{path}:{line}"));
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Editor launchers are often .cmd files; never show a transient console.
        command.creation_flags(0x0800_0000);
    }
    command.spawn().map_err(|error| {
        format!("Could not launch {program}: {error}. Set the editor command in Settings.")
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::plain_path;
    use std::path::Path;

    #[test]
    fn strips_windows_verbatim_prefixes() {
        assert_eq!(
            plain_path(Path::new(r"\\?\C:\repo\file.ts")),
            r"C:\repo\file.ts"
        );
        assert_eq!(
            plain_path(Path::new(r"\\?\UNC\server\share\file.ts")),
            r"\\server\share\file.ts"
        );
        assert_eq!(
            plain_path(Path::new("/home/me/file.ts")),
            "/home/me/file.ts"
        );
    }
}
