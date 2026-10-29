/**
 * A recorded host image's compatibility checks: which header version it
 * carries without decoding the whole image, and authentication of a restored
 * checkpoint against its stored fingerprint and released replay semantics.
 */
import { migrateRecordedReplayState } from "../../../src/runtime/recordingState.ts";
import type { EngineReplayState } from "../../../src/runtime/replayState.ts";
import type { AgiProfile } from "../../../src/runtime/profile.ts";
import { asReleasedHostImage, hostImageVersion } from "../../../src/runtime/persistence.ts";
import {
  historyFingerprint,
  type HistoryFingerprint,
  type HistorySemanticState,
} from "../../../src/agent/history.ts";
import { base64ToBytes, bytesToBase64 } from "../project/bytes.ts";

/**
 * The host image's header version byte, or undefined below the header. The
 * byte sits at offset 33, inside the first 48 base64 characters, so a
 * recording's image never needs its whole payload decoded to read it.
 */
export function recordedHostImageVersion(image: string): number | undefined {
  return hostImageVersion(base64ToBytes(image.slice(0, 48)));
}

/**
 * Whether the recorded semantic fingerprint holds of the restored state.
 * A released build's fingerprint covers its version-1 image, so a current
 * image retries with the released header byte (persistence.ts
 * `asReleasedHostImage`) — that retry only applies when the image's
 * continuation carries no v2-only fields.
 */
function fingerprintMatchesReleased(
  semantic: HistorySemanticState,
  expected: HistoryFingerprint,
): boolean {
  if (historyFingerprint(semantic).hash === expected.hash) return true;
  if (semantic.image === undefined) return false;
  const releasedImage = asReleasedHostImage(base64ToBytes(semantic.image));
  if (releasedImage === null) return false;
  return (
    historyFingerprint({ ...semantic, image: bytesToBase64(releasedImage) }).hash === expected.hash
  );
}

/**
 * Authenticate the stored checkpoint first, then compare the restored state.
 * A released replay's migrated expectation comes only from recorded state and
 * resource bytes, never from the recapture being checked. Stored bytes stay
 * unchanged, including the released host-image header and replay version.
 */
export function fingerprintMatchesRecorded(
  restored: HistorySemanticState,
  recorded: HistorySemanticState,
  expected: HistoryFingerprint,
  profile: AgiProfile,
  getSound: (num: number) => Uint8Array | null,
): boolean {
  if (historyFingerprint(recorded).hash !== expected.hash) return false;
  restored = withoutUnrecordedViewLoops(restored, recorded);
  if (restored.replay !== undefined && recorded.replay !== undefined) {
    // Older checkpoints did not record these gates. Compare only the fields
    // their fingerprint covered, after authenticating the stored state above.
    const replay = { ...(restored.replay as EngineReplayState) };
    const recordedReplay = recorded.replay as EngineReplayState;
    if (recordedReplay.menuGate === undefined) delete replay.menuGate;
    if (recordedReplay.releaseGate === undefined) delete replay.releaseGate;
    restored = { ...restored, replay };
  }
  if (fingerprintMatchesReleased(restored, expected)) return true;
  if (recorded.replay === undefined) return false;
  const replay = migrateRecordedReplayState(recorded.replay, profile, getSound);
  return fingerprintMatchesReleased(restored, historyFingerprint({ ...recorded, replay }));
}

/**
 * A replay state recorded before 1.2.6 carries no packed view orientation
 * (`viewCache.loops`, docs/fidelity.md F-VIEWS-01), and its fingerprint
 * covers the view cache without it: compare the restored state the same way.
 */
function withoutUnrecordedViewLoops(
  restored: HistorySemanticState,
  recorded: HistorySemanticState,
): HistorySemanticState {
  type Cache = { viewCache?: { loops?: unknown } };
  const restoredCache = (restored.replay as Cache | undefined)?.viewCache;
  const recordedCache = (recorded.replay as Cache | undefined)?.viewCache;
  // Restoring a recorded loop state always recaptures it, so only the new
  // optional field can be absent from the recorded side.
  if (restoredCache?.loops === undefined || recordedCache?.loops !== undefined) return restored;
  const { loops: _loops, ...viewCache } = restoredCache;
  return { ...restored, replay: { ...(restored.replay as object), viewCache } };
}
