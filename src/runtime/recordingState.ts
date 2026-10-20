/** Resource-aware migration at the host recording boundary, never save.game. */
import { booterSoundPeriod, booterSoundRows } from "../sound/sound.ts";
import type { AgiProfile } from "./profile.ts";
import {
  REPLAY_STATE_VERSION,
  validateEngineReplayState,
  type EngineReplayState,
} from "./replayState.ts";

/**
 * Read released replay state into the current continuation model without
 * rewriting its stored representation. See fidelity.md, "2.001 speaker row
 * execution", for the byte-boundary and next-heartbeat continuation rule.
 */
export function migrateRecordedReplayState(
  value: unknown,
  profile: AgiProfile,
  getSound: (num: number) => Uint8Array | null,
): EngineReplayState {
  const state = validateEngineReplayState(value);
  if (
    state.version === REPLAY_STATE_VERSION ||
    profile.sound !== "booter-2.001" ||
    state.sound === null
  )
    return state;
  if (profile.sound === "booter-2.001" && state.sound !== null) {
    const sound = state.sound;
    const payload = getSound(sound.num);
    if (!payload) throw new Error("Recorded sound resource is missing.");
    const playback = sound.playback;
    const channel = playback.channels[0];
    // v1.2.4 split the entire payload (including its period) at every zero,
    // never changed countdown, and removed playback on the last old row.
    const ends: number[] = [];
    for (let i = 0; i < payload.length; i++) if (payload[i] === 0) ends.push(i + 1);
    if (payload.length > (ends.at(-1) ?? 0)) ends.push(payload.length);
    if (
      playback.channels.length !== 1 ||
      !playback.active ||
      playback.fade !== null ||
      !channel ||
      channel.terminated ||
      channel.countdown !== 1 ||
      channel.base !== 15 ||
      channel.envelopeIndex !== -1 ||
      channel.envelopeValue !== 0 ||
      (channel.cursor !== 0 && channel.cursor >= ends.length)
    )
      throw new Error("Recorded released booter playback is inconsistent with its resource.");
    const consumed = channel.cursor === 0 ? 0 : ends[channel.cursor - 1]!;
    const speaker = playback.device === 0;
    const rows =
      speaker && booterSoundPeriod(payload) === 0 ? [] : booterSoundRows(payload, speaker);
    let cursor = 0;
    let start = 1;
    for (const row of rows) {
      if (start >= consumed) break;
      cursor++;
      start += row.length + 1;
    }
    // Skip a partly consumed corrected row. The next whole row runs on the
    // next heartbeat; exhausted/period-zero speaker state cleans up then.
    channel.cursor = cursor;
    channel.countdown = 0;
  }
  return { ...state, version: REPLAY_STATE_VERSION };
}
