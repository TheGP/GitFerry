use std::path::Path;

use gitferry_proto::WorkingFile;

/// Discover from the file, not an open tab or the common Git directory: nested repositories and
/// linked worktrees must retain their own checkout. No index, branch, or working files are changed.
pub fn working_file(file: &str, repository: Option<&str>) -> Result<WorkingFile, String> {
    let requested = Path::new(file);
    if !requested.is_absolute() {
        return Err("File links require an absolute file path on the target computer".into());
    }
    let file = requested
        .canonicalize()
        .map_err(|error| format!("Cannot open file {file}: {error}"))?;
    if !file.is_file() {
        return Err("The file link must point to a regular file".into());
    }
    let parent = file.parent().ok_or("The file has no parent directory")?;
    // Do not use the repository cache here: a nested repository may have been created since a
    // previous click. rev-parse discovers the nearest checkout without invoking a file or shell.
    let output = super::git(parent, &["rev-parse", "--show-toplevel"]).map_err(|error| {
        format!("The file is not inside an available Git working tree: {error}")
    })?;
    let path = std::str::from_utf8(&output.stdout)
        .map_err(|_| "Repository paths must be valid Unicode")?;
    let path = path
        .strip_suffix("\r\n")
        .or_else(|| path.strip_suffix('\n'))
        .unwrap_or(path);
    let root = Path::new(path)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if let Some(expected) = repository {
        if !Path::new(expected).is_absolute() {
            return Err("The explicit repository must be an absolute working-tree path".into());
        }
        let expected = Path::new(expected)
            .canonicalize()
            .map_err(|error| format!("Cannot open the explicit repository: {error}"))?;
        if root != expected {
            return Err("The file belongs to a different repository or worktree. Omit repository for automatic discovery, or use that checkout's root.".into());
        }
    }
    let relative = file
        .strip_prefix(&root)
        .map_err(|_| "The file is outside the repository")?;
    let file = relative
        .components()
        .map(|part| {
            part.as_os_str()
                .to_str()
                .ok_or("File paths must be valid Unicode")
        })
        .collect::<Result<Vec<_>, _>>()?
        .join("/");
    let repository = super::display_path(&root);
    let content = super::read_file(&repository, &file)?.content;
    Ok(WorkingFile {
        repository,
        file,
        content,
    })
}

#[cfg(all(test, windows))]
#[test]
fn unc_worktrees_keep_their_absolute_network_prefix() {
    assert_eq!(
        super::display_path(Path::new(r"\\?\UNC\server\share\repo")),
        r"\\server\share\repo"
    );
}
