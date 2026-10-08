import { checkProjectDocumentKey } from "../../../src/authoring/projectDocumentKey.ts";
/** A native editor target retains the identity of the conversation result that produced it. */
export interface AgentTarget {
  readonly projectId: string;
  readonly documentId: string;
  readonly taskId?: string;
  readonly messageId: string;
  readonly resource: string;
  readonly line?: number;
  readonly loop?: number;
  readonly cel?: number;
}
export function resolveAgentTarget(
  target: AgentTarget,
  current: { projectId: string; documentId: string },
): { kind: "current" | "earlier"; target: AgentTarget } {
  checkProjectDocumentKey(target.resource);
  if (target.projectId !== current.projectId)
    throw new Error("This result belongs to another game.");
  return { kind: target.documentId === current.documentId ? "current" : "earlier", target };
}
