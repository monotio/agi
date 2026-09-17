import {
  requireProjectId,
  requireResourceRevision,
  type ProjectId,
  type ResourceRevision,
} from "../../src/gameIdentity.ts";

/** A fixture project id, validated like a stored one. */
export function testProjectId(value: string): ProjectId {
  return requireProjectId(value);
}

/**
 * A fixture resource revision: the label's bytes as hex, right-aligned in a
 * 64-hex digest, so labels stay distinct while matching the stored shape.
 */
export function testRevision(label: string): ResourceRevision {
  const hex = Array.from(label, (ch) => ch.codePointAt(0)!.toString(16).padStart(2, "0")).join("");
  return requireResourceRevision(hex.slice(-64).padStart(64, "0"));
}
