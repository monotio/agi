/**
 * Freeze Genesis effort runs as a committed benchmark snapshot.
 *
 *   npm run eval:snapshot -- <results-dir> <snapshot-dir>
 *
 * Copies every completed run (a `.report.json` beside a `.resources/`
 * folder) into `<snapshot-dir>/runs/` in the same layout, so
 * `npm run eval:matrix -- <snapshot-dir>/runs <snapshot-dir>/matrix` reads it
 * directly and later snapshots compare like for like. The generated game files,
 * the report and the opening frame are kept as they are. The rest is slimmed
 * to what a reader can use:
 *
 * - embedded images (rendered previews, reference art) become a placeholder
 *   naming their size and hash; the opening frame and the resources hold the
 *   pictures;
 * - encrypted reasoning and thinking signatures, which nobody can read, become
 *   the same kind of placeholder;
 * - session events keep requests, responses, errors and telemetry; the debug
 *   `log` stream, most of each file, is dropped;
 * - JSON is written compactly;
 * - absolute paths become paths relative to the run, and any path that still
 *   names a home directory stops the snapshot (a public repository).
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";

const [resultsArg, snapshotArg] = process.argv.slice(2);
if (!resultsArg || !snapshotArg) {
  console.error("Usage: npm run eval:snapshot -- <results-dir> <snapshot-dir>");
  process.exit(1);
}
const results = resolve(resultsArg);
const runsDir = join(resolve(snapshotArg), "runs");
mkdirSync(runsDir, { recursive: true });

const OPAQUE_KEYS: Record<string, true> = { encrypted_content: true, signature: true };

function placeholder(kind: string, value: string): string {
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 16);
  return `[${kind} omitted: ${value.length} chars, sha256 ${hash}]`;
}

/** Replace images and opaque reasoning; make paths relative to the results folder. */
function slim(text: string, events = false): string {
  const parsed: unknown = JSON.parse(text, (key, entry: unknown) => {
    if (typeof entry !== "string") return entry;
    if (Object.hasOwn(OPAQUE_KEYS, key)) return placeholder(key, entry);
    if (entry.startsWith("data:image/")) return placeholder("image", entry);
    // Anthropic image blocks carry bare base64 under `data`.
    if (key === "data" && entry.length > 256 && /^[A-Za-z0-9+/]+=*$/.test(entry))
      return placeholder("image", entry);
    if (entry.startsWith(`${results}/`)) return entry.slice(results.length + 1);
    return entry;
  });
  const value =
    events && Array.isArray(parsed)
      ? parsed.filter((event: { type?: unknown }) => event.type !== "log")
      : parsed;
  const compact = JSON.stringify(value);
  const leak = /\/(?:Users|home)\/[^"\s]+/.exec(compact);
  if (leak) throw new Error(`A personal path would enter the snapshot: ${leak[0]}`);
  return `${compact}\n`;
}

let runs = 0;
for (const name of readdirSync(results).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
  if (!name.endsWith(".report.json")) continue;
  const stem = name.slice(0, -".report.json".length);
  if (!existsSync(join(results, `${stem}.resources`))) continue;
  for (const suffix of [".report.json", ".transcript.json", ".events.json"]) {
    const source = join(results, `${stem}${suffix}`);
    if (existsSync(source))
      writeFileSync(
        join(runsDir, basename(source)),
        slim(readFileSync(source, "utf8"), suffix === ".events.json"),
      );
  }
  const frame = join(results, `${stem}.first-frame.png`);
  if (existsSync(frame)) cpSync(frame, join(runsDir, `${stem}.first-frame.png`));
  cpSync(join(results, `${stem}.resources`), join(runsDir, `${stem}.resources`), {
    recursive: true,
  });
  runs++;
}
console.log(`Snapshot: ${runs} runs in ${runsDir}`);
