/**
 * Play here from Room Studio: Studio has settled its unkept changes and asks
 * to play from a spot; the shell closes Studio, shows Play, and jumps the
 * live game there (useEngine.playHere, app/src/worker/playHere.ts). When the
 * game could not place ego at the spot, it says why in one line on the stage.
 */
import { onScopeDispose, shallowRef } from "vue";
import type { PlayHereTarget } from "../../../src/studio/playHere.ts";

/** How long the stage keeps a Play here note. */
const NOTE_MS = 8000;

export function usePlayHereFromStudio(deps: {
  closeStudio(): void;
  showPlay(): void;
  playHere(target: PlayHereTarget): Promise<{ ok: boolean; reason?: string | undefined } | null>;
}) {
  const note = shallowRef<string | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onScopeDispose(() => clearTimeout(timer));

  function say(text: string | null): void {
    clearTimeout(timer);
    note.value = text;
    if (text) timer = setTimeout(() => (note.value = null), NOTE_MS);
  }

  async function play(target: PlayHereTarget): Promise<void> {
    say(null);
    deps.closeStudio();
    deps.showPlay();
    try {
      const reply = await deps.playHere(target);
      if (!reply?.ok) say(reply?.reason ?? "The game could not jump there.");
    } catch (error) {
      say(
        `The game could not jump there: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { note, play, dismiss: () => say(null) };
}
