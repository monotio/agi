// Proves which build the public site serves: its index carries the deployed
// commit's build identifier, references the artifact's entry assets, and those
// assets are served with the artifact's bytes. Retries while the edge
// propagates. Usage:
//   npm run verify:deploy -- --url https://agi.monotio.com/ --commit <sha> --artifact release
//     [--attempts 8] [--delay 10]
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export interface VerifyOptions {
  /** Public base URL the app is served from, e.g. https://agi.monotio.com/ */
  readonly url: string;
  /** Build identifier the site must carry: the deployed commit's SHA. */
  readonly commit: string;
  /** Directory holding the checked CI artifact that was deployed. */
  readonly artifact: string;
  readonly attempts: number;
  readonly delayMs: number;
  readonly log: (line: string) => void;
  /** Waits `ms` between attempts; a timer by default, injectable for tests. */
  readonly wait?: (ms: number) => Promise<void>;
}

interface Attempt {
  /** What failed; empty when the site serves the artifact. */
  readonly problems: readonly string[];
  /** Expected versus observed identifier, asset names and digests. */
  readonly report: readonly string[];
}

export interface VerifyResult extends Attempt {
  readonly ok: boolean;
  /** Attempts used, including the successful one. */
  readonly attempts: number;
}

interface Fetched {
  readonly status: number;
  readonly headers: Headers;
  readonly bytes: Uint8Array;
}

const FETCH_TIMEOUT_MS = 30_000;

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const attributes = (tag: string): Record<string, string> => {
  const found: Record<string, string> = {};
  for (const match of tag.matchAll(/([a-zA-Z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g))
    found[match[1]!.toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  return found;
};

/** The identifier from `<meta name="agi-build" content="…">` (app/vite.config.ts). */
const buildIdentifier = (html: string): string | null => {
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = attributes(tag);
    if (attrs["name"] === "agi-build") return attrs["content"] ?? null;
  }
  return null;
};

/** Entry JS and CSS the index loads: scripts, module preloads and stylesheets. */
const entryAssets = (html: string): string[] => {
  const refs: string[] = [];
  for (const [tag] of html.matchAll(/<script\b[^>]*>/gi)) {
    const src = attributes(tag)["src"];
    if (src) refs.push(src);
  }
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    const attrs = attributes(tag);
    const rel = (attrs["rel"] ?? "").toLowerCase().split(/\s+/);
    if (attrs["href"] && (rel.includes("stylesheet") || rel.includes("modulepreload")))
      refs.push(attrs["href"]);
  }
  return [...new Set(refs)].sort();
};

/** The artifact-relative path of a reference, or null when it leaves the site. */
const sitePath = (base: URL, ref: string): string | null => {
  const target = new URL(ref, base);
  if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname)) return null;
  return decodeURIComponent(target.pathname.slice(base.pathname.length));
};

const fetchBytes = async (url: URL): Promise<Fetched> => {
  const response = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  return {
    status: response.status,
    headers: response.headers,
    bytes: new Uint8Array(await response.arrayBuffer()),
  };
};

const describeError = (error: unknown): string =>
  error instanceof Error
    ? `${error.message}${error.cause ? ` (${String(error.cause)})` : ""}`
    : String(error);

const artifactDigest = async (root: string, path: string): Promise<string | null> => {
  const file = resolve(root, path);
  if (!file.startsWith(root + sep)) return null;
  try {
    return sha256(await readFile(file));
  } catch {
    return null;
  }
};

const verifyOnce = async (
  base: URL,
  commit: string,
  artifactRoot: string,
  artifactIndex: string,
): Promise<Attempt> => {
  const problems: string[] = [];
  const report: string[] = [`expected build ${commit}`];
  const expectedAssets = entryAssets(artifactIndex);

  const artifactBuild = buildIdentifier(artifactIndex);
  if (artifactBuild !== commit)
    problems.push(`artifact build identifier is ${artifactBuild ?? "missing"}, not ${commit}`);
  if (!expectedAssets.some((ref) => ref.endsWith(".js")))
    problems.push("artifact index references no entry script");

  let index: Fetched;
  try {
    index = await fetchBytes(base);
  } catch (error) {
    problems.push(`index request failed: ${describeError(error)}`);
    report.push("observed build (no response)");
    return { problems, report };
  }
  if (index.status !== 200) problems.push(`index answered HTTP ${index.status}`);
  const html = new TextDecoder().decode(index.bytes);

  const observedBuild = buildIdentifier(html);
  report.push(`observed build ${observedBuild ?? "(missing)"}`);
  if (observedBuild !== commit)
    problems.push(`served build identifier is ${observedBuild ?? "missing"}, not ${commit}`);

  if (!/<title>\s*AGI IS HERE/.test(html)) problems.push("index has no AGI IS HERE title");
  if (!/\bid\s*=\s*["']?app\b/.test(html)) problems.push('index has no id="app" mount');
  const contentTypeOptions = index.headers.get("x-content-type-options") ?? "";
  if (contentTypeOptions.toLowerCase() !== "nosniff")
    problems.push(`index x-content-type-options is "${contentTypeOptions}", not nosniff`);

  const observedAssets = entryAssets(html);
  report.push(
    `expected assets ${expectedAssets.join(" ") || "(none)"}`,
    `observed assets ${observedAssets.join(" ") || "(none)"}`,
  );
  if (expectedAssets.join("\n") !== observedAssets.join("\n"))
    problems.push("served index references different entry assets than the artifact");

  // Every asset either index names must be served with the artifact's bytes.
  for (const ref of [...new Set([...expectedAssets, ...observedAssets])].sort()) {
    const path = sitePath(base, ref);
    if (path === null) {
      problems.push(`${ref} is outside ${base.href}`);
      continue;
    }
    const expected = await artifactDigest(artifactRoot, path);
    if (expected === null) problems.push(`${path} is not in the artifact`);
    let observed: string;
    try {
      const asset = await fetchBytes(new URL(path, base));
      observed = asset.status === 200 ? sha256(asset.bytes) : `(HTTP ${asset.status})`;
    } catch (error) {
      observed = `(request failed: ${describeError(error)})`;
    }
    report.push(
      `${path}: expected sha256 ${expected ?? "(not in artifact)"}, observed ${observed}`,
    );
    if (expected !== null && observed !== expected)
      problems.push(
        `${path} is ${observed.startsWith("(") ? observed : "served with other bytes"}`,
      );
  }
  return { problems, report };
};

export const verifyDeploy = async (options: VerifyOptions): Promise<VerifyResult> => {
  const base = new URL(options.url);
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  const artifactRoot = resolve(options.artifact);
  const artifactIndex = await readFile(resolve(artifactRoot, "index.html"), "utf8");
  const attempts = Math.max(1, Math.floor(options.attempts));
  const wait = options.wait ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  let last: Attempt = { problems: [], report: [] };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    last = await verifyOnce(base, options.commit, artifactRoot, artifactIndex);
    if (last.problems.length === 0) return { ok: true, attempts: attempt, ...last };
    options.log(`Attempt ${attempt}/${attempts}: ${last.problems.join("; ")}`);
    if (attempt < attempts) await wait(options.delayMs);
  }
  return { ok: false, attempts, ...last };
};

const main = async (): Promise<void> => {
  const { values } = parseArgs({
    options: {
      url: { type: "string" },
      commit: { type: "string" },
      artifact: { type: "string" },
      attempts: { type: "string", default: "8" },
      delay: { type: "string", default: "10" },
    },
  });
  const attempts = Number(values.attempts);
  const delaySeconds = Number(values.delay);
  if (
    !values.url ||
    !values.commit ||
    !values.artifact ||
    !(attempts >= 1) ||
    !(delaySeconds >= 0)
  ) {
    console.error(
      "Usage: verify-deploy --url <base url> --commit <sha> --artifact <dir> [--attempts 8] [--delay <seconds>]",
    );
    process.exit(2);
  }
  const result = await verifyDeploy({
    url: values.url,
    commit: values.commit,
    artifact: values.artifact,
    attempts,
    delayMs: delaySeconds * 1000,
    log: (line) => console.log(line),
  });
  const lines = [
    result.ok
      ? `Verified: ${values.url} serves build ${values.commit} (attempt ${result.attempts}).`
      : `Failed: ${values.url} does not serve the artifact for ${values.commit} after ${result.attempts} attempt(s).`,
    ...result.problems.map((problem) => `  problem: ${problem}`),
    ...result.report.map((line) => `  ${line}`),
  ].join("\n");
  if (result.ok) console.log(lines);
  else {
    console.error(lines);
    process.exit(1);
  }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
