import { ProjectDraft } from "../../../../src/authoring/projectDraft.ts";
import type { ProjectSnapshot } from "../../../../src/authoring/projectModel.ts";
import type { ProfileId } from "../../../../src/runtime/profile.ts";
import {
  prepareGuidedAddRoom,
  prepareGuidedPlaceHero,
  prepareGuidedRespondToCommand,
  prepareGuidedConnectDoor,
  prepareGuidedPlaySound,
} from "../../../../src/authoring/guidedProject.ts";

export type WorkspaceAction =
  | { kind: "add-room"; title: string }
  | { kind: "place-hero"; room: number; x: number; y: number; view: number }
  | { kind: "response"; room: number; command: string; response: string }
  | {
      kind: "door";
      room: number;
      destination: number;
      x1: number;
      y1: number;
      x2: number;
      y2: number;
    }
  | { kind: "play-sound"; room: number; sound: number; command: string };

/** Guided kernels prepare detached changes; ProjectSession owns their admission and History. */
export function prepareWorkspaceAction(
  snapshot: ProjectSnapshot,
  profileId: ProfileId,
  action: WorkspaceAction,
) {
  const context = {
    draft: new ProjectDraft(snapshot.documents()),
    files: Object.fromEntries(snapshot.lastAdmissibleBuild!.files()),
    profileId,
  };
  switch (action.kind) {
    case "add-room":
      return prepareGuidedAddRoom(context, { title: action.title });
    case "place-hero":
      return prepareGuidedPlaceHero(context, action);
    case "response":
      return prepareGuidedRespondToCommand(context, { ...action, replaceExisting: true });
    case "door":
      return prepareGuidedConnectDoor(context, {
        room: action.room,
        destination: action.destination,
        box: action,
      });
    case "play-sound":
      return prepareGuidedPlaySound(context, {
        room: action.room,
        sound: action.sound,
        on: { type: "command", command: action.command },
      });
  }
}
