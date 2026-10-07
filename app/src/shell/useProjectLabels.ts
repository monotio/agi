import { computed } from "vue";
import { useEngineApi } from "../engine/engineContext.ts";
import { projectLabelContext } from "./projectLabelContext.ts";
import { PROFILES, type ProfileId } from "../../../src/runtime/profile.ts";

/** Live names for app surfaces that already belong to the open game. */
export function useProjectLabels() {
  const engine = useEngineApi();
  return computed(() => {
    void engine.state.patchTick;
    // Map and Create request analysis; Play headings only consume its results.
    const resources =
      engine.roomMap.analysisStatus.value === "idle" ? undefined : engine.roomMap.resources.value;
    return projectLabelContext(
      engine.getProjectSession()?.workingSnapshot().documents() ?? {},
      engine.state.profile ? PROFILES[engine.state.profile as ProfileId] : undefined,
      resources
        ? engine.roomMap.graph.value.nodes.map((node) => ({
            room: node.room,
            title: node.title,
            pictures: resources.shared.has(node.room)
              ? []
              : (resources.scans.get(node.room)?.pictures ?? []),
          }))
        : [],
    );
  });
}
