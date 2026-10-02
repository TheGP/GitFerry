// Verify the desktop executable's Git helper mode without opening a GUI.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const desktop = process.env.GITFERRY_DESKTOP_PATH || process.argv[2];
assert.ok(desktop && fs.existsSync(desktop), "Pass the built desktop executable path");
const folder = fs.mkdtempSync(path.join(os.tmpdir(), "gitferry-reword-"));
const git = (...args) => {
  const result = spawnSync("git", args, { cwd: folder, encoding: "utf8", windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  return result.stdout.trim();
};
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
try {
  git("init", "-q", "-b", "main");
  git("config", "user.name", "GitFerry Test");
  git("config", "user.email", "gitferry@example.test");
  fs.writeFileSync(path.join(folder, "base.txt"), "base\n");
  git("add", "."); git("commit", "-qm", "Base");
  git("switch", "-c", "topic");
  fs.writeFileSync(path.join(folder, "topic.txt"), "topic\n");
  git("add", "."); git("commit", "-qm", "Original message");
  const message = "Reworded by desktop\n\nDetailed explanation";
  const command = `${shellQuote(path.resolve(desktop).replaceAll("\\", "/"))} --amend-message ${shellQuote(folder.replaceAll("\\", "/"))} ${Buffer.from(message).toString("hex")}`;
  git("rebase", "--exec", command, "main");
  assert.equal(git("log", "-1", "--format=%B"), message);
  assert.equal(git("branch", "--show-current"), "topic");
  assert.equal(fs.readFileSync(path.join(folder, "topic.txt"), "utf8"), "topic\n");
  console.log("Desktop Reword helper: actual Git exec amended the message and exited without a GUI");
} finally {
  if (path.dirname(path.resolve(folder)) !== path.resolve(os.tmpdir())) throw new Error("Unexpected test cleanup path");
  fs.rmSync(folder, { recursive: true, force: true });
}
