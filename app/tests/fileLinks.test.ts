import test from "node:test";
import assert from "node:assert/strict";
import { createFileLinkQueue, filePosition, type FileLinkBatch, type ResolvedFileLink } from "../src/fileLinks.ts";

test("positions use 1-based Unicode columns and normalized CRLF offsets", () => {
  assert.equal(filePosition("first\r\n😀x\r\n", 2, 1), 6);
  assert.equal(filePosition("first\r\n😀x\r\n", 2, 2), 8);
  assert.equal(filePosition("first\r\n😀x\r\n", 2, 3), 9);
  assert.equal(filePosition("first\r\n😀x\r\n", 3, 1), 10);
  assert.equal(filePosition("", 1, 1), 0);
  assert.equal(filePosition("\té", 1, 3), 2);
});

test("invalid and out-of-range positions are errors, never clamped", () => {
  for (const [line, column] of [[0, 1], [-1, 1], [1.5, 1], [1, 0], [1, Infinity], [NaN, 1], [Number.MAX_SAFE_INTEGER + 1, 1]]) {
    assert.throws(() => filePosition("one\ntwo", line, column), /positive 1-based/);
  }
  assert.throws(() => filePosition("one\ntwo", 3, 1), /Line 3.*1–2/);
  assert.throws(() => filePosition("😀", 1, 3), /Column 3.*1–2/);
});

const link = (file: string, content = "working\n"): ResolvedFileLink => ({ repository: "/repo", file, content, line: 1, column: 1 });
const batch = (...urls: string[]): FileLinkBatch => ({ links: urls.map((url, id) => ({ id, url, error: null })), dropped: 0 });
const empty = (): FileLinkBatch => ({ links: [], dropped: 0 });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("drains a cold-start backlog, accepts warm clicks and preserves repeated clicks", async () => {
  const deliveries = [batch("a", "a")];
  const opened: string[] = [], errors: string[] = [];
  const queue = createFileLinkQueue({ take: async () => deliveries.shift() ?? empty(), resolve: async url => link(url),
    open: async target => { opened.push(target.file); }, blocked: () => false, error: message => errors.push(message), waiting: () => {} });
  await queue.wake();
  deliveries.push(batch("b"));
  await queue.wake();
  assert.deepEqual(opened, ["a", "a", "b"]);
  assert.deepEqual(errors, []);
  queue.stop();
});

test("a click received while another link resolves is processed afterwards", async () => {
  const first = deferred<ResolvedFileLink>();
  const deliveries = [batch("a")];
  const opened: string[] = [];
  const queue = createFileLinkQueue({ take: async () => deliveries.shift() ?? empty(), resolve: url => url === "a" ? first.promise : Promise.resolve(link(url)),
    open: async target => { opened.push(target.file); }, blocked: () => false, error: message => assert.fail(message), waiting: () => {} });
  const running = queue.wake();
  await Promise.resolve();
  deliveries.push(batch("b"));
  void queue.wake();
  first.resolve(link("a"));
  await running;
  assert.deepEqual(opened, ["a", "b"]);
});

test("unsaved edits pause links, and resuming rereads content changed while waiting", async () => {
  let blocked = true, content = "before save", waiting = 0;
  const deliveries = [batch("a", "b")];
  const opened: string[] = [];
  const queue = createFileLinkQueue({ take: async () => deliveries.shift() ?? empty(), resolve: async url => link(url, content),
    open: async target => { opened.push(target.content); }, blocked: () => blocked, error: message => assert.fail(message), waiting: count => { waiting = count; } });
  await queue.wake();
  assert.equal(waiting, 2);
  assert.deepEqual(opened, []);
  content = "after explicit save"; blocked = false;
  await queue.wake();
  assert.deepEqual(opened, [content, content]);
  assert.equal(waiting, 0);
});

test("a buffer becoming dirty during navigation leaves the request queued", async () => {
  let canOpen = false;
  const deliveries = [batch("a")];
  const opened: string[] = [];
  const queue = createFileLinkQueue({ take: async () => deliveries.shift() ?? empty(), resolve: async url => link(url), blocked: () => false,
    open: async target => { if (!canOpen) return false; opened.push(target.file); }, error: message => assert.fail(message), waiting: () => {} });
  await queue.wake();
  assert.deepEqual(opened, []);
  canOpen = true;
  await queue.wake();
  assert.deepEqual(opened, ["a"]);
});

test("one bad URL reports an error without dropping the following valid file", async () => {
  const deliveries = [batch("bad", "good")];
  const opened: string[] = [], errors: string[] = [];
  const queue = createFileLinkQueue({ take: async () => deliveries.shift() ?? empty(), resolve: async url => { if (url === "bad") throw new Error("Missing file"); return link(url); },
    open: async target => { opened.push(target.file); }, blocked: () => false, error: message => errors.push(message), waiting: () => {} });
  await queue.wake();
  assert.deepEqual(errors, ["Missing file"]);
  assert.deepEqual(opened, ["good"]);
});

test("stopping during resolution never opens a file after the UI is disposed", async () => {
  const pending = deferred<ResolvedFileLink>();
  const deliveries = [batch("a")];
  const opened: string[] = [];
  const queue = createFileLinkQueue({ take: async () => deliveries.shift() ?? empty(), resolve: () => pending.promise,
    open: async target => { opened.push(target.file); }, blocked: () => false, error: message => assert.fail(message), waiting: () => {} });
  const running = queue.wake();
  await Promise.resolve(); queue.stop(); pending.resolve(link("a"));
  await running;
  assert.deepEqual(opened, []);
});

test("a paused UI queue remains bounded across multiple native deliveries", async () => {
  let blocked = true;
  const deliveries = [batch(...Array.from({ length: 130 }, (_, index) => String(index)))];
  const opened: string[] = [], errors: string[] = [];
  const queue = createFileLinkQueue({ take: async () => deliveries.shift() ?? empty(), resolve: async url => link(url),
    open: async target => { opened.push(target.file); }, blocked: () => blocked, error: message => errors.push(message), waiting: () => {} });
  await queue.wake();
  deliveries.push(batch("another"));
  await queue.wake();
  assert.match(errors[0], /2 links were not queued/);
  assert.match(errors[1], /1 links were not queued/);
  blocked = false;
  await queue.wake();
  assert.equal(opened.length, 128);
  assert.equal(opened[0], "0");
  assert.equal(opened[127], "127");
});
