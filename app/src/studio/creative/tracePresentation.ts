/** Live display options share the editor's underlay while a slider is moving. */
import { shallowReactive } from "vue";
import type { ProjectSession } from "../../project/projectSession.ts";
type Underlay = { pixels: Uint8Array; opacity: number; behindArt: boolean };
const presentations = new WeakMap<ProjectSession, Record<string, Underlay>>();
export function presentTrace(session: ProjectSession, target: string, underlay: Underlay | null) {
  if (!underlay) return null;
  let targets = presentations.get(session);
  if (!targets) {
    targets = {};
    presentations.set(session, targets);
  }
  const existing = targets[target];
  if (existing) {
    Object.assign(existing, underlay);
    return existing;
  }
  return (targets[target] = shallowReactive(underlay));
}
export function previewTrace(
  session: ProjectSession,
  target: string,
  opacity: number,
  behindArt: boolean,
) {
  const underlay = presentations.get(session)?.[target];
  if (underlay) Object.assign(underlay, { opacity, behindArt });
}
