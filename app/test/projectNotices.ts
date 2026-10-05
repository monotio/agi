import { announceProjectWrite } from "../src/project/projectBroadcast.ts";

export const NOTICE_BARRIER = "test-notice-barrier";

/** A later message from the storage sender proves its earlier messages were delivered. */
export async function drainProjectNotices(channel: BroadcastChannel): Promise<void> {
  const delivered = new Promise<void>((resolve) => {
    const receive = (event: MessageEvent) => {
      if (event.data?.projectId !== NOTICE_BARRIER) return;
      channel.removeEventListener("message", receive);
      resolve();
    };
    channel.addEventListener("message", receive);
  });
  announceProjectWrite({ projectId: NOTICE_BARRIER, revision: "barrier", generation: 0 });
  await delivered;
}
