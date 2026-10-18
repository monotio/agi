/**
 * A recorded host image's compatibility checks: which header version it
 * carries without decoding the whole image, and the semantic fingerprint
 * retry that re-stamps a current image with the released version-1 byte.
 */
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
export function fingerprintMatchesReleased(
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
