const actionMessages = {
  fetch: ["Fetch", "Fetching…", "Fetch complete"],
  pull: ["Pull", "Pulling…", "Pull complete"],
  pull_branch: ["Pull branch", "Pulling branch…", "Branch updated"],
  pull_merge: ["Pull and merge", "Pulling and merging…", "Pull and merge complete"],
  pull_rebase: ["Pull and rebase", "Pulling and rebasing…", "Pull and rebase complete"],
  push: ["Push", "Pushing…", "Push complete"],
  force_push_with_lease: ["Force push with lease", "Pushing with lease protection…", "Force push complete"],
  stage_all: ["Stage all changes", "Staging all changes…", "All changes staged"],
  stage_file: ["Stage file", "Staging file…", "File staged"],
  stage_files: ["Stage files", "Staging files…", "Files staged"],
  unstage_file: ["Unstage file", "Unstaging file…", "File unstaged"],
  unstage_files: ["Unstage files", "Unstaging files…", "Files unstaged"],
  stage_hunk: ["Stage hunk", "Staging hunk…", "Hunk staged"],
  discard_hunk: ["Discard hunk", "Discarding hunk…", "Hunk discarded"],
  stage_lines: ["Stage lines", "Staging lines…", "Lines staged"],
  unstage_lines: ["Unstage lines", "Unstaging lines…", "Lines unstaged"],
  discard_lines: ["Discard lines", "Discarding lines…", "Lines discarded"],
  discard_file: ["Discard file changes", "Discarding file changes…", "File changes discarded"],
  discard_files: ["Discard file changes", "Discarding file changes…", "File changes discarded"],
  delete_untracked: ["Delete untracked files", "Deleting untracked files…", "Untracked files deleted"],
  commit: ["Commit", "Committing…", "Changes committed"],
  amend_no_edit: ["Amend commit", "Amending commit…", "Commit amended"],
  checkout: ["Switch branch", "Switching branch…", "Branch switched"],
  create_branch: ["Create branch", "Creating branch…", "Branch created"],
  track_remote_branch: ["Track remote branch", "Creating tracking branch…", "Tracking branch checked out"],
  delete_branch: ["Delete branch", "Deleting branch…", "Branch deleted"],
  force_delete_branch: ["Force delete branch", "Force deleting branch…", "Branch deleted"],
  rename_branch: ["Rename branch", "Renaming branch…", "Branch renamed"],
  push_branch: ["Push branch", "Pushing branch…", "Branch pushed"],
  delete_remote_branch: ["Delete remote branch", "Deleting remote branch…", "Remote branch deleted"],
  merge: ["Merge", "Merging…", "Merge complete"],
  rebase: ["Rebase", "Rebasing…", "Rebase complete"],
  interactive_rebase: ["Interactive rebase", "Rebasing with your plan…", "Rebase started"],
  continue_operation: ["Continue", "Continuing…", "Continued"],
  abort_operation: ["Abort", "Aborting…", "Aborted"],
  cherry_pick: ["Cherry-pick", "Cherry-picking commit…", "Commit cherry-picked"],
  revert: ["Revert", "Reverting commit…", "Commit reverted"],
  reset: ["Reset", "Resetting branch…", "Branch reset"],
  detach: ["Check out commit", "Checking out commit…", "Commit checked out"],
  stash: ["Stash", "Stashing changes…", "Changes stashed"],
  apply_stash: ["Apply stash", "Applying stash…", "Stash applied"],
  pop_stash: ["Pop stash", "Restoring stash…", "Stash restored"],
  create_tag: ["Create tag", "Creating tag…", "Tag created"],
  delete_tag: ["Delete tag", "Deleting tag…", "Tag deleted"],
  push_tag: ["Push tag", "Pushing tag…", "Tag pushed"],
  delete_remote_tag: ["Delete remote tag", "Deleting remote tag…", "Remote tag deleted"],
  resolve_file: ["Resolve conflict", "Applying conflict resolution…", "Conflict version applied"],
} as const;

export function operationName(operation: string) {
  const names: Record<string, string> = { merge: "Merge", rebase: "Rebase", cherry_pick: "Cherry-pick", revert: "Revert" };
  return names[operation] ?? operation;
}

export function actionStatus(action: { kind: keyof typeof actionMessages; value?: unknown }, inProgress?: string | null) {
  const value = action.value && typeof action.value === "object" ? action.value : null;
  let [label, running, completed]: [string, string, string] = [...actionMessages[action.kind]];
  if (action.kind === "commit" && value && "amend" in value && value.amend === true) [label, running, completed] = [...actionMessages.amend_no_edit];
  if (action.kind === "stage_hunk" && value && "reverse" in value && value.reverse === true) [label, running, completed] = ["Unstage hunk", "Unstaging hunk…", "Hunk unstaged"];
  if (action.kind === "pull_branch" && value && "branch" in value && typeof value.branch === "string") {
    [label, running, completed] = [`Pull ${value.branch}`, `Pulling ${value.branch}…`, `Pull of ${value.branch} complete`];
  }
  if (inProgress && (action.kind === "continue_operation" || action.kind === "abort_operation")) {
    const name = operationName(inProgress);
    [label, running, completed] = action.kind === "continue_operation"
      ? [`Continue ${name}`, `Continuing ${name.toLowerCase()}…`, `${name} continued`]
      : [`Abort ${name}`, `Aborting ${name.toLowerCase()}…`, `${name} aborted`];
  }
  return { label, running, completed, cancelling: `Cancelling ${label[0].toLowerCase()}${label.slice(1)}…` };
}

export function describeError(raw: string, context = "") {
  const text = raw.trim();
  let summary = (text.split(/\r?\n/).find(line => line.trim()) ?? "Something went wrong").replace(/^(?:(?:error|fatal):\s*)+/i, "");
  let help = "";
  const unavailable = /\bbad object\b|\bnot a valid object name\b|\bunknown revision\b|\binvalid object name\b/i.test(text);
  if (!text || text === "Error") {
    summary = "The action failed without an error message";
    help = "Retry the action. Git did not return details about this failure.";
  } else if (unavailable) {
    summary = "This revision is unavailable";
    help = "Git could not find a commit or object needed for this view. Refresh the repository to reload its current history. If it is still missing, fetch from the remote and check the details below.";
  } else if (/\bstale info\b/i.test(text)) {
    summary = "The remote branch changed; the push was refused";
    help = "Fetch and review the remote changes before trying to push again.";
  } else if (/not possible to fast-forward|\bnon-fast-forward\b|divergent branches/i.test(text)) {
    summary = "The branch cannot be updated by fast-forward";
    help = "Fetch and review the remote history. Pull, merge, or rebase as appropriate before trying again.";
  } else if (/would be overwritten|local changes.*overwritten/i.test(text)) {
    summary = "Local changes would be overwritten";
    help = "Commit or stash those changes before retrying.";
  } else if (/permission denied \(publickey|authentication failed|could not read username/i.test(text)) {
    summary = "Authentication failed";
    help = "Check your remote URL and the credentials or SSH key used for this repository.";
  } else if (/could not resolve host|could not resolve hostname|connection refused|connection timed out/i.test(text)) {
    summary = "Could not connect to the remote host";
    help = "Check the host address and connection, then retry.";
  } else if (/no tracking information|has no upstream|no upstream configured/i.test(text)) {
    summary = "This branch has no upstream";
    help = "Set a tracking branch or push this branch to a remote before pulling it.";
  } else if (/no space left on device|not enough space on the disk|disk full/i.test(text)) {
    summary = "Not enough disk space";
    help = "Free space on the affected drive, then retry. The details below identify the file or host involved.";
  } else if (/\.lock[^\r\n]*file exists/i.test(text)) {
    summary = "The repository is locked";
    help = "Wait for the other Git command to finish. If none is running, inspect the lock-file details below.";
  } else if (/not a git repository/i.test(text)) {
    summary = "This folder is not a Git repository";
    help = "Open the repository folder, or check that it is still available on the host.";
  }
  return { summary: context ? `${context}: ${summary}` : summary, help, unavailable };
}
