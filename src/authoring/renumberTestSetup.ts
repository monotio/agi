/** Resource identities inside recorded tests use the same native save and host codecs. */
import { decodeBase64, type GameTestSetup } from "../agent/gameTestSteps.ts";
import { decodeRecordedReplay } from "../agent/recordedReplay.ts";
import {
  decodeSave,
  encodeSave,
  decodeHostImage,
  encodeHostImage,
  type ReplayPair,
} from "../runtime/persistence.ts";
import type { ParkedContinuation } from "../runtime/replayState.ts";
import type { AgiProfile } from "../runtime/profile.ts";
import type { ResourceKind } from "../types.ts";
import { fnv1a32 } from "../runtime/hash.ts";
import { compileProjectLogic } from "./projectLogic.ts";
import { readBindingsDocument } from "./projectDocuments.ts";
import { parseWordsTok } from "../logic/words.ts";
import type { ProjectContent } from "./projectContent.ts";
const REPLAY_KINDS: Record<ResourceKind, readonly number[]> = {
  logic: [0],
  view: [1, 5, 7],
  picture: [2, 4, 6, 8],
  sound: [3, 9],
};
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function base64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const value = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    text +=
      BASE64[(value >>> 18) & 63]! +
      BASE64[(value >>> 12) & 63]! +
      (i + 1 < bytes.length ? BASE64[(value >>> 6) & 63]! : "=") +
      (i + 2 < bytes.length ? BASE64[value & 63]! : "=");
  }
  return text;
}
export function renumberTestSetup(input: {
  setup: GameTestSetup;
  kind: ResourceKind;
  from: number;
  to: number;
  profile: AgiProfile;
  documents: Readonly<Record<string, ProjectContent>>;
}): GameTestSetup {
  const replace = (number: number) => (number === input.from ? input.to : number);
  function pairs(pairs: ReplayPair[]): void {
    for (let i = 0; i < pairs.length; i++) {
      const pair = pairs[i]!;
      if (REPLAY_KINDS[input.kind].includes(pair.kind)) pair.value = replace(pair.value);
      // add.to.pic's following three pairs carry geometry and depth, rather than resource IDs.
      if (pair.kind === 5) i += 3;
    }
  }
  const host = decodeHostImage(decodeBase64(input.setup.image, "test setup"));
  const state = decodeSave(host.image, input.profile);
  if (input.kind === "logic") {
    state.vars[0] = replace(state.vars[0]!);
    state.vars[1] = replace(state.vars[1]!);
    for (const entry of state.logicResume) entry.logic = replace(entry.logic);
    if (input.from !== 255) {
      const size = (state.inventory[0] ?? 0) | ((state.inventory[1] ?? 0) << 8);
      for (
        let at = input.profile.inventoryHeaderBytes;
        at < input.profile.inventoryHeaderBytes + size;
        at += input.profile.inventoryEntryBytes
      )
        state.inventory[at + 2] = replace(state.inventory[at + 2]!);
    }
  }
  if (input.kind === "view") for (const object of state.objects) object.view = replace(object.view);
  if (input.kind === "picture") state.lastPicture = replace(state.lastPicture);
  pairs(state.replay);
  if (host.screen) pairs(host.screen);
  const bound = input.documents["bindings"];
  const bindings = readBindingsDocument(typeof bound === "string" ? bound : "{}");
  const words = input.documents["words"];
  const dictionary = new Map(
    words instanceof Uint8Array
      ? parseWordsTok(words).map((entry) => [entry.word, entry.id] as const)
      : typeof words === "string"
        ? (JSON.parse(words) as [string, number][])
        : [],
  );
  function continuation(continuation: ParkedContinuation | null | undefined): void {
    if (!continuation) return;
    for (const frame of continuation.frames) {
      if (input.kind === "logic") frame.logic = replace(frame.logic);
      const document = input.documents[`logic:${frame.logic}`];
      if (document !== undefined)
        frame.hash = fnv1a32(
          typeof document === "string"
            ? compileProjectLogic(document, { profile: input.profile, dictionary, bindings })
                .assembly.payload
            : document,
        );
    }
    if (input.kind === "view")
      for (const modal of continuation.modals)
        if (modal.kind === "showObj") modal.view = replace(modal.view);
  }
  continuation(host.continuation);
  let replay = input.setup.replay;
  if (replay) {
    const recording = decodeRecordedReplay(replay);
    if (input.kind === "view") {
      recording.state.viewCache.loaded = recording.state.viewCache.loaded.map(replace);
      recording.state.viewCache.order = recording.state.viewCache.order.map(replace);
    }
    if (input.kind === "sound" && recording.state.sound)
      recording.state.sound.num = replace(recording.state.sound.num);
    continuation(recording.state.continuation);
    replay = JSON.stringify(recording);
  }
  const image = encodeSave(state, input.profile);
  const wrapped =
    host.screen === null
      ? image
      : encodeHostImage(image, host.screen, host.presentation, host.continuation, host.amigaRegion);
  return { image: base64(wrapped), ...(replay === undefined ? {} : { replay }) };
}

/** Definite resource identities carried by a recorded setup, independent of arbitrary variables. */
export function testSetupReferences(
  setup: GameTestSetup,
  profile: AgiProfile,
): readonly { kind: ResourceKind; num: number }[] {
  const references: { kind: ResourceKind; num: number }[] = [];
  const host = decodeHostImage(decodeBase64(setup.image, "test setup"));
  const state = decodeSave(host.image, profile);
  const add = (kind: ResourceKind, num: number) => references.push({ kind, num });
  add("logic", state.vars[0]!);
  add("logic", state.vars[1]!);
  for (const entry of state.logicResume) add("logic", entry.logic);
  for (const object of state.objects) add("view", object.view);
  add("picture", state.lastPicture);
  const size = (state.inventory[0] ?? 0) | ((state.inventory[1] ?? 0) << 8);
  for (
    let at = profile.inventoryHeaderBytes;
    at < profile.inventoryHeaderBytes + size;
    at += profile.inventoryEntryBytes
  ) {
    const room = state.inventory[at + 2]!;
    if (room > 0 && room < 255) add("logic", room);
  }
  function pairs(pairs: readonly ReplayPair[]): void {
    for (let i = 0; i < pairs.length; i++) {
      const pair = pairs[i]!;
      for (const kind of ["logic", "picture", "view", "sound"] as const)
        if (REPLAY_KINDS[kind].includes(pair.kind)) add(kind, pair.value);
      if (pair.kind === 5) i += 3;
    }
  }
  function continuation(continuation: ParkedContinuation | null | undefined): void {
    if (!continuation) return;
    for (const frame of continuation.frames) add("logic", frame.logic);
    for (const modal of continuation.modals) if (modal.kind === "showObj") add("view", modal.view);
  }
  pairs(state.replay.slice(0, state.replayActive));
  pairs(host.screen ?? []);
  continuation(host.continuation);
  if (setup.replay) {
    const replay = decodeRecordedReplay(setup.replay);
    replay.state.viewCache.loaded.forEach((num) => add("view", num));
    replay.state.viewCache.order.forEach((num) => add("view", num));
    if (replay.state.sound) add("sound", replay.state.sound.num);
    continuation(replay.state.continuation);
  }
  return references;
}
