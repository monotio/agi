/** Live display options share the editor's underlay while a slider is moving. */
import { shallowReactive } from "vue";
import type { ProjectSession } from "../../project/projectSession.ts";
import type { TraceTransform } from "../../../../src/creative/imageAttachments.ts";
export type TraceUnderlay = {
  pixels: Uint8Array;
  opacity: number;
  behindArt: boolean;
  transform?: TraceTransform;
  adjust?: ((transform: TraceTransform, release: boolean) => void) | undefined;
};
const presentations = new WeakMap<ProjectSession, Map<string, TraceUnderlay>>();
const storedOptions = new WeakMap<TraceUnderlay, { opacity: number; behindArt: boolean }>();
export function presentTrace(
  session: ProjectSession,
  target: string,
  underlay: TraceUnderlay | null,
) {
  if (!underlay) return null;
  let targets = presentations.get(session);
  if (!targets) {
    targets = new Map();
    presentations.set(session, targets);
  }
  const existing = targets.get(target);
  if (existing) {
    const previous = storedOptions.get(existing);
    // A repeated stored image keeps the slider's live input until its release.
    const keepPreview =
      !underlay.adjust &&
      existing.adjust &&
      previous?.opacity === underlay.opacity &&
      previous.behindArt === underlay.behindArt;
    const opacity = keepPreview ? existing.opacity : underlay.opacity;
    const behindArt = keepPreview ? existing.behindArt : underlay.behindArt;
    Object.assign(existing, underlay, { opacity, behindArt });
    if (!underlay.adjust)
      storedOptions.set(existing, { opacity: underlay.opacity, behindArt: underlay.behindArt });
    return existing;
  }
  const presented = shallowReactive(underlay);
  storedOptions.set(presented, { opacity: underlay.opacity, behindArt: underlay.behindArt });
  targets.set(target, presented);
  return presented;
}
export function previewTrace(
  session: ProjectSession,
  target: string,
  opacity: number,
  behindArt: boolean,
  options: Partial<TraceUnderlay> = {},
) {
  const underlay = presentations.get(session)?.get(target);
  if (underlay) Object.assign(underlay, { opacity, behindArt, ...options });
}
