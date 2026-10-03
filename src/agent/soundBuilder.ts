/**
 * Backward-compatible home of the AGI sound payload builder. The
 * implementation lives in src/sound/build.ts so provider-free code paths can
 * use it without importing the agent layer; these re-exports keep existing
 * callers and their imports stable.
 */
export {
  buildSound,
  midiToAgiDivisor,
  parseNoteToMidi,
  type SoundNoteInput,
  type SoundTrackInput,
} from "../sound/build.ts";
