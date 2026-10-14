import { createApp, h, ref } from "vue";
import UiToast from "../../src/ui/UiToast.vue";

/** The real toast, with the keyed replacement used by stage notices. */
export function mountNotices(): void {
  window.__AGI_NOTICE_MS__ = 1000;
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:100px auto auto 20px;z-index:9999;width:320px";
  document.body.append(host);
  const serial = ref(1);
  const visible = ref(true);
  createApp({
    setup: () => () => [
      h("button", { onClick: () => serial.value++, "data-testid": "replace-notice" }, "Replace"),
      visible.value
        ? h(
            UiToast,
            {
              key: serial.value,
              timed: true,
              dismissible: true,
              onDismiss: () => (visible.value = false),
            },
            () => `Notice ${serial.value}`,
          )
        : null,
    ],
  }).mount(host);
}

// Hold the editor worker's reply to reproduce approval during an unfinished diff.
// A worker returns no result when its text models have already been removed.
export function holdDiff(): void {
  const post = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (this: Worker, ...args: Parameters<typeof post>) {
    const message = args[0] as { method?: string; vsWorker?: number; req?: string };
    if (message.method !== "$computeDiff") return post.apply(this, args);
    pendingDiff = () => {
      Worker.prototype.postMessage = post;
      this.dispatchEvent(
        new MessageEvent("message", {
          data: {
            vsWorker: message.vsWorker,
            type: 1,
            seq: message.req,
            res: null,
          },
        }),
      );
    };
  } as typeof post;
}
let pendingDiff: (() => void) | undefined;
export function diffPending(): boolean {
  return pendingDiff !== undefined;
}
export async function approveBeforeDiff(): Promise<void> {
  await new Promise<void>((resolve) => {
    const observer = new MutationObserver(() => {
      if (document.querySelector('[data-testid="agent-review"]')) return;
      observer.disconnect();
      pendingDiff!();
      pendingDiff = undefined;
      resolve();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    document.querySelector<HTMLButtonElement>('[data-testid="agent-approve"]')!.click();
  });
  // Let the diff continuation and Monaco's error reporting finish.
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}
