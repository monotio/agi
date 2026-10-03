/**
 * The seam between {@link createOpenAiImageProvider} and the shared
 * creative intake: a provider offer carries the exact encoded bytes the
 * wire delivered, and this hands them — byte for byte — to the same
 * `decodeCreativeImage` an uploaded file takes. The offer keeps its
 * original; the intake result is what later staging stores.
 */
import {
  decodeCreativeImage,
  type CreativeImageIntake,
} from "../../references/creativeImageDecode.ts";
import type { OpenAiImageOffer } from "./openaiImageProvider.ts";

/**
 * Run a generated offer's exact encoded bytes through canonical intake:
 * header gate, single decode, orientation applied once, frozen RGBA8
 * snapshot with hashes. A defensive copy leaves the offer's own bytes
 * untouched. Refusals surface as CreativeImageError, same as an upload.
 */
export function intakeGeneratedImage(
  offer: OpenAiImageOffer,
  signal?: AbortSignal,
): Promise<CreativeImageIntake> {
  const blob = new Blob([offer.encodedBytes.slice()], { type: offer.encoded.mime });
  return decodeCreativeImage(blob, signal);
}
