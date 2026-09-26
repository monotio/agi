/**
 * "12 min ago" for the Home screen's last-played line. English only, like the
 * rest of the shell; past a week it names the date instead.
 */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function formatRelativeTime(then: number, now: number): string {
  const elapsed = now - then;
  if (!Number.isFinite(elapsed)) return "";
  // A clock that moved backwards reads as the present, not the future.
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`;
  if (elapsed < DAY) {
    const hours = Math.floor(elapsed / HOUR);
    return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  }
  if (elapsed < 7 * DAY) {
    const days = Math.floor(elapsed / DAY);
    return `${days} ${days === 1 ? "day" : "days"} ago`;
  }
  const date = new Date(then);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return `on ${date.toLocaleDateString("en", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  })}`;
}
