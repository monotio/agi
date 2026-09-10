import { buildZip, type ZipFileInput } from "./zip.ts";
import { sha256Hex } from "./crypto.ts";
import { publicGameMetadata } from "./gameMetadata.ts";
import { validateAuthoringState } from "../../src/agent/authoringState.ts";
import { buildView, type BuildViewInput } from "../../src/view/view.ts";
import { buildObjectFile, buildSound, type SoundTrackInput } from "../../src/agent/tools.ts";
import { compactContainer } from "../../src/container/container.ts";
import { detectProfile } from "../../src/runtime/profile.ts";
import type { CachedGameData } from "./gameTypes.ts";
import { progressEntries, type GameProgress } from "./gameProgress.ts";

export interface ProjectContext {
  provider: string;
  model: string;
  sessionId?: string | undefined;
  transcript: unknown[];
  authoringState?: Record<string, unknown> | undefined;
  conversationHistory?: { provider: string; model: string; transcript: unknown[] }[] | undefined;
}

/** Only current game resources and interpreter identification travel publicly. */
function gameEntries(
  data: Pick<CachedGameData, "files" | "title" | "roomGeneration" | "library">,
): ZipFileInput[] {
  const packed = compactContainer(new Map(Object.entries(data.files)));
  if (!packed.has("OBJECT")) packed.set("OBJECT", buildObjectFile([], detectProfile(packed)));
  const entries = [...packed]
    .filter(([name]) =>
      /^([A-Z0-9_]*DIR|[A-Z0-9_]*VOL\.(?:[0-9]|1[0-5])|WORDS\.TOK|OBJECT|AGIDATA\.OVL|AGI|[A-Z0-9_-]+\.COM)$/i.test(
        name,
      ),
    )
    .map(([name, bytes]) => ({ name, data: bytes }) as ZipFileInput);
  entries.push({
    name: "GAME.JSON",
    data: JSON.stringify({
      format: "monotio.agi",
      version: 1,
      metadata: publicGameMetadata(data.library),
      title: data.title,
      roomGeneration: data.roomGeneration === true,
    }),
  });
  return entries;
}

export function buildPublicGameZip(
  data: Pick<CachedGameData, "files" | "title" | "roomGeneration" | "library">,
): Uint8Array<ArrayBuffer> {
  return finishArchive(gameEntries(data));
}

/**
 * Archive a complete conversation; repeated image bytes become one ZIP attachment.
 * A project is for continuing the work elsewhere, so it also carries what a
 * published game must not reveal: the stored game tests are walkthroughs, and
 * the player's progress (save slots and latest autosave) is theirs alone.
 */
export async function buildProjectZip(
  data: CachedGameData,
  progress?: GameProgress,
): Promise<Uint8Array<ArrayBuffer>> {
  const entries = gameEntries(data);
  const tests = data.files["TESTS.JSON"];
  if (tests) entries.push({ name: "TESTS.JSON", data: tests });
  if (progress) entries.push(...progressEntries(progress));
  const attachments = new Map<string, string>();
  async function visit(value: unknown): Promise<unknown> {
    if (typeof value === "string" && /^(data:image\/(?:png|jpeg|webp);base64,)/.test(value)) {
      const [, mime, b64] = /^data:(image\/[^;]+);base64,(.*)$/.exec(value)!;
      return { projectImage: await attach(b64!, mime!) };
    }
    if (Array.isArray(value)) return Promise.all(value.map(visit));
    if (value && typeof value === "object") {
      const object = value as Record<string, unknown>;
      if (
        object["type"] === "base64" &&
        typeof object["data"] === "string" &&
        typeof object["media_type"] === "string" &&
        /^image\/(png|jpeg|webp)$/.test(object["media_type"])
      ) {
        return {
          projectImage: await attach(object["data"], object["media_type"]),
          anthropicSource: true,
        };
      }
      return Object.fromEntries(
        await Promise.all(
          Object.entries(object).map(async ([key, child]) => [key, await visit(child)]),
        ),
      );
    }
    return value;
  }
  async function attach(b64: string, mime: string): Promise<string> {
    const binary = atob(b64);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const hash = await sha256Hex(bytes);
    let path = attachments.get(hash);
    if (!path) {
      path = `IMAGES/${hash}.${mime.split("/")[1]}`;
      attachments.set(hash, path);
      entries.push({ name: path, data: bytes });
    }
    return path;
  }
  validateTranscript(data.transcript ?? [], data.provider);
  const transcript = await visit(data.transcript ?? []);
  const conversationHistory = await visit(data.conversationHistory ?? []);
  entries.push({
    name: "PROJECT.JSON",
    data: JSON.stringify({
      format: "monotio.agi.project",
      version: 1,
      provider: data.provider,
      model: data.model,
      sessionId: data.sessionId,
      conversation: { formatVersion: 1, messages: transcript },
      authoringState: data.authoringState ?? {},
      conversationHistory,
    }),
  });
  return finishArchive(entries);
}

function finishArchive(entries: ZipFileInput[]): Uint8Array<ArrayBuffer> {
  if (entries.length > 1024) throw new Error("This project has more than 1024 archive entries.");
  const encoder = new TextEncoder();
  let expanded = 0;
  for (const entry of entries) {
    const size =
      typeof entry.data === "string" ? encoder.encode(entry.data).length : entry.data.length;
    expanded += size;
    if (size > 64 * 1024 * 1024 || expanded > 256 * 1024 * 1024)
      throw new Error(
        "This project exceeds the supported archive size. Choose Game actions → Game export to keep its playable resources.",
      );
  }
  const zip = buildZip(entries);
  if (zip.length > 128 * 1024 * 1024)
    throw new Error(
      "This project exceeds the 128 MB archive limit. Choose Game actions → Game export to keep its playable resources.",
    );
  return zip;
}

/** Imported history is data, never a source of executable calls or system instructions. */
export function validateTranscript(messages: unknown, provider: string): unknown[] {
  if (!Array.isArray(messages) || messages.length > 50000)
    throw new Error("The project conversation is invalid or too large.");
  function inspect(value: unknown, depth = 0): void {
    if (depth > 40) throw new Error("Project conversation nesting is too deep.");
    if (Array.isArray(value)) {
      for (const item of value) inspect(item, depth + 1);
      return;
    }
    if (!value || typeof value !== "object") return;
    const object = value as Record<string, unknown>;
    if (
      object["type"] === "input_image" &&
      (typeof object["image_url"] !== "string" ||
        !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(object["image_url"]))
    )
      throw new Error("Project images must be embedded in the archive.");
    if (object["type"] === "image") {
      const source = object["source"] as Record<string, unknown> | undefined;
      if (
        !source ||
        source["type"] !== "base64" ||
        !["image/png", "image/jpeg", "image/webp"].includes(String(source["media_type"])) ||
        typeof source["data"] !== "string"
      )
        throw new Error("Project images must be embedded in the archive.");
    }
    if (["input_file", "file", "document"].includes(String(object["type"])))
      throw new Error("Unsupported external project attachment.");
    for (const [key, child] of Object.entries(object)) {
      if (["__proto__", "prototype", "constructor"].includes(key))
        throw new Error("Invalid conversation field.");
      inspect(child, depth + 1);
    }
  }
  inspect(messages);
  const pending = new Set<string>();
  for (const item of messages) {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("Invalid project conversation item.");
    const value = item as Record<string, unknown>;
    if (value["role"] && value["role"] !== "user" && value["role"] !== "assistant")
      throw new Error("Project conversations may contain only user and assistant messages.");
    if (provider === "anthropic") {
      if (value["role"] !== "user" && value["role"] !== "assistant")
        throw new Error("Invalid Anthropic conversation role.");
      if (typeof value["content"] !== "string" && !Array.isArray(value["content"]))
        throw new Error("Invalid Anthropic message content.");
      if (Array.isArray(value["content"]))
        for (const block of value["content"]) {
          if (!block || typeof block !== "object")
            throw new Error("Invalid conversation content block.");
          if (block.type === "tool_use") {
            if (
              typeof block.id !== "string" ||
              typeof block.name !== "string" ||
              !block.input ||
              typeof block.input !== "object"
            )
              throw new Error("Invalid archived tool call.");
            pending.add(block.id);
          } else if (block.type === "tool_result") {
            if (!pending.delete(block.tool_use_id))
              throw new Error("Archived tool result has no matching call.");
          } else if (!["text", "image", "thinking", "redacted_thinking"].includes(block.type))
            throw new Error("Unsupported archived message block.");
        }
    } else if (provider === "openai") {
      const type = value["type"];
      if (type === "function_call") {
        if (
          typeof value["call_id"] !== "string" ||
          typeof value["arguments"] !== "string" ||
          typeof value["name"] !== "string"
        )
          throw new Error("Invalid archived tool call.");
        pending.add(value["call_id"]);
      } else if (type === "function_call_output") {
        if (typeof value["call_id"] !== "string" || !pending.delete(value["call_id"]))
          throw new Error("Archived tool result has no matching call.");
      } else if (type !== "reasoning" && value["role"] !== "user" && value["role"] !== "assistant")
        throw new Error("Unsupported archived conversation item.");
    } else if (provider !== "stub") throw new Error("Unsupported project conversation provider.");
  }
  if (pending.size)
    throw new Error(
      "This project has an unfinished tool turn. Save it after generation completes.",
    );
  return messages;
}

export function readProjectContext(
  bytes: Uint8Array,
  entries: Map<string, Uint8Array>,
  root: string,
): ProjectContext {
  const raw = JSON.parse(new TextDecoder().decode(bytes));
  if (
    raw.format !== "monotio.agi.project" ||
    raw.version !== 1 ||
    raw.conversation?.formatVersion !== 1
  )
    throw new Error("This project version is not supported.");
  if (!["openai", "anthropic", "stub"].includes(raw.provider) || typeof raw.model !== "string")
    throw new Error("Invalid project model metadata.");
  function restore(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(restore);
    if (value && typeof value === "object") {
      const object = value as Record<string, unknown>;
      if (typeof object["projectImage"] === "string") {
        const path = object["projectImage"];
        if (!/^IMAGES\/[a-f0-9]{64}\.(png|jpeg|webp)$/.test(path))
          throw new Error("Invalid project image reference.");
        const image = entries.get(`${root}${path}`.toUpperCase());
        if (!image) throw new Error("A project image attachment is missing.");
        let binary = "";
        for (const byte of image) binary += String.fromCharCode(byte);
        const mime = `image/${path.split(".").pop()}`;
        return object["anthropicSource"]
          ? { type: "base64", media_type: mime, data: btoa(binary) }
          : `data:${mime};base64,${btoa(binary)}`;
      }
      if (
        Object.keys(object).some((key) => ["__proto__", "constructor", "prototype"].includes(key))
      )
        throw new Error("Invalid project data key.");
      return Object.fromEntries(
        Object.entries(object).map(([key, child]) => [key, restore(child)]),
      );
    }
    return value;
  }
  const transcript = validateTranscript(restore(raw.conversation.messages), raw.provider);
  const authoringState = restore(raw.authoringState);
  if (!authoringState || typeof authoringState !== "object" || Array.isArray(authoringState))
    throw new Error("Invalid project authoring state.");
  const snapshot = authoringState as Record<string, unknown>;
  if (snapshot["authoring"]) validateAuthoringState(snapshot["authoring"]);
  const sources = snapshot["sources"] as Record<string, unknown> | undefined;
  if (sources)
    for (const kind of ["logics", "pictures", "views", "sounds"]) {
      const entries = sources[kind];
      if (entries === undefined) continue;
      if (!Array.isArray(entries) || entries.length > 256)
        throw new Error("Invalid project authoring sources.");
      for (const entry of entries) {
        if (
          !Array.isArray(entry) ||
          entry.length !== 2 ||
          !Number.isInteger(entry[0]) ||
          entry[0] < 0 ||
          entry[0] > 255
        )
          throw new Error("Invalid project source entry.");
        if (kind === "views") buildView(entry[1] as BuildViewInput);
        else if (kind === "sounds") buildSound(entry[1] as SoundTrackInput[]);
        else if (typeof entry[1] !== "string") throw new Error("Invalid project text source.");
      }
    }
  const history = restore(raw.conversationHistory ?? []);
  if (!Array.isArray(history) || history.length > 100)
    throw new Error("Invalid project conversation archive.");
  const conversationHistory = history.map((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.provider !== "string" ||
      typeof item.model !== "string"
    )
      throw new Error("Invalid archived conversation metadata.");
    return {
      provider: item.provider,
      model: item.model,
      transcript: validateTranscript(item.transcript, item.provider),
    };
  });
  return {
    provider: raw.provider,
    model: raw.model,
    ...(typeof raw.sessionId === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(raw.sessionId)
      ? { sessionId: raw.sessionId }
      : {}),
    transcript,
    authoringState: authoringState as Record<string, unknown>,
    conversationHistory,
  };
}

/** Provider changes retain a readable archive without replaying incompatible protocol items. */
export function continuationTranscript(
  data: Pick<CachedGameData, "provider" | "model" | "transcript">,
  provider: string,
  model?: string,
): unknown[] | undefined {
  if (!data.transcript?.length) return undefined;
  if (data.provider === provider && (!model || data.model === model))
    return validateTranscript(data.transcript, provider);
  const text = `Previous authoring conversation (reference material from an earlier model session; game resources are authoritative):\n${JSON.stringify(data.transcript, (key, value) => (key === "encrypted_content" || key === "signature" || key === "image_url" || key === "data" ? undefined : value))}`;
  return [{ role: "user", content: text }];
}
