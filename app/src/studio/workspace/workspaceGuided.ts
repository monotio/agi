import { applySoundPreset } from "../../../../src/sound/presets.ts";
import { createSoundDocument } from "../../../../src/sound/document.ts";
import { ProjectDraft } from "../../../../src/authoring/projectDraft.ts";
import type { ProjectSnapshot } from "../../../../src/authoring/projectModel.ts";
import type { ProfileId } from "../../../../src/runtime/profile.ts";
import { parseWordsTok } from "../../../../src/logic/words.ts";
import { nextWordGroup } from "./wordGroups.ts";
import {
  prepareGuidedAddRoom,
  prepareGuidedPlaceHero,
  prepareGuidedRespondToCommand,
  prepareGuidedConnectDoor,
  prepareGuidedPlaySound,
} from "../../../../src/authoring/guidedProject.ts";

export type WorkspaceAction =
  | { kind: "add-room"; title: string }
  | { kind: "make-room"; key: string }
  | { kind: "place-hero"; room: number; x: number; y: number; view: number }
  | {
      kind: "response";
      room: number;
      command: string;
      response: string;
      alsoCommands?: readonly string[];
      teach?: { word: string; sameAs?: number };
    }
  | {
      kind: "door";
      room: number;
      destination: number;
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      arrival?: { x: number; y: number };
    }
  | { kind: "play-sound"; room: number; sound: number; command: string; preset?: string };

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
    case "make-room":
      return prepareGuidedAddRoom(
        context,
        action.key.startsWith("picture:")
          ? { existingPicture: Number(action.key.slice(8)) }
          : { heroView: Number(action.key.slice(5)) },
      );
    case "place-hero":
      return prepareGuidedPlaceHero(context, action);
    case "response": {
      const documents = { ...snapshot.documents() };
      const changes: Record<string, string | Uint8Array | null> = {};
      if (action.teach) {
        const content = documents["words"];
        const words: [string, number][] =
          typeof content === "string"
            ? JSON.parse(content)
            : content instanceof Uint8Array
              ? parseWordsTok(content).map(({ word, id }) => [word, id])
              : [];
        const { word, sameAs } = action.teach;
        if (words.some(([entry]) => entry === word))
          return {
            ok: false as const,
            message: `“${word}” already has a meaning. Try the sentence again.`,
          };
        if (
          sameAs !== undefined &&
          ([0, 1, 9999].includes(sameAs) || !words.some(([, id]) => id === sameAs))
        )
          return { ok: false as const, message: "Choose a meaning from your game's words." };
        words.push([word, sameAs ?? nextWordGroup(words)]);
        changes["words"] = JSON.stringify(words);
        documents["words"] = changes["words"];
      }
      const showCode = [];
      let prepared;
      for (const command of [action.command, ...(action.alsoCommands ?? [])]) {
        context.draft = new ProjectDraft(documents);
        prepared = prepareGuidedRespondToCommand(context, {
          ...action,
          command,
          replaceExisting: true,
        });
        if (!prepared.ok) return prepared;
        for (const change of prepared.changes) {
          changes[change.key] = change.content;
          if (change.content === null) delete documents[change.key];
          else documents[change.key] = change.content;
        }
        showCode.push(...prepared.showCode);
      }
      return {
        ...prepared!,
        changes: Object.entries(changes).map(([key, content]) => ({ key, content })),
        showCode,
      };
    }
    case "door":
      return prepareGuidedConnectDoor(context, {
        room: action.room,
        destination: action.destination,
        box: action,
        ...(action.arrival ? { arrival: action.arrival } : {}),
      });
    case "play-sound": {
      let sound = action.sound;
      const documents = snapshot.documents();
      let cue: { key: string; content: Uint8Array } | undefined;
      if (action.preset) {
        sound = 1;
        while (documents[`sound:${sound}`] !== undefined && sound < 256) sound++;
        if (sound > 255)
          return { ok: false as const, message: "SOUNDS is full. Edit an existing sound." };
        cue = {
          key: `sound:${sound}`,
          content: applySoundPreset(createSoundDocument({ profileId }), action.preset).encode(),
        };
        context.draft = new ProjectDraft({ ...documents, [cue.key]: cue.content });
      }
      const prepared = prepareGuidedPlaySound(context, {
        room: action.room,
        sound,
        on: { type: "command", command: action.command },
        createCommand: true,
      });
      return prepared.ok && cue ? { ...prepared, changes: [...prepared.changes, cue] } : prepared;
    }
  }
}
