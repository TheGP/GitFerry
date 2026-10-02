//! Times the reads GitFerry repeats on every refresh through the Git CLI, gitoxide and libgit2.
//!
//! `gitferry-bench run [--iterations N] <repo>...` prints one table per repository.
//! `gitferry-bench generate <dir> [files] [commits]` builds a large synthetic repository to run it on.

use gitferry_agent::{gix_reads, snapshot_with, state_with, ReadBackend};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

mod libgit2;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("generate") if args.len() >= 2 => {
            let number = |index: usize, default: usize| {
                args.get(index)
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(default)
            };
            generate(Path::new(&args[1]), number(2, 50_000), number(3, 5_000))
        }
        Some("run") => run(&args[1..]),
        _ => Err("usage: gitferry-bench run [--iterations N] <repo>... | generate <dir> [files] [commits]".to_string()),
    };
    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

/// Runs Git the way the agent does, without optional locks so reads never rewrite the index.
fn git(repo: &Path, args: &[&str]) -> Result<Output, String> {
    let mut command = Command::new("git");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let output = command
        .arg("--no-optional-locks")
        .arg("-C")
        .arg(repo)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .output()
        .map_err(|error| error.to_string())?;
    if output.status.success() {
        Ok(output)
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

type Operation<'a> = Box<dyn FnMut() -> Result<(), String> + 'a>;

struct Row<'a> {
    name: &'static str,
    git: Option<Operation<'a>>,
    gix: Option<Operation<'a>>,
    libgit2: Option<Operation<'a>>,
}

/// Median and fastest run in milliseconds after one warm-up run.
fn measure(operation: &mut Operation, iterations: usize) -> Result<(f64, f64), String> {
    operation()?;
    let mut times: Vec<Duration> = Vec::with_capacity(iterations);
    for _ in 0..iterations {
        let start = Instant::now();
        operation()?;
        times.push(start.elapsed());
    }
    times.sort();
    let ms = |time: Duration| time.as_secs_f64() * 1000.0;
    Ok((ms(times[times.len() / 2]), ms(times[0])))
}

fn cell(operation: Option<&mut Operation>, iterations: usize) -> (String, Option<f64>) {
    match operation.map(|operation| measure(operation, iterations)) {
        None => ("—".to_string(), None),
        Some(Ok((median, fastest))) => (format!("{median:.1} ({fastest:.1})"), Some(median)),
        Some(Err(error)) => (
            format!("error: {}", error.lines().next().unwrap_or("")),
            None,
        ),
    }
}

fn run(args: &[String]) -> Result<(), String> {
    let mut iterations = 15;
    let mut repos = Vec::new();
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        if arg == "--iterations" {
            iterations = args
                .next()
                .and_then(|value| value.parse().ok())
                .ok_or("--iterations needs a number")?;
        } else {
            repos.push(PathBuf::from(arg));
        }
    }
    if repos.is_empty() {
        return Err("name at least one repository".to_string());
    }
    for repo in repos {
        let root = std::fs::canonicalize(&repo).map_err(|error| error.to_string())?;
        bench_repo(&root, iterations)?;
    }
    Ok(())
}

fn describe(root: &Path) -> String {
    let count = |args: &[&str]| {
        git(root, args)
            .map(|output| {
                output
                    .stdout
                    .split(|byte| *byte == b'\n')
                    .filter(|line| !line.is_empty())
                    .count()
            })
            .unwrap_or(0)
    };
    format!(
        "{} files, {} commits, {} refs, {} changed paths",
        count(&["ls-files"]),
        git(root, &["rev-list", "--all", "--count"])
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
            .unwrap_or_default(),
        count(&["for-each-ref"]),
        count(&["status", "--porcelain", "--untracked-files=all"]),
    )
}

fn bench_repo(root: &Path, iterations: usize) -> Result<(), String> {
    let path = root.to_str().ok_or("repository path is not UTF-8")?;
    println!("\n### {}\n\n{}\n", root.display(), describe(root));
    parity(root, path);

    let log_format = "--format=%H%x00%P%x00%s%x00%an%x00%at%x00%D%x1e";
    let has_staged = git(root, &["diff", "--cached", "--quiet"]).is_err();
    let libgit2 = libgit2::open(root)?;
    let gix = || gix_reads::open(root);

    let mut rows: Vec<Row> = vec![
        Row {
            name: "open repository (uncached)",
            git: None,
            gix: Some(Box::new(|| {
                gix::ThreadSafeRepository::open(root)
                    .map(drop)
                    .map_err(|e| e.to_string())
            })),
            libgit2: Some(Box::new(|| libgit2::open(root).map(drop))),
        },
        Row {
            name: "open repository and read index",
            git: None,
            gix: Some(Box::new(|| {
                let repo = gix_reads::open(root)?;
                repo.index_or_empty().map(drop).map_err(|e| e.to_string())
            })),
            libgit2: Some(Box::new(|| libgit2::open(root)?.index().map(drop).map_err(|e| e.to_string()))),
        },
        Row {
            name: "HEAD and branch",
            git: Some(Box::new(|| {
                git(root, &["symbolic-ref", "--quiet", "--short", "HEAD"]).ok();
                git(root, &["rev-parse", "--verify", "HEAD"]).map(drop)
            })),
            gix: Some(Box::new(|| gix_reads::head(&gix()?).map(drop))),
            libgit2: Some(Box::new(|| libgit2::head(&libgit2).map(drop))),
        },
        Row {
            name: "status (-uall)",
            git: Some(Box::new(|| {
                git(
                    root,
                    &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
                )?;
                if has_staged {
                    git(
                        root,
                        &[
                            "diff",
                            "--cached",
                            "--raw",
                            "--no-renames",
                            "--abbrev=40",
                            "-z",
                        ],
                    )?;
                }
                Ok(())
            })),
            gix: Some(Box::new(|| gix_reads::status(&gix()?, root).map(drop))),
            libgit2: Some(Box::new(|| libgit2::status(&libgit2).map(drop))),
        },
        Row {
            name: "refs + ahead/behind + stashes",
            git: Some(Box::new(|| {
                git(
                    root,
                    &[
                        "for-each-ref",
                        "--format=%(refname)%00%(objectname)%00%(upstream:track)%00%(*objectname)%00",
                        "refs/heads",
                        "refs/remotes",
                        "refs/tags",
                    ],
                )?;
                git(root, &["stash", "list", "--format=%gd%x00%H%x00%gs%x1e"]).map(drop)
            })),
            gix: Some(Box::new(|| {
                let repo = gix()?;
                let head = gix_reads::head(&repo)?;
                let references = gix_reads::resolve(&repo, gix_reads::raw_references(&repo)?);
                gix_reads::ref_entries(&repo, &references, &head);
                Ok(())
            })),
            libgit2: Some(Box::new(|| libgit2::refs(&libgit2).map(drop))),
        },
        Row {
            name: "history page (100 commits)",
            git: Some(Box::new(|| {
                git(
                    root,
                    &["log", "HEAD", "--all", "--max-count=101", log_format],
                )
                .map(drop)
            })),
            gix: Some(Box::new(|| {
                let repo = gix()?;
                let head = gix_reads::head(&repo)?;
                let references = gix_reads::resolve(&repo, gix_reads::raw_references(&repo)?);
                gix_reads::log(&repo, &references, &head, 0, 100).map(drop)
            })),
            libgit2: Some(Box::new(|| libgit2::log(&libgit2, 0, 100).map(drop))),
        },
        Row {
            name: "history page at offset 2000",
            git: Some(Box::new(|| {
                git(
                    root,
                    &[
                        "log",
                        "HEAD",
                        "--all",
                        "--skip=2000",
                        "--max-count=101",
                        log_format,
                    ],
                )
                .map(drop)
            })),
            gix: Some(Box::new(|| {
                let repo = gix()?;
                let head = gix_reads::head(&repo)?;
                let references = gix_reads::resolve(&repo, gix_reads::raw_references(&repo)?);
                gix_reads::log(&repo, &references, &head, 2000, 100).map(drop)
            })),
            libgit2: Some(Box::new(|| libgit2::log(&libgit2, 2000, 100).map(drop))),
        },
        Row {
            name: "**state** (every file change)",
            git: Some(Box::new(|| state_with(path, ReadBackend::Git).map(drop))),
            gix: Some(Box::new(|| state_with(path, ReadBackend::Gix).map(drop))),
            libgit2: Some(Box::new(|| libgit2::state(&libgit2).map(drop))),
        },
        Row {
            name: "**snapshot** (open, refs moved)",
            git: Some(Box::new(|| {
                snapshot_with(path, 0, 100, ReadBackend::Git).map(drop)
            })),
            gix: Some(Box::new(|| {
                snapshot_with(path, 0, 100, ReadBackend::Gix).map(drop)
            })),
            libgit2: Some(Box::new(|| libgit2::snapshot(&libgit2).map(drop))),
        },
    ];

    println!("median ms (fastest), {iterations} runs\n");
    println!("| read | git CLI | gitoxide | libgit2 | gitoxide vs CLI |");
    println!("|---|---:|---:|---:|---:|");
    for row in &mut rows {
        let (git_cell, git_ms) = cell(row.git.as_mut(), iterations);
        let (gix_cell, gix_ms) = cell(row.gix.as_mut(), iterations);
        let (libgit2_cell, _) = cell(row.libgit2.as_mut(), iterations);
        let speedup = match (git_ms, gix_ms) {
            (Some(git), Some(gix)) if gix > 0.0 => format!("{:.1}×", git / gix),
            _ => "—".to_string(),
        };
        println!(
            "| {} | {git_cell} | {gix_cell} | {libgit2_cell} | {speedup} |",
            row.name
        );
        std::io::stdout().flush().ok();
    }
    Ok(())
}

/// Reports whether gitoxide and libgit2 read the same data as the Git CLI.
fn parity(root: &Path, path: &str) {
    let json = |backend| {
        snapshot_with(path, 0, 100, backend).map(|snapshot| {
            let mut value = serde_json::to_value(snapshot).unwrap_or_default();
            value["refsHash"] = serde_json::Value::Null;
            value
        })
    };
    let reference = json(ReadBackend::Git);
    let gix = json(ReadBackend::Gix);
    match (&reference, &gix) {
        (Ok(git), Ok(gix)) => {
            let differing: Vec<&str> = git
                .as_object()
                .map(|fields| {
                    fields
                        .keys()
                        .filter(|key| git[key.as_str()] != gix[key.as_str()])
                        .map(String::as_str)
                        .collect()
                })
                .unwrap_or_default();
            if differing.is_empty() {
                println!("gitoxide output: identical to the Git CLI\n");
            } else {
                println!(
                    "gitoxide output: differs from the Git CLI in {}\n",
                    differing.join(", ")
                );
                for key in differing {
                    let list = |value: &serde_json::Value| -> Vec<String> {
                        match value.as_array() {
                            Some(items) => items.iter().map(|item| item.to_string()).collect(),
                            None => vec![value.to_string()],
                        }
                    };
                    let (ours, theirs) = (list(&gix[key]), list(&git[key]));
                    for item in theirs.iter().filter(|item| !ours.contains(item)).take(5) {
                        println!("- git only: {item}");
                    }
                    for item in ours.iter().filter(|item| !theirs.contains(item)).take(5) {
                        println!("- gitoxide only: {item}");
                    }
                }
                println!();
            }
        }
        (Err(error), _) | (_, Err(error)) => println!("gitoxide parity check failed: {error}\n"),
    }
    if let (Ok(git), Ok(repo)) = (&reference, libgit2::open(root)) {
        let summary = libgit2::compare(&repo, git);
        println!("libgit2 output: {summary}\n");
    }
}

/// Writes a repository with `files` files and `commits` commits, many branches, tags, upstreams, a stash
/// and uncommitted changes, using `git fast-import`.
fn generate(dir: &Path, files: usize, commits: usize) -> Result<(), String> {
    if dir.exists() {
        return Err(format!("{} already exists", dir.display()));
    }
    std::fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    let init = |args: &[&str]| {
        let status = Command::new("git").arg("-C").arg(dir).args(args).status();
        match status {
            Ok(status) if status.success() => Ok(()),
            _ => Err(format!("git {args:?} failed")),
        }
    };
    init(&["init", "-q", "-b", "main"])?;
    init(&["config", "user.name", "Bench"])?;
    init(&["config", "user.email", "bench@example.com"])?;
    init(&["config", "core.autocrlf", "false"])?;

    let mut seed: u64 = 0x2545_f491_4f6c_dd1d;
    let mut random = move |limit: usize| {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        (seed % limit as u64) as usize
    };
    // About 17 files per directory, like real projects.
    let file_path = |index: usize| {
        format!(
            "src/module_{:03}/part_{:02}/file_{index}.rs",
            index % 150,
            index / 150 % 20
        )
    };
    let mut stream = Vec::new();
    let data = |stream: &mut Vec<u8>, content: &str| {
        stream.extend_from_slice(format!("data {}\n{content}\n", content.len()).as_bytes());
    };
    let signature = |time: usize| {
        format!(
            "Bench <bench@example.com> {} +0000",
            1_700_000_000 + time * 97
        )
    };
    let mut marks = Vec::with_capacity(commits);
    for number in 0..commits {
        let mark = number + 1;
        stream.extend_from_slice(format!("commit refs/heads/main\nmark :{mark}\n").as_bytes());
        stream.extend_from_slice(
            format!(
                "author {}\ncommitter {}\n",
                signature(number),
                signature(number)
            )
            .as_bytes(),
        );
        data(
            &mut stream,
            &format!("Change {number}\n\nTouches a few files."),
        );
        if number == 0 {
            for index in 0..files {
                let content = format!("// file {index}\npub fn value() -> usize {{ {index} }}\n");
                stream.extend_from_slice(
                    format!("M 100644 inline {}\n", file_path(index)).as_bytes(),
                );
                data(&mut stream, &content);
            }
        } else {
            stream.extend_from_slice(format!("from :{}\n", mark - 1).as_bytes());
            for _ in 0..4 {
                let index = random(files);
                let content = format!(
                    "// file {index}\npub fn value() -> usize {{ {} }}\n",
                    index + number
                );
                stream.extend_from_slice(
                    format!("M 100644 inline {}\n", file_path(index)).as_bytes(),
                );
                data(&mut stream, &content);
            }
        }
        marks.push(mark);
    }
    // Feature branches with their own commits off recent history, tags spread over all of it.
    let mut next_mark = commits + 1;
    for branch in 0..60 {
        let base = commits - 1 - random(commits.min(400));
        for step in 0..3 {
            stream.extend_from_slice(
                format!("commit refs/heads/feature/{branch:02}\nmark :{next_mark}\n").as_bytes(),
            );
            let time = commits + branch * 3 + step;
            stream.extend_from_slice(
                format!(
                    "author {}\ncommitter {}\n",
                    signature(time),
                    signature(time)
                )
                .as_bytes(),
            );
            data(&mut stream, &format!("Feature {branch} step {step}"));
            let parent = if step == 0 {
                marks[base]
            } else {
                next_mark - 1
            };
            stream.extend_from_slice(format!("from :{parent}\n").as_bytes());
            let index = random(files);
            stream.extend_from_slice(format!("M 100644 inline {}\n", file_path(index)).as_bytes());
            data(&mut stream, &format!("// feature {branch} {step}\n"));
            next_mark += 1;
        }
    }
    for tag in 0..200 {
        let target = marks[tag * commits / 200];
        if tag % 2 == 0 {
            stream.extend_from_slice(
                format!("reset refs/tags/v{tag}\nfrom :{target}\n\n").as_bytes(),
            );
        } else {
            stream.extend_from_slice(
                format!("tag v{tag}\nfrom :{target}\ntagger {}\n", signature(tag)).as_bytes(),
            );
            data(&mut stream, &format!("Release {tag}"));
        }
    }
    // Remote-tracking branches a little behind or ahead of their local branches.
    for branch in 0..20 {
        let local = commits + branch * 3 + 1 + (branch % 3);
        stream.extend_from_slice(
            format!("reset refs/remotes/origin/feature/{branch:02}\nfrom :{local}\n\n").as_bytes(),
        );
    }
    stream.extend_from_slice(
        format!(
            "reset refs/remotes/origin/main\nfrom :{}\n\n",
            marks[commits - 3]
        )
        .as_bytes(),
    );

    let mut import = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["fast-import", "--quiet"])
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|error| error.to_string())?;
    import
        .stdin
        .take()
        .ok_or("fast-import stdin unavailable")?
        .write_all(&stream)
        .map_err(|error| error.to_string())?;
    if !import.wait().map_err(|error| error.to_string())?.success() {
        return Err("git fast-import failed".to_string());
    }
    init(&["checkout", "-q", "-f", "main"])?;
    init(&[
        "config",
        "remote.origin.url",
        "https://example.com/bench.git",
    ])?;
    init(&[
        "config",
        "remote.origin.fetch",
        "+refs/heads/*:refs/remotes/origin/*",
    ])?;
    init(&["branch", "-q", "--set-upstream-to=origin/main", "main"])?;
    for branch in 0..20 {
        init(&[
            "branch",
            "-q",
            &format!("--set-upstream-to=origin/feature/{branch:02}"),
            &format!("feature/{branch:02}"),
        ])?;
    }
    // A stash with untracked files, then everyday uncommitted work: edits, a few staged, new files.
    let edit = |index: usize, text: &str| std::fs::write(dir.join(file_path(index)), text);
    edit(1, "stashed\n").map_err(|error| error.to_string())?;
    std::fs::write(dir.join("stashed-untracked.txt"), "untracked\n")
        .map_err(|error| error.to_string())?;
    init(&["stash", "push", "-q", "-u", "-m", "Work in progress"])?;
    for index in 0..25 {
        edit(index * 37 % files, &format!("edited {index}\n"))
            .map_err(|error| error.to_string())?;
    }
    let staged: Vec<String> = (0..5).map(|index| file_path(index * 37 % files)).collect();
    let mut add = vec!["add", "--"];
    add.extend(staged.iter().map(String::as_str));
    init(&add)?;
    for index in 0..10 {
        let path = dir.join(format!("notes/draft_{index}.md"));
        std::fs::create_dir_all(path.parent().unwrap()).map_err(|error| error.to_string())?;
        std::fs::write(path, "draft\n").map_err(|error| error.to_string())?;
    }
    println!(
        "generated {} with {files} files and {commits} commits",
        dir.display()
    );
    Ok(())
}
