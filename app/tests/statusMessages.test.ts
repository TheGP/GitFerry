import test from "node:test";
import assert from "node:assert/strict";
import { actionStatus, describeError } from "../src/statusMessages.ts";

test("action wording follows amend, reverse staging, branch names, and the operation being continued", () => {
  assert.equal(actionStatus({ kind: "commit", value: { amend: true } }).running, "Amending commit…");
  assert.equal(actionStatus({ kind: "stage_hunk", value: { reverse: true } }).completed, "Hunk unstaged");
  const pull = actionStatus({ kind: "pull_branch", value: { branch: "Release/Next" } });
  assert.equal(pull.running, "Pulling Release/Next…");
  assert.equal(pull.cancelling, "Cancelling pull Release/Next…");
  assert.equal(actionStatus({ kind: "continue_operation" }, "cherry_pick").running, "Continuing cherry-pick…");
});

test("missing revision errors identify the failed view and give a recovery step", () => {
  for (const raw of ["fatal: bad object deadbeef", "fatal: ambiguous argument 'topic': unknown revision or path not in the working tree."]) {
    const error = describeError(raw, "Changes in src/sync.ts");
    assert.equal(error.summary, "Changes in src/sync.ts: This revision is unavailable");
    assert.equal(error.unavailable, true);
    assert.match(error.help, /Refresh the repository/);
  }
});

test("lease rejection is distinguished from divergence and unfamiliar errors retain their detail", () => {
  assert.equal(describeError("To origin\n ! [rejected] main -> main (stale info)").summary, "The remote branch changed; the push was refused");
  assert.equal(describeError("fatal: Not possible to fast-forward, aborting.").summary, "The branch cannot be updated by fast-forward");
  assert.equal(describeError("Error: fatal: custom hook rejected this commit\nHook details").summary, "custom hook rejected this commit");
  assert.equal(describeError("fatal: custom hook rejected this commit").unavailable, false);
  assert.equal(describeError("Error", "Stash").summary, "Stash: The action failed without an error message");
  assert.equal(describeError("fatal: Unable to create 'index.lock': Permission denied").summary, "Unable to create 'index.lock': Permission denied");
  assert.equal(describeError("fatal: Unable to create 'index.lock': No space left on device").summary, "Not enough disk space");
});
