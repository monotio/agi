/**
 * Finish notes explain each red or changed test in a sentence of its own.
 * The sentences the Agent wrote become the list the creator sees under the
 * test status line, in the reply and in review.
 */

/** "2 tests fail: a, b" or "All 3 tests pass." — the status line, never a reason. */
const STATUS = /^(?:\d+ tests? fails?:|all \d+ tests? pass)/i;
const BULLET = /^\s*(?:[-*•+]|\d+[.)])\s+/;
const WORD = /\p{L}{2,}/gu;

function sentences(notes: string): string[] {
  return notes
    .split(/\n+/)
    .flatMap((line) => line.replace(BULLET, "").split(/(?<=[.!?])\s+(?=\S)/))
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence && !STATUS.test(sentence));
}

/** Remove each case-insensitive whole-word occurrence of `name`; null when absent. */
function withoutName(text: string, name: string): string | null {
  const lower = text.toLowerCase();
  const needle = name.toLowerCase();
  let found = false;
  let out = "";
  let from = 0;
  for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, at + needle.length)) {
    const before = text[at - 1];
    const after = text[at + needle.length];
    if ((before && /[\p{L}\p{N}]/u.test(before)) || (after && /[\p{L}\p{N}]/u.test(after)))
      continue;
    found = true;
    out += `${text.slice(from, at)} `;
    from = at + needle.length;
  }
  return found ? out + text.slice(from) : null;
}

/**
 * Match every named test to the first notes sentence that names it and says
 * something more: after removing the test names, at least two words remain.
 * Longer names match first, so "look" never claims "look describes clearing".
 */
export function readFinishNotes(
  notes: unknown,
  names: readonly string[],
): { readonly lines: readonly string[]; readonly missing: readonly string[] } {
  const all = typeof notes === "string" ? sentences(notes) : [];
  const ordered = [...new Set(names)].sort((a, b) => b.length - a.length);
  const covered = new Map<string, string>();
  for (const sentence of all) {
    let rest = sentence;
    const named: string[] = [];
    for (const name of ordered) {
      const next = withoutName(rest, name);
      if (next === null) continue;
      named.push(name);
      rest = next;
    }
    if ((rest.match(WORD) ?? []).length < 2) continue;
    for (const name of named) if (!covered.has(name)) covered.set(name, sentence);
  }
  return {
    lines: [...new Set(names.flatMap((name) => covered.get(name) ?? []))],
    missing: [...new Set(names)].filter((name) => !covered.has(name)),
  };
}

/**
 * The status line followed by each reason the reply does not already say.
 * A reply that is itself the notes keeps its own wording, said once.
 */
export function finishReport(
  status: string | undefined,
  lines: readonly string[] | undefined,
  reply = "",
): string {
  if (!status) return "";
  const extra = (lines ?? []).filter((line) => !reply.includes(line));
  return [status, ...extra.map((line) => `- ${line}`)].join("\n");
}

/** The reply under its test status and each reason it does not already give. */
export function withFinishReport(
  status: string | undefined,
  lines: readonly string[] | undefined,
  reply: string,
  separator: string,
): string {
  if (!status) return reply;
  if (!(lines ?? []).some((line) => !reply.includes(line)))
    return reply.startsWith(status) ? reply : `${status}${separator}${reply}`;
  const body = reply.startsWith(status) ? reply.slice(status.length).trimStart() : reply;
  return [finishReport(status, lines, body), body].filter(Boolean).join(separator);
}
