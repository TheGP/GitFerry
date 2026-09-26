export function formatCommitDate(timestampSeconds: number, now = new Date()): string {
  const commit = new Date(timestampSeconds * 1000);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const lastWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7);
  const time = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(commit);
  if (commit >= today && commit < new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)) return time;
  if (commit >= lastWeek && commit < today) {
    const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(commit);
    return `${weekday}, ${time}`;
  }
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    ...(commit.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  }).format(commit);
}
