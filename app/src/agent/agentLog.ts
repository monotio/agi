import { serializeAgentLog } from "../../../src/agent/toolTransport.ts";
import type { AgentRunState } from "./agentRun.ts";

export interface AgentLogAudio {
  url: string;
  caption: string;
}

export interface AgentLogEntry {
  id: string;
  timestamp: number;
  kind: "request" | "response" | "error" | "log" | "input";
  detail: string;
  data?: unknown;
  /** Ephemeral browser-only previews. Never copied into logs or project data. */
  audio?: AgentLogAudio[];
}

export interface AgentLoggerState {
  agentLog: AgentLogEntry[];
  agentTask: AgentRunState | null;
}

export interface AgentLogger {
  logAgent(
    kind: "request" | "response" | "error" | "log" | "input",
    detail: string,
    data?: unknown,
  ): void;
  clearAgentLog(): void;
  releaseAgentAudioPreviews(): void;
  traceAgentLog(): AgentLogEntry[];
}

const MAX_AUDIO_PREVIEWS = 8;
const MAX_AUDIO_PREVIEW_BYTES = 8 * 1024 * 1024;

export function isWave(bytes: Uint8Array): boolean {
  if (!(
    bytes.length >= 44 &&
    bytes.length <= MAX_AUDIO_PREVIEW_BYTES &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x41 &&
    bytes[10] === 0x56 &&
    bytes[11] === 0x45 &&
    bytes[12] === 0x66 &&
    bytes[13] === 0x6d &&
    bytes[14] === 0x74 &&
    bytes[15] === 0x20 &&
    bytes[36] === 0x64 &&
    bytes[37] === 0x61 &&
    bytes[38] === 0x74 &&
    bytes[39] === 0x61
  ))
    return false;
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const byteRate = header.getUint32(28, true);
  const dataBytes = header.getUint32(40, true);
  return (
    header.getUint32(4, true) + 8 === bytes.length &&
    header.getUint16(20, true) === 1 &&
    byteRate > 0 &&
    dataBytes + 44 === bytes.length &&
    dataBytes / byteRate <= 30
  );
}

export function takeAudio(data: unknown): { previews: AgentLogAudio[]; serializable: unknown } {
  if (!data || typeof data !== "object" || Array.isArray(data))
    return { previews: [], serializable: data };
  const record = data as Record<string, unknown>;
  const result = record["result"];
  if (!result || typeof result !== "object" || Array.isArray(result))
    return { previews: [], serializable: data };
  const resultRecord = result as Record<string, unknown>;
  const attachments = resultRecord["audio"];
  if (!Array.isArray(attachments)) return { previews: [], serializable: data };

  const cleanResult = { ...resultRecord };
  delete cleanResult["audio"];
  const previews: AgentLogAudio[] = [];
  for (const attachment of attachments.slice(0, MAX_AUDIO_PREVIEWS)) {
    if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) continue;
    const candidate = attachment as Record<string, unknown>;
    const wav = candidate["wav"];
    const caption = candidate["caption"];
    if (
      candidate["mimeType"] !== "audio/wav" ||
      !(wav instanceof Uint8Array) ||
      !isWave(wav) ||
      typeof caption !== "string" ||
      !caption.trim()
    )
      continue;
    previews.push({
      url: URL.createObjectURL(new Blob([wav.slice()], { type: "audio/wav" })),
      caption: caption.trim().slice(0, 300),
    });
  }
  return { previews, serializable: { ...record, result: cleanResult } };
}

/** Create an isolated agent activity logger and audio preview manager. */
export function createAgentLogger(state: AgentLoggerState): AgentLogger {
  const audioPreviewUrls: { entryId: string; url: string }[] = [];

  function traceAgentLog(): AgentLogEntry[] {
    return state.agentLog.map((entry) => {
      const copy = { ...entry };
      delete copy.audio;
      return copy;
    });
  }

  function releaseAgentAudioPreviews(): void {
    for (const { url } of audioPreviewUrls) URL.revokeObjectURL(url);
    audioPreviewUrls.length = 0;
    for (const entry of state.agentLog) delete entry.audio;
  }

  function logAgent(
    kind: "request" | "response" | "error" | "log" | "input",
    detail: string,
    data?: unknown,
  ): void {
    if (data && typeof data === "object" && "task" in data) {
      state.agentTask = (data as { task: AgentRunState }).task;
      return;
    }

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const extracted = takeAudio(data);
    const entry: AgentLogEntry = {
      id,
      timestamp: Date.now(),
      kind,
      detail,
      data:
        extracted.serializable !== undefined
          ? JSON.parse(serializeAgentLog(extracted.serializable))
          : undefined,
    };
    if (extracted.previews.length) entry.audio = extracted.previews;
    state.agentLog.push(entry);
    for (const preview of extracted.previews)
      audioPreviewUrls.push({ entryId: id, url: preview.url });
    while (audioPreviewUrls.length > MAX_AUDIO_PREVIEWS) {
      const evicted = audioPreviewUrls.shift()!;
      URL.revokeObjectURL(evicted.url);
      const oldEntry = state.agentLog.find(({ id: entryId }) => entryId === evicted.entryId);
      if (!oldEntry?.audio) continue;
      oldEntry.audio = oldEntry.audio.filter(({ url }) => url !== evicted.url);
      if (!oldEntry.audio.length) delete oldEntry.audio;
    }
    if (typeof window !== "undefined") {
      (window as unknown as { __AGI_TRACE__?: AgentLogEntry[] }).__AGI_TRACE__ = traceAgentLog();
    }
  }

  function clearAgentLog(): void {
    releaseAgentAudioPreviews();
    state.agentLog = [];
    if (typeof window !== "undefined") {
      (window as unknown as { __AGI_TRACE__?: AgentLogEntry[] }).__AGI_TRACE__ = [];
    }
  }

  return {
    logAgent,
    clearAgentLog,
    releaseAgentAudioPreviews,
    traceAgentLog,
  };
}
