/**
 * Finish reasons: each red test, and each existing test the turn changed or
 * deleted, gets a `testReasons` entry. The reply and review list them under
 * the test status line as the Agent wrote them; that visible list is the
 * guard, so the check only refuses a missing or empty reason.
 */

/** A usable reason for `name`: nonempty, and more than the test's name. */
function reasonFor(entries: readonly unknown[], name: string): string | undefined {
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const { test, reason } = entry as Record<string, unknown>;
    if (test !== name || typeof reason !== "string") continue;
    const text = reason.trim();
    if (text && text.replace(/[.!?:;,]+$/u, "").toLowerCase() !== name.trim().toLowerCase())
      return text;
  }
  return undefined;
}

/** The `test: reason` lines for the named tests, and the names still without a reason. */
export function readTestReasons(
  testReasons: unknown,
  names: readonly string[],
): { readonly lines: readonly string[]; readonly missing: readonly string[] } {
  const entries = Array.isArray(testReasons) ? testReasons : [];
  const lines: string[] = [];
  const missing: string[] = [];
  for (const name of new Set(names)) {
    const reason = reasonFor(entries, name);
    if (reason === undefined) missing.push(name);
    else lines.push(`${name}: ${reason}`);
  }
  return { lines, missing };
}

/** The status line, then each reason the reply does not already give. */
export function finishReport(
  status: string | undefined,
  lines: readonly string[] | undefined,
  reply = "",
): string {
  const extra = (lines ?? []).filter((line) => !reply.includes(line));
  return [status ?? "", ...extra.map((line) => `- ${line}`)].filter(Boolean).join("\n");
}

/** The reply under its test status and each reason it does not already give. */
export function withFinishReport(
  status: string | undefined,
  lines: readonly string[] | undefined,
  reply: string,
  separator: string,
): string {
  if (!(lines ?? []).some((line) => !reply.includes(line)))
    return !status || reply.startsWith(status) ? reply : `${status}${separator}${reply}`;
  const body = status && reply.startsWith(status) ? reply.slice(status.length).trimStart() : reply;
  return [finishReport(status, lines, body), body].filter(Boolean).join(separator);
}
