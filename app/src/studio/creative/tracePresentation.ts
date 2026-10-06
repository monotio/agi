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
    Object.assign(existing, underlay);
    return existing;
  }
  const presented = shallowReactive(underlay);
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
