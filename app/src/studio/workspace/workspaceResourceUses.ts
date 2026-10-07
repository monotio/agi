import {
  sameProjectContent,
  type ProjectContent,
} from "../../../../src/authoring/projectContent.ts";
import { readBindingsDocument } from "../../../../src/authoring/projectDocuments.ts";
import { inspectProjectSourceDependencies } from "../../../../src/authoring/projectSourceDependencies.ts";
import type { AgiProfile } from "../../../../src/runtime/profile.ts";
import { inspectLogicResource } from "../../../../src/logic/disassembler.ts";
import { resourceReferenceOperand } from "../../../../src/logic/commandReference.ts";

/** Room scan replies and art drafts reuse the unchanged LOGIC dependency reads. */
export function createWorkspaceResourceUses() {
  const cache: Record<
    string,
    {
      content: ProjectContent | undefined;
      bindings: string | undefined;
      profile: string;
      resources: readonly string[];
    }
  > = {};
  return (
    key: string,
    content: ProjectContent | undefined,
    bindings: string | undefined,
    profile: AgiProfile,
  ): readonly string[] => {
    const previous = cache[key];
    if (
      previous &&
      previous.profile === profile.id &&
      previous.bindings === bindings &&
      sameProjectContent(previous.content, content)
    )
      return previous.resources;
    let resources: readonly string[] = [];
    if (content instanceof Uint8Array) {
      try {
        const decoded = inspectLogicResource(content, { profile });
        resources = decoded.instructions.flatMap((instruction) => {
          if (instruction.kind !== "action" || !instruction.name || !instruction.args) return [];
          const role = resourceReferenceOperand(instruction.name, profile);
          if (!role || role.variable) return [];
          return [
            role.kind === "item" ? "inventory" : `${role.kind}:${instruction.args[role.operand]}`,
          ];
        });
      } catch {
        // Keep scan evidence when retained bytecode cannot be decoded.
      }
    } else if (typeof content === "string") {
      try {
        resources = inspectProjectSourceDependencies({
          source: content,
          profile,
          bindings: readBindingsDocument(bindings ?? "{}"),
        }).references.map((reference) => reference.dependency);
      } catch {
        // Native room relationships remain available while code is unfinished.
      }
    }
    cache[key] = { content, bindings, profile: profile.id, resources };
    return resources;
  };
}
