/**
 * Copy-on-write cel patching for AGI views.
 *
 * Loops whose offset table entries point at the same loop data are alias
 * groups: one data block shared by a loop and its mirrors. Patching rebuilds
 * the view so every edited loop is isolated into its own block — its
 * displayed pixels plus the edits — while untouched members keep sharing the
 * original block. A replacement for a cel the loop displays mirrored is
 * flipped back before storing, so replacements are always written in file
 * orientation.
 */
import type { AgiProfile } from "../runtime/profile.ts";
import {
  buildView,
  parseView,
  readViewCel,
  type AgiView,
  type BuildCelInput,
  type BuildLoopInput,
  type BuildViewInput,
  type ViewCel,
} from "./view.ts";

function u16le(payload: Uint8Array, offset: number): number {
  return payload[offset]! | (payload[offset + 1]! << 8);
}

export interface AliasGroup {
  readonly members: number[];
  readonly cels: BuildCelInput[];
  readonly headerHigh: number;
  readonly controlHighs: number[];
}

export interface MetadataPlan {
  readonly loop: number;
  readonly headerHigh: number;
  readonly controlHighs: readonly number[];
}

function cloneCel(cel: ViewCel): BuildCelInput {
  return {
    width: cel.width,
    height: cel.height,
    transparentColor: cel.transparentColor,
    mirror: false,
    pixels: cel.pixels.slice(),
  };
}

export function aliasGroups(payload: Uint8Array, view: AgiView, packed: boolean): AliasGroup[] {
  const byOffset = new Map<number, AliasGroup>();
  const groups: AliasGroup[] = [];
  for (let loop = 0; loop < view.loops.length; loop++) {
    const loopStart = u16le(payload, 5 + loop * 2);
    const existing = byOffset.get(loopStart);
    if (existing) {
      existing.members.push(loop);
      continue;
    }
    const header = payload[loopStart]!;
    const celCount = packed ? header & 0x0f : header;
    const cels: BuildCelInput[] = [];
    const controlHighs: number[] = [];
    for (let cel = 0; cel < celCount; cel++) {
      const loaded = readViewCel(view, loop, cel);
      if (!loaded) throw new RangeError(`view loop ${loop}, cel ${cel} could not be decoded`);
      cels.push(cloneCel(loaded));
      const celStart = loopStart + u16le(payload, loopStart + 1 + cel * 2);
      controlHighs.push(payload[celStart + 2]! & 0xf0);
    }
    const group: AliasGroup = {
      members: [loop],
      cels,
      headerHigh: header & 0xf0,
      controlHighs,
    };
    byOffset.set(loopStart, group);
    groups.push(group);
  }
  return groups;
}

/** The cel flipped left to right, as a mirrored loop displays it. */
export function flipHorizontal(cel: BuildCelInput): BuildCelInput {
  const pixels = new Uint8Array(cel.width * cel.height);
  for (let y = 0; y < cel.height; y++) {
    for (let x = 0; x < cel.width; x++) {
      pixels[y * cel.width + x] = cel.pixels[y * cel.width + cel.width - 1 - x]!;
    }
  }
  return { ...cel, pixels };
}

export function applyMetadata(
  payload: Uint8Array,
  packed: boolean,
  plans: readonly MetadataPlan[],
): void {
  for (const plan of plans) {
    const loopStart = u16le(payload, 5 + plan.loop * 2);
    if (packed) payload[loopStart] = (payload[loopStart]! & 0x0f) | plan.headerHigh;
    else {
      for (let cel = 0; cel < plan.controlHighs.length; cel++) {
        const celStart = loopStart + u16le(payload, loopStart + 1 + cel * 2);
        payload[celStart + 2] = (payload[celStart + 2]! & 0x0f) | plan.controlHighs[cel]!;
      }
    }
  }
}

/**
 * Rebuild a view with a set of cel replacements resolved against the original
 * snapshot. Loop-alias groups are copy-on-write: a patched loop is isolated
 * into its own data (its displayed pixels plus the edits), while untouched
 * members keep sharing the original block. Patches to several members of one
 * alias group isolate each of them.
 */
export function patchedView(
  original: Uint8Array,
  profile: AgiProfile,
  targets: ReadonlyMap<number, ReadonlyMap<number, BuildCelInput>>,
  adjustments: string[],
): { payload: Uint8Array; spec: BuildViewInput } {
  const view = parseView(original, profile);
  const groups = aliasGroups(original, view, profile.packedViewLoopHeader);
  const loops: BuildLoopInput[] = new Array(view.loops.length);
  const plans: MetadataPlan[] = [];
  for (const group of groups) {
    const targeted = group.members.filter((member) => targets.has(member));
    if (group.members.length === 1 || targeted.length === 0) {
      const first = group.members[0]!;
      const cels: BuildCelInput[] = group.cels.map((cel) => ({
        ...cel,
        pixels: Uint8Array.from(cel.pixels),
      }));
      if (targeted.length === 1) {
        for (const [celIndex, replacement] of targets.get(first)!) {
          const displayed = view.loops[first]!.cels[celIndex]!;
          cels[celIndex] = displayed.mirrored ? flipHorizontal(replacement) : replacement;
        }
      }
      loops[first] = { cels };
      for (const member of group.members.slice(1)) loops[member] = { mirrorLoop: first };
      plans.push({ loop: first, headerHigh: group.headerHigh, controlHighs: group.controlHighs });
      continue;
    }

    // Untargeted members keep one shared block; each targeted loop is isolated
    // with its displayed pixels plus this loop's edits.
    for (const loop of targeted) {
      const displayedCels = view.loops[loop]!.cels.map(cloneCel);
      for (const [celIndex, replacement] of targets.get(loop)!)
        displayedCels[celIndex] = replacement;
      loops[loop] = { cels: displayedCels };
    }
    const remaining = group.members.filter((loop) => !targets.has(loop));
    if (remaining.length) {
      const firstRemaining = remaining[0]!;
      loops[firstRemaining] = {
        cels: group.cels.map((cel) => ({ ...cel, pixels: Uint8Array.from(cel.pixels) })),
      };
      for (const member of remaining.slice(1)) loops[member] = { mirrorLoop: firstRemaining };
      plans.push({
        loop: firstRemaining,
        headerHigh: group.headerHigh,
        controlHighs: group.controlHighs,
      });
    }
    adjustments.push(
      `Loop${targeted.length > 1 ? "s" : ""} ${targeted.join(", ")} ${targeted.length > 1 ? "were" : "was"} isolated from its mirrored alias before patching so the other facing${remaining.length === 1 ? "" : "s"} retained its pixels.`,
    );
  }
  const payload = buildView(
    { loops, ...(view.description === undefined ? {} : { description: view.description }) },
    profile,
  );
  applyMetadata(payload, profile.packedViewLoopHeader, plans);
  // The kept orientation nibbles can make a loop display otherwise than the
  // builder input above; record the spec of the bytes themselves.
  return { payload, spec: viewSpec(payload, profile) };
}

/**
 * The editable spec of a stored VIEW payload: a spec `buildView` turns back
 * into a VIEW every loop of which displays exactly what the payload's loop
 * displays. What a Keep records in `sources.views` for bytes edited outside a
 * spec (Sprite Studio) and what `patchedView` records.
 *
 * A builder spec cannot hold orientation nibbles: an owner's cels are stored
 * as it displays them, and a `mirrorLoop` member shows them flipped unless
 * its orientation (v2: index mod 8) equals the owner's. So each block's
 * owner records its displayed cels, and each other member becomes a mirror
 * of the first earlier loop of its block that it displays that way; a member
 * the payload shows otherwise — a block shared unmirrored, or one whose
 * nibble names no member — records its own displayed cels. Throws RangeError
 * when the payload does not decode.
 */
export function viewSpec(
  payload: Uint8Array,
  profile: Pick<AgiProfile, "packedViewLoopHeader">,
): BuildViewInput {
  const packed = profile.packedViewLoopHeader;
  const view = parseView(payload, profile);
  const loops: BuildLoopInput[] = new Array(view.loops.length);
  // The builder mirrors packed loops 0..3 only, always flipped; v2 members
  // show the owner's cels flipped unless their orientations coincide.
  const canMirror = (host: number, member: number) => !packed || (host < 4 && member < 4);
  const flips = (host: number, member: number) => packed || (host & 7) !== (member & 7);
  for (const group of aliasGroups(payload, view, packed)) {
    const hosts = new Map<number, BuildCelInput[]>();
    for (const member of group.members) {
      const cels = view.loops[member]!.cels.map(cloneCel);
      const host = [...hosts].find(
        ([loop, hostCels]) =>
          canMirror(loop, member) &&
          hostCels.every((cel, index) => {
            const shown = flips(loop, member) ? flipHorizontal(cel) : cel;
            return shown.pixels.every((pixel, at) => pixel === cels[index]!.pixels[at]);
          }),
      );
      if (host) {
        loops[member] = { mirrorLoop: host[0] };
        continue;
      }
      hosts.set(member, cels);
      loops[member] = { cels: cels.map((cel) => ({ ...cel, pixels: [...cel.pixels] })) };
    }
  }
  return view.description === undefined ? { loops } : { loops, description: view.description };
}
