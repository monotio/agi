/**
 * Cross-tab news of project writes. Every committed project write posts
 * `{ projectId, revision, generation }` on one BroadcastChannel, and a tab
 * running that project on another revision learns at once that storage moved
 * past it, instead of at its next refused write. The message carries no data:
 * storage stays the source of truth and every project write stays
 * conditional. Where BroadcastChannel is missing (or throws), only this
 * early notice is lost; the conditional writes still refuse.
 */
import type { BootedGame } from "./gameTypes.ts";

export const PROJECT_CHANNEL = "monotio_agi.projects";

export interface ProjectWriteNotice {
  readonly projectId: string;
  readonly revision: string;
  readonly generation: number;
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
  const { projectId, revision, generation } = value as Record<string, unknown>;
  return typeof projectId === "string" &&
    typeof revision === "string" &&
    typeof generation === "number"
    ? { projectId, revision, generation }
    : null;
}

export interface ProjectWriteWatch {
  readonly getBootedGame: () => BootedGame | null;
  /** Storage moved past the running game; called once per game. */
  readonly onBehindStorage: () => void;
}

/**
 * Mark the running game `behindStorage` when another tab commits a different
 * revision of its project: from then on nothing writes its files, and the
 * player may keep playing until they reload. Returns the unsubscribe.
 */
export function watchProjectWrites(
  watch: ProjectWriteWatch,
  channel: NoticeChannel | null = sharedChannel(),
): () => void {
  if (!channel) return () => {};
  const listener = (event: { data: unknown }) => {
    const notice = readNotice(event.data);
    const game = watch.getBootedGame();
    if (!notice || !game || game.installed || game.projectId !== notice.projectId) return;
    if (game.revision === notice.revision || game.behindStorage) return;
    game.behindStorage = true;
    watch.onBehindStorage();
  };
  channel.addEventListener("message", listener);
  return () => channel.removeEventListener("message", listener);
}
