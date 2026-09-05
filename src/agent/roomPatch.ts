import { openContainer } from "../container/container.ts";
import { disassembleLogic } from "../logic/disassembler.ts";
import { renderPicture } from "../picture/renderer.ts";
import { parseSound } from "../sound/sound.ts";
import {
  createPictureSurface,
  RESOURCE_KINDS,
  type GameContainer,
  type ResourceKind,
} from "../types.ts";
import { parseView } from "../view/view.ts";
import { detectProfile } from "../runtime/profile.ts";

import { validateRoomInventory } from "./inventory.ts";

export interface RoomPatch {
  objects?: Uint8Array;
  resources: { kind: ResourceKind; num: number; payload: Uint8Array }[];
  words: [string, number][];
}

/** Validate the entire response, including container capacity, before any live write. */
export function prepareRoomPatch(
  container: GameContainer,
  room: number,
  response: string,
  dictionary: ReadonlyMap<string, number>,
): RoomPatch {
  const raw = JSON.parse(response);
  if (!raw || raw.room !== room || !Array.isArray(raw.resources) || raw.resources.length > 256) {
    throw new Error("Invalid room authoring response");
  }
  const words: [string, number][] = raw.words ?? [...dictionary];
  if (
    !Array.isArray(words) ||
    words.some(
      (entry) =>
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        typeof entry[0] !== "string" ||
        !Number.isInteger(entry[1]) ||
        entry[1] < 0 ||
        entry[1] > 65535,
    )
  ) {
    throw new Error("Invalid room vocabulary");
  }
  const nextDictionary = new Map(words);
  for (const [word, id] of dictionary) {
    if (nextDictionary.get(word) !== id)
      throw new Error("Room authoring changed existing vocabulary");
  }
  const staged = openContainer(container.files);
  const profile = detectProfile(container.files);
  const resources: RoomPatch["resources"] = [];
  const seen = new Set<string>();
  for (const resource of raw.resources) {
    if (
      !resource ||
      !RESOURCE_KINDS.includes(resource.kind) ||
      !Number.isInteger(resource.num) ||
      resource.num < 0 ||
      resource.num > 255 ||
      !Array.isArray(resource.data) ||
      resource.data.length === 0 ||
      resource.data.length > 65535 ||
      resource.data.some(
        (byte: unknown) =>
          typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255,
      )
    ) {
      throw new Error("Invalid room resource");
    }
    const { kind, num } = resource as { kind: ResourceKind; num: number };
    const key = `${kind}:${num}`;
    if (seen.has(key)) throw new Error("Duplicate room resource");
    seen.add(key);
    if (
      container.getResource(kind, num) &&
      !((kind === "logic" || kind === "picture") && num === room)
    ) {
      throw new Error("Room authoring may not overwrite another resource");
    }
    const payload = new Uint8Array(resource.data);
    if (kind === "logic") {
      const source = disassembleLogic(payload, { dictionary: nextDictionary, profile });
      if (source.includes("// !!")) throw new Error("Invalid AGI logic in room response");
    } else if (kind === "picture") renderPicture(payload, createPictureSurface(), { profile });
    else if (kind === "view") parseView(payload, profile);
    else parseSound(payload);
    staged.putResource(kind, num, payload);
    resources.push({ kind, num, payload });
  }
  if (!staged.getResource("logic", room) || !staged.getResource("picture", room)) {
    throw new Error("Room authoring did not supply logic and picture");
  }
  let objects: Uint8Array | undefined;
  if (raw.objects !== undefined) {
    if (
      !Array.isArray(raw.objects) ||
      raw.objects.length > 65535 ||
      raw.objects.some(
        (b: unknown) => typeof b !== "number" || !Number.isInteger(b) || b < 0 || b > 255,
      )
    )
      throw new Error("Invalid room inventory bytes");
    objects = new Uint8Array(raw.objects);
    validateRoomInventory(container.files.get("OBJECT"), objects, profile);
  }
  return { resources, words, ...(objects ? { objects } : {}) };
}
