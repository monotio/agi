/**
 * Every way out of a Studio, shared by Room and Sprite Studio: the Keep /
 * Discard / Cancel question before leaving (useStudioLeave), Keep and
 * Discard from the top bar, and the recoveries a failed Keep offers
 * (retry, or reopen on the running game or on the game reloaded from
 * storage, leaving the draft behind).
 */

import type { KeepRecovery } from "./useStudioKeep.ts";
import { useStudioLeave } from "./useStudioLeave.ts";
import type { StudioNotice } from "./useStudioNotice.ts";

export interface StudioExitOptions {
  readonly embedded?: boolean;
  /** The unkept draft: the picture and its room's logic, or the view. */
  readonly draft: { readonly dirty: { readonly value: boolean }; discard(): void };
  readonly keeper: {
    keep(): Promise<boolean>;
    dismiss(): void;
    readonly needsReload: { readonly value: boolean };
    readonly banner: { readonly value: { readonly fromStorage?: boolean } | null };
  };
  readonly say: (notice: StudioNotice | null) => void;
  /** What a successful Keep says (a lesson's challenge verdict included). */
  readonly keptNotice: () => StudioNotice;
  /** Focus back to the studio root once Keep has disabled itself. */
  readonly keepFocus: () => void;
  /** Settle a gesture in progress before a Keep or a Discard. */
  readonly settle?: () => void;
  readonly close: () => void;
  readonly reopen: (fromStorage: boolean) => void;
}

export function useStudioExit(options: StudioExitOptions) {
  const { draft, keeper, say } = options;
  const leave = useStudioLeave({
    unkept: () => draft.dirty.value && !keeper.needsReload.value,
    keep: () => keepChanges(),
    discard: () => draft.discard(),
  });

  async function requestClose(): Promise<void> {
    if (options.embedded || (await leave.confirm())) options.close();
  }
  function discardChanges(): void {
    leave.discarding.value = false;
    options.settle?.();
    draft.discard();
    say({ tone: "ok", text: "Changes discarded." });
  }
  /** Keep the draft and say so; resolves whether it was kept. */
  async function keepChanges(): Promise<boolean> {
    options.settle?.();
    const kept = await keeper.keep();
    // Keep disables itself once the draft is kept: the keys must not fall out of Studio.
    options.keepFocus();
    if (!kept) return false;
    say(options.keptNotice());
    return true;
  }
  async function recover(recovery: KeepRecovery): Promise<void> {
    if (recovery === "retry") return void keepChanges();
    // The draft was made on a game that moved on. Storage moved past the
    // running game (a Keep elsewhere, or a saved edit the game never loaded):
    // the game reloads from storage first, and the draft cannot come along.
    await reopen(keeper.banner.value?.fromStorage === true);
  }
  /** Reopen Studio on the running game, or on the game reloaded from storage; the draft stays behind. */
  async function reopen(fromStorage: boolean): Promise<void> {
    if (fromStorage && !(await leave.confirmReload())) return;
    keeper.dismiss();
    draft.discard();
    options.reopen(fromStorage);
  }

  return { leave, dialog: leave.ask, requestClose, discardChanges, keepChanges, recover, reopen };
}
