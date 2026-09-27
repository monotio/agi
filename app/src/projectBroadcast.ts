/**
 * Cross-tab news of project writes. Every committed project write posts
 * `{ projectId, revision, generation }` on one BroadcastChannel, plus the
 * new authoring `fingerprint` when the write changed the authoring content
 * (a label, a lock, a binding). The message carries no data: storage stays
 * the source of truth and every project write stays conditional. What a
 * notice means for the running game is projectTransaction.ts's to decide.
 * Where BroadcastChannel is missing (or throws), only this early notice is
 * lost; the conditional writes still refuse.
 */
export const PROJECT_CHANNEL = "monotio_agi.projects";

export interface ProjectWriteNotice {
  readonly projectId: string;
  readonly revision: string;
  readonly generation: number;
  /** The authoring fingerprint the write left, present only when it changed. */
  readonly fingerprint?: string | undefined;
}

/** The part of BroadcastChannel this module uses; tests pass a fake. */
export interface NoticeChannel {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

let shared: NoticeChannel | null | undefined;

/**
 * This realm's one channel. Posting and listening on the same object means a
 * tab never hears its own writes: BroadcastChannel skips the sender.
 */
function sharedChannel(): NoticeChannel | null {
  if (shared !== undefined) return shared;
  try {
    const channel =
      typeof BroadcastChannel === "function" ? new BroadcastChannel(PROJECT_CHANNEL) : null;
    // Node keeps a process alive while a channel is open; a page never exits.
    (channel as { unref?: () => void } | null)?.unref?.();
    shared = channel;
  } catch {
    shared = null;
  }
  return shared;
}

/** Tell other tabs a project write committed. Never throws. */
export function announceProjectWrite(
  notice: ProjectWriteNotice,
  channel: NoticeChannel | null = sharedChannel(),
): void {
  try {
    channel?.postMessage({ ...notice } satisfies ProjectWriteNotice);
  } catch {
    /* another tab learns at its next conditional write instead */
  }
}

function readNotice(value: unknown): ProjectWriteNotice | null {
  if (!value || typeof value !== "object") return null;
  const { projectId, revision, generation, fingerprint } = value as Record<string, unknown>;
  if (
    typeof projectId !== "string" ||
    typeof revision !== "string" ||
    typeof generation !== "number" ||
    (fingerprint !== undefined && typeof fingerprint !== "string")
  )
    return null;
  return { projectId, revision, generation, ...(fingerprint !== undefined ? { fingerprint } : {}) };
}

/** Hear other tabs' project writes; malformed messages are dropped. Returns the unsubscribe. */
export function listenForProjectWrites(
  listener: (notice: ProjectWriteNotice) => void,
  channel: NoticeChannel | null = sharedChannel(),
): () => void {
  if (!channel) return () => {};
  const receive = (event: { data: unknown }) => {
    const notice = readNotice(event.data);
    if (notice) listener(notice);
  };
  channel.addEventListener("message", receive);
  return () => channel.removeEventListener("message", receive);
}
