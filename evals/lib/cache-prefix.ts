/**
 * Prefix stability of consecutive provider requests: how much of the
 * previous request's prompt reappears byte-for-byte at the start of the next
 * one. Both providers cache by exact prefix over tools -> system -> messages
 * (OpenAI: tools, instructions, input), so a request whose predecessor is a
 * strict prefix of it can read everything it already paid for.
 *
 * Each request becomes a prompt stream: its cacheable sections serialised in
 * render order, with cache markers stripped (the moving marker is not an
 * invalidator) and every image replaced by a placeholder whose length is
 * four characters per estimated token (width x height / 750), so a stream's
 * length / 4 is a rough token count and an image counts what it costs.
 */

export type StreamProvider = "anthropic" | "openai";

/** Characters per estimated token, for text and for image placeholders alike. */
const CHARS_PER_TOKEN = 4;
/** Anthropic's image rule: width x height / 750 tokens. */
const IMAGE_PIXELS_PER_TOKEN = 750;

interface Segment {
  readonly label: string;
  readonly start: number;
  readonly end: number;
}

interface PromptStream {
  readonly text: string;
  readonly segments: readonly Segment[];
  /** Request fields outside the cached prefix that can still reset a cache. */
  readonly params: { model: string; toolChoice: string; effort: string };
}

/** PNG width x height from base64 data; 0 for anything else. */
function pngPixelsBase64(data: string): number {
  const header = Buffer.from(data.slice(0, 32), "base64");
  if (header.length < 24 || header[0] !== 0x89 || header[1] !== 0x50) return 0;
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  return view.getUint32(16) * view.getUint32(20);
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** A placeholder as long as the image's estimated token cost, keyed by its bytes. */
function imagePlaceholder(data: string): string {
  const pixels = pngPixelsBase64(data);
  const tokens = pixels ? Math.ceil(pixels / IMAGE_PIXELS_PER_TOKEN) : Math.ceil(data.length / 4);
  const head = `<image ${fnv1a(data)} ${pixels}px ~${tokens}t>`;
  return head.padEnd(tokens * CHARS_PER_TOKEN, ".");
}

const STRIPPED_KEYS = new Set(["cache_control", "prompt_cache_breakpoint"]);

/** A copy without cache markers and with images replaced by placeholders. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (record["type"] === "image" && typeof record["source"] === "object" && record["source"]) {
    const source = record["source"] as Record<string, unknown>;
    if (typeof source["data"] === "string")
      return { type: "image", image: imagePlaceholder(source["data"]) };
  }
  if (record["type"] === "input_image" && typeof record["image_url"] === "string") {
    const data = record["image_url"].replace(/^data:[^,]*,/, "");
    return { type: "input_image", image: imagePlaceholder(data) };
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record))
    if (!STRIPPED_KEYS.has(key)) out[key] = canonical(item);
  return out;
}

function itemLabel(provider: StreamProvider, item: Record<string, unknown>, index: number) {
  if (provider === "anthropic") {
    const content = item["content"];
    const kinds = Array.isArray(content)
      ? [...new Set((content as { type: string }[]).map((block) => block.type))].join("+")
      : "text";
    return `message[${index}] ${String(item["role"])} ${kinds}`;
  }
  const kind = "role" in item ? `${String(item["role"])} message` : String(item["type"]);
  return `input[${index}] ${kind}`;
}

/** The prompt stream of one request body, as the client built it. */
function promptStream(provider: StreamProvider, body: Record<string, unknown>): PromptStream {
  const parts: { label: string; text: string }[] = [];
  const stringify = (value: unknown) => JSON.stringify(canonical(value));
  parts.push({ label: "tools", text: stringify(body["tools"] ?? []) });
  if (provider === "anthropic") {
    parts.push({ label: "system", text: stringify(body["system"] ?? "") });
    const messages = (body["messages"] ?? []) as Record<string, unknown>[];
    messages.forEach((message, index) =>
      parts.push({ label: itemLabel(provider, message, index), text: stringify(message) }),
    );
  } else {
    parts.push({ label: "instructions", text: String(body["instructions"] ?? "") });
    const input = (body["input"] ?? []) as Record<string, unknown>[];
    input.forEach((item, index) =>
      parts.push({ label: itemLabel(provider, item, index), text: stringify(item) }),
    );
  }
  const segments: Segment[] = [];
  let text = "";
  for (const part of parts) {
    segments.push({ label: part.label, start: text.length, end: text.length + part.text.length });
    text += part.text;
  }
  const effort =
    provider === "anthropic"
      ? String((body["output_config"] as { effort?: string } | undefined)?.effort ?? "")
      : String((body["reasoning"] as { effort?: string } | undefined)?.effort ?? "");
  return {
    text,
    segments,
    params: {
      model: String(body["model"] ?? ""),
      toolChoice: JSON.stringify(body["tool_choice"] ?? null),
      effort,
    },
  };
}

type DivergenceKind =
  | "append-only"
  | "tools list or order"
  | "system text"
  | "reference view collapsed"
  | "message rewritten"
  | "random id or timestamp";

interface Divergence {
  readonly kind: DivergenceKind;
  /** The previous request's segment the first differing character falls in. */
  readonly segment: string;
  readonly offset: number;
  readonly before: string;
  readonly after: string;
}

interface PairReport {
  /** 1-based index of the later request. */
  readonly request: number;
  readonly previousTokens: number;
  readonly currentTokens: number;
  readonly commonTokens: number;
  /** Share of the previous request that survives as a prefix: 1 when append-only. */
  readonly stability: number;
  /** Share of the current request the previous one's cache could serve. */
  readonly cacheableShare: number;
  readonly divergence: Divergence | null;
  /** Request fields outside the prefix that changed: a possible reset on its own. */
  readonly paramChanges: readonly string[];
}

function commonPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let low = 0;
  let high = limit;
  // Binary search on the first mismatch keeps a 200 KB pair cheap.
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (a.slice(0, mid) === b.slice(0, mid)) low = mid;
    else high = mid - 1;
  }
  return low;
}

const RANDOM_LIKE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}|\b1[6-9]\d{11}\b|\d{4}-\d{2}-\d{2}T\d{2}:/;

function classify(previous: PromptStream, current: PromptStream, offset: number): Divergence {
  const segment =
    previous.segments.find((s) => offset >= s.start && offset < s.end) ??
    previous.segments[previous.segments.length - 1]!;
  const before = previous.text.slice(offset, offset + 160);
  const after = current.text.slice(offset, offset + 160);
  const excerpt = { segment: segment.label, offset, before, after };
  if (segment.label === "tools") return { kind: "tools list or order", ...excerpt };
  if (segment.label === "system" || segment.label === "instructions")
    return { kind: "system text", ...excerpt };
  const window = current.text.slice(offset, segment.end + 400);
  if (/left the conversation after \d+ turns/.test(window))
    return { kind: "reference view collapsed", ...excerpt };
  if (RANDOM_LIKE.test(before) || RANDOM_LIKE.test(after))
    return { kind: "random id or timestamp", ...excerpt };
  return { kind: "message rewritten", ...excerpt };
}

/** Compare one request with its predecessor. */
function comparePair(previous: PromptStream, current: PromptStream, request: number) {
  const common = commonPrefixLength(previous.text, current.text);
  const paramChanges = (["model", "toolChoice", "effort"] as const).filter(
    (key) => previous.params[key] !== current.params[key],
  );
  const report: PairReport = {
    request,
    previousTokens: previous.text.length / CHARS_PER_TOKEN,
    currentTokens: current.text.length / CHARS_PER_TOKEN,
    commonTokens: common / CHARS_PER_TOKEN,
    stability: previous.text.length ? common / previous.text.length : 1,
    cacheableShare: current.text.length ? common / current.text.length : 1,
    divergence: common === previous.text.length ? null : classify(previous, current, common),
    paramChanges,
  };
  return report;
}

export interface ScenarioReport {
  readonly scenario: string;
  readonly provider: StreamProvider;
  readonly requests: number;
  readonly pairs: readonly PairReport[];
  /** The worst pair: 1 means every request extended its predecessor. */
  readonly minStability: number;
  readonly meanCacheableShare: number;
  /** Tokens of already-sent prompt that later requests sent again changed. */
  readonly rewrittenTokens: number;
  readonly lastRequestTokens: number;
  readonly divergences: Partial<Record<DivergenceKind, number>>;
  readonly paramChanges: readonly string[];
  /** Fingerprint of the tools section: one value per session when the catalog is stable. */
  readonly catalogHashes: readonly string[];
}

/** Compare every consecutive pair of one scenario's requests. */
export function analyseRequests(
  scenario: string,
  provider: StreamProvider,
  bodies: readonly Record<string, unknown>[],
): ScenarioReport {
  const streams = bodies.map((body) => promptStream(provider, body));
  const pairs: PairReport[] = [];
  for (let index = 1; index < streams.length; index++)
    pairs.push(comparePair(streams[index - 1]!, streams[index]!, index + 1));
  const divergences: Partial<Record<DivergenceKind, number>> = {};
  let rewritten = 0;
  for (const pair of pairs) {
    const kind = pair.divergence?.kind ?? "append-only";
    divergences[kind] = (divergences[kind] ?? 0) + 1;
    rewritten += pair.previousTokens - pair.commonTokens;
  }
  const catalogHashes = [
    ...new Set(
      streams.map((stream) => {
        const tools = stream.segments.find((s) => s.label === "tools")!;
        return fnv1a(stream.text.slice(tools.start, tools.end));
      }),
    ),
  ];
  return {
    scenario,
    provider,
    requests: streams.length,
    pairs,
    minStability: pairs.length ? Math.min(...pairs.map((pair) => pair.stability)) : 1,
    meanCacheableShare: pairs.length
      ? pairs.reduce((sum, pair) => sum + pair.cacheableShare, 0) / pairs.length
      : 1,
    rewrittenTokens: rewritten,
    lastRequestTokens: streams.length
      ? streams[streams.length - 1]!.text.length / CHARS_PER_TOKEN
      : 0,
    divergences,
    paramChanges: [...new Set(pairs.flatMap((pair) => pair.paramChanges))],
    catalogHashes,
  };
}

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;

/** The per-scenario table and each divergence, as Markdown. */
export function renderReports(reports: readonly ScenarioReport[]): string {
  const lines = [
    "| Scenario | Provider | Requests | Min prefix stability | Mean cacheable share | Rewritten tokens | Last request tokens | Divergences | Param changes |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |",
  ];
  for (const report of reports) {
    const kinds = Object.entries(report.divergences)
      .map(([kind, count]) => `${kind} ×${count}`)
      .join(", ");
    lines.push(
      `| ${report.scenario} | ${report.provider} | ${report.requests} | ${percent(report.minStability)} | ${percent(report.meanCacheableShare)} | ${Math.round(report.rewrittenTokens)} | ${Math.round(report.lastRequestTokens)} | ${kinds} | ${report.paramChanges.join(", ") || "none"} |`,
    );
  }
  for (const report of reports) {
    const broken = report.pairs.filter((pair) => pair.divergence);
    if (report.catalogHashes.length > 1)
      lines.push(
        `\n${report.scenario} (${report.provider}): the tool catalog changed within the session (${report.catalogHashes.join(", ")}).`,
      );
    for (const pair of broken) {
      const d = pair.divergence!;
      lines.push(
        `\n${report.scenario} (${report.provider}) request ${pair.request}: ${d.kind} in ${d.segment} at token ${Math.round(d.offset / CHARS_PER_TOKEN)} — ${Math.round(pair.previousTokens - pair.commonTokens)} tokens rewritten, ${percent(pair.cacheableShare)} of the request still cacheable.`,
        `  before: ${JSON.stringify(d.before.slice(0, 100))}`,
        `  after:  ${JSON.stringify(d.after.slice(0, 100))}`,
      );
    }
  }
  return lines.join("\n");
}
