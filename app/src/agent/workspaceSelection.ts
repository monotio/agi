/** Capture editor selection context against the same project snapshot as the task. */
import { createSelectionEdit, type SelectionFocus } from "../../../src/agent/selectionTools.ts";
import { pictureAssistScope, viewAssistScope } from "../../../src/studio/assistScope.ts";
import { parsePictureDocument } from "../../../src/studio/pictureDocument.ts";
import { compileEditDocument } from "../../../src/studio/editValidation.ts";
import { disassemblePicture } from "../../../src/picture/source.ts";
import { buildView, type BuildViewInput } from "../../../src/view/view.ts";
import { openSprite } from "../../../src/view/spriteDocument.ts";
import type { ProjectContent } from "../../../src/authoring/projectContent.ts";
import type { AgentRuntimeDeps } from "../../../src/agent/tools.ts";
import type { AgiProfile } from "../../../src/runtime/profile.ts";

export async function selectionScene(
  engine: AgentRuntimeDeps["engine"],
  room: number,
): Promise<Pick<SelectionFocus, "horizon" | "ghost">> {
  if (!engine) return {};
  const [stateResult, objectsResult] = await Promise.allSettled([engine.state(), engine.objects()]);
  const state =
    stateResult.status === "fulfilled"
      ? (stateResult.value as Record<string, unknown> | null)
      : null;
  if (state?.["room"] !== room) return {};
  const horizon = typeof state["horizon"] === "number" ? state["horizon"] : undefined;
  const objects =
    objectsResult.status === "fulfilled" && Array.isArray(objectsResult.value)
      ? (objectsResult.value as Record<string, unknown>[])
      : [];
  const actor = objects.find((object) => object["num"] === 0);
  if (
    !actor ||
    !["view", "loop", "cel", "x", "y", "priority"].every(
      (field) => typeof actor[field] === "number",
    )
  )
    return { horizon };
  return {
    horizon,
    ghost: {
      view: Number(actor["view"]),
      loop: Number(actor["loop"]),
      cel: Number(actor["cel"]),
      x: Number(actor["x"]),
      baselineY: Number(actor["y"]),
      priority: actor["fixedPriority"] ? Number(actor["priority"]) : "band",
    },
  };
}

export function workspaceSelection(
  context: string,
  documents: Readonly<Record<string, ProjectContent>>,
  profile: AgiProfile,
  scene: Pick<SelectionFocus, "horizon" | "ghost"> = {},
) {
  const picture =
    /Selection: PICTURE (\d+)[^\n]*\nSelected item ids: ([^\n]+)\. Lens: (art|depth|walk)\./.exec(
      context,
    );
  const view = /Selection: VIEW (\d+)[^\n]*\nSelected VIEW \d+, loop (\d+), cel (\d+)\./.exec(
    context,
  );
  const room = Number(/Current room (\d+)/.exec(context)?.[1] ?? 0);
  if (picture) {
    const num = Number(picture[1]);
    const content = documents[`picture:${num}`];
    if (content === undefined) return undefined;
    const source = typeof content === "string" ? content : disassemblePicture(content, { profile });
    const supplied = /Unlocks: (\{[^\n]+\})\./.exec(context);
    const parsed = supplied ? (JSON.parse(supplied[1]!) as Record<string, unknown>) : {};
    const unlocks = {
      visual: parsed["visual"] === true,
      priority: parsed["priority"] === true,
      depthInWalk: parsed["depthInWalk"] === true,
    };
    const compiled = compileEditDocument(parsePictureDocument(source).document, profile);
    const lens = picture[3] as "art" | "depth" | "walk";
    return createSelectionEdit({
      scope: pictureAssistScope({
        num,
        compiled,
        targetIds: picture[2]!.split(", "),
        lens,
        unlocks,
      }),
      draft: () => ({ kind: "picture", source }),
      lens,
      room,
      profile,
      ...scene,
    });
  }
  if (view) {
    const num = Number(view[1]);
    const content = documents[`view:${num}`];
    if (content === undefined) return undefined;
    const payload =
      typeof content === "string"
        ? buildView(JSON.parse(content) as BuildViewInput, profile)
        : content;
    return createSelectionEdit({
      scope: viewAssistScope({
        num,
        document: openSprite(payload, profile),
        targetCels: [{ loop: Number(view[2]), cel: Number(view[3]) }],
      }),
      draft: () => ({ kind: "view", payload }),
      room,
      profile,
      ...scene,
    });
  }
  return undefined;
}
