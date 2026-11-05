export type PendingFileLink = { id: number; url: string | null; error: string | null };
export type FileLinkBatch = { links: PendingFileLink[]; dropped: number };
export type ResolvedFileLink = { repository: string; file: string; content: string; line: number; column: number };

/** URL positions are 1-based Unicode code points. Textareas use UTF-16 offsets internally. */
export function filePosition(content: string, line: number, column: number): number {
  if (!Number.isSafeInteger(line) || line < 1 || !Number.isSafeInteger(column) || column < 1) throw new Error("Line and column must be positive 1-based integers");
  const normalized = content.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  if (line > lines.length) throw new Error(`Line ${line} is outside this file (1–${lines.length})`);
  const characters = Array.from(lines[line - 1]);
  if (column > characters.length + 1) throw new Error(`Column ${column} is outside line ${line} (1–${characters.length + 1})`);
  let offset = 0;
  for (let index = 0; index < line - 1; index++) offset += lines[index].length + 1;
  return offset + characters.slice(0, column - 1).join("").length;
}

/** Serializes OS deliveries, including wakeups arriving during a drain. Paused links stay queued. */
export function createFileLinkQueue(options: {
  take: () => Promise<FileLinkBatch>;
  open: (link: ResolvedFileLink) => Promise<boolean | void>;
  resolve: (url: string) => Promise<ResolvedFileLink>;
  blocked: (link: ResolvedFileLink) => boolean;
  error: (message: string) => void;
  waiting: (count: number) => void;
}) {
  const pending: PendingFileLink[] = [];
  let resolved: ResolvedFileLink | null = null;
  let running: Promise<void> | null = null;
  let requested = false;
  let stopped = false;
  const wake = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    requested = true;
    if (running) return running;
    running = (async () => {
      while (!stopped && requested) {
        requested = false;
        const batch = await options.take();
        const available = Math.max(0, 128 - pending.length);
        const dropped = batch.dropped + Math.max(0, batch.links.length - available);
        pending.push(...batch.links.slice(0, available));
        if (dropped) options.error(`Too many file links arrived at once; ${dropped} links were not queued. Click them again.`);
        while (!stopped && pending.length) {
          const request = pending[0];
          try {
            if (request.error) throw new Error(request.error);
            if (!request.url) throw new Error("The file link has no URL");
            resolved ??= await options.resolve(request.url);
            if (stopped) return;
            if (options.blocked(resolved)) { resolved = null; options.waiting(pending.length); return; }
            if (await options.open(resolved) === false) { resolved = null; options.waiting(pending.length); return; }
          } catch (cause) { options.error(cause instanceof Error ? cause.message : String(cause)); }
          pending.shift(); resolved = null;
          options.waiting(0);
        }
      }
    })().catch(cause => options.error(cause instanceof Error ? cause.message : String(cause))).finally(() => {
      running = null;
      if (requested && !stopped) void wake();
    });
    return running;
  };
  return { wake, stop: () => { stopped = true; pending.length = 0; resolved = null; } };
}
