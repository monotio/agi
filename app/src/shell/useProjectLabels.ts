import { computed } from "vue";
import { useEngineApi } from "../engine/engineContext.ts";
import { projectLabelContext } from "./projectLabelContext.ts";

/** Live names for app surfaces that already belong to the open game. */
export function useProjectLabels() {
  const engine = useEngineApi();
  return computed(() => {
    void engine.state.patchTick;
    const resources = engine.roomMap.resources.value;
    return projectLabelContext(
      engine.getProjectSession()?.workingSnapshot().documents() ?? {},
      resources.profile ?? undefined,
      engine.roomMap.graph.value.nodes.map((node) => ({
        room: node.room,
        title: node.title,
        pictures: resources.shared.has(node.room)
          ? []
          : (resources.scans.get(node.room)?.pictures ?? []),
      })),
    );
  });
}
