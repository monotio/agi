/**
 * Session adapters for the editable boilerplate in src/authoring/baseTemplate.ts
 * and the complete Starter seed in src/authoring/starterProject.ts. The
 * template text and pure compile/build steps live there so provider-free
 * project creation can use them; this module keeps the AgentSession install
 * paths and the existing import surface.
 */

import {
  BASE_TEMPLATE_DEATH_LOGIC_SOURCE,
  BASE_TEMPLATE_LOGIC0_SOURCE,
  compileBaseTemplate,
  TEMPLATE_DEATH_LOGIC,
  TEMPLATE_DEATH_SOUND,
} from "../authoring/baseTemplate.ts";
import { createStarterProject, type StarterProject } from "../authoring/starterProject.ts";
import { INITIAL_DIRECTORY_ENTRIES, openContainer } from "../container/container.ts";
import type { AgiProfile } from "../runtime/profile.ts";
import { RESOURCE_KINDS } from "../types.ts";
import { createAgentSessionState, type AgentSessionState } from "./agentState.ts";

export {
  BASE_TEMPLATE_DEATH_LOGIC_SOURCE,
  BASE_TEMPLATE_DEATH_TRACKS,
  BASE_TEMPLATE_LOGIC0_SOURCE,
  TEMPLATE_DEATH_LOGIC,
  TEMPLATE_DEATH_SOUND,
} from "../authoring/baseTemplate.ts";

/**
 * Compile and install just the boot/death boilerplate into a session state.
 * Genesis now seeds the complete Starter instead (installStarterSeed); this
 * narrower install stays for callers that ask specifically for logic 0, the
 * shared death logic and its cue — nothing else.
 */
export function installBaseTemplate(state: AgentSessionState, profile: AgiProfile): void {
  const built = compileBaseTemplate({ dictionary: state.sources.words, profile });
  state.container.putResource("logic", 0, built.logic0.payload);
  state.sources.logics.set(0, BASE_TEMPLATE_LOGIC0_SOURCE);
  state.container.putResource("logic", TEMPLATE_DEATH_LOGIC, built.deathLogic.payload);
  state.sources.logics.set(TEMPLATE_DEATH_LOGIC, BASE_TEMPLATE_DEATH_LOGIC_SOURCE);
  state.container.putResource("sound", TEMPLATE_DEATH_SOUND, built.deathSound);
}

function sameFiles(
  a: ReadonlyMap<string, Uint8Array>,
  b: ReadonlyMap<string, Uint8Array>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [name, bytes] of a) {
    const other = b.get(name);
    if (other === undefined || other.length !== bytes.length) return false;
    for (let index = 0; index < bytes.length; index++)
      if (bytes[index] !== other[index]) return false;
  }
  return true;
}

/**
 * Structural equality over the plain authored data a session carries:
 * source strings, view specs, sound track arrays or document envelopes,
 * inventory objects and binding records. Object keys compare in code-point
 * order — deterministic, never locale-dependent — and typed arrays compare
 * byte for byte.
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    if (!(a instanceof Uint8Array && b instanceof Uint8Array) || a.length !== b.length)
      return false;
    for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, index) => sameValue(value, b[index]))
    );
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    (key, index) =>
      key === bKeys[index] &&
      sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

/** Whether two same-keyed claim maps carry equal entries — no absent, extra or changed claim. */
function sameClaimMap<K>(a: ReadonlyMap<K, unknown>, b: ReadonlyMap<K, unknown>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, claim] of a) if (!sameValue(claim, b.get(key))) return false;
  return true;
}

/**
 * Whether the session still holds the untouched seed exactly: every native
 * file byte AND every authored claim — source maps, vocabulary, objects,
 * bindings. Identical compiled bytes do not make authored work untouched:
 * comments and other source metadata are real edits that can legitimately
 * produce the same bytecode, and a byte-identical imported or partial project
 * is not permission to discard its claims. Stored game tests (TESTS.JSON)
 * and the recorded world plan are authored metadata, not resource state: a
 * failed Genesis that recorded them may retry with them kept, so they sit
 * outside the comparison.
 */
function isUntouchedSeed(state: AgentSessionState, seed: StarterProject): boolean {
  const files = new Map(state.getFiles());
  files.delete("TESTS.JSON");
  if (!sameFiles(files, seed.files())) return false;
  const sources = state.sources;
  return (
    sameClaimMap(sources.logics, seed.sources.logics) &&
    sameClaimMap(sources.pictures, seed.sources.pictures) &&
    sameClaimMap(sources.views, seed.sources.views) &&
    sameClaimMap(sources.sounds, seed.sources.sounds) &&
    sameClaimMap(sources.words, seed.sources.words) &&
    sameValue(sources.objects ?? null, seed.sources.objects) &&
    sameValue(state.authoring.bindings, seed.bindings)
  );
}

/** The untouched fresh-session surface `createAgentSessionState()` produces. */
function isBlankSession(state: AgentSessionState): boolean {
  if (!sameFiles(state.getFiles(), createAgentSessionState().getFiles())) return false;
  return (
    state.sources.logics.size === 0 &&
    state.sources.pictures.size === 0 &&
    state.sources.views.size === 0 &&
    state.sources.sounds.size === 0 &&
    state.sources.words.size === 0 &&
    (state.sources.objects === undefined || state.sources.objects.length === 0) &&
    Object.keys(state.authoring.bindings).length === 0
  );
}

/**
 * Install the complete deterministic Starter — the same provider-free
 * snapshot manual Create produces — as a Genesis session's initial state:
 * native files, authored sources, dictionary, inventory and named bindings,
 * all before the first model turn.
 *
 * Admission is explicit: a blank session is seeded, and the untouched seed —
 * identical native bytes AND identical authored claims — is seeded again so a
 * failed first Genesis retries idempotently (recorded plans and game tests
 * survive). A completed, imported or otherwise authored session — anything
 * whose bytes, source claims, vocabulary, objects or bindings differ from the
 * seed's — is refused outright rather than silently reseeded or overwritten;
 * its partial work stays in place for review. Returns the installed seed so
 * the caller can describe exactly what the session holds.
 */
export function installStarterSeed(state: AgentSessionState): StarterProject {
  const seed = createStarterProject("starter");
  if (state.genesisComplete) {
    throw new Error(
      "Genesis cannot seed this session: it already holds a completed or imported game.",
    );
  }
  if (state.profile.id !== seed.profileId) {
    throw new Error(
      `Genesis seeds the ${seed.profileId} Starter; this session's ${state.profile.id} target would need its own template.`,
    );
  }
  if (!isUntouchedSeed(state, seed) && !isBlankSession(state)) {
    throw new Error(
      "Genesis cannot seed this session: it holds authored work that is not the untouched Starter.",
    );
  }
  const seedFiles = seed.files();
  const seedContainer = openContainer(seedFiles, { profile: seed.profileId });
  for (const kind of RESOURCE_KINDS) {
    for (let num = 0; num < INITIAL_DIRECTORY_ENTRIES; num++) {
      const payload = seedContainer.getResource(kind, num);
      if (payload !== null) state.container.putResource(kind, num, payload);
    }
  }
  const wordsFile = seedFiles.get("WORDS.TOK");
  if (wordsFile !== undefined) {
    state.container.putFile("WORDS.TOK", wordsFile);
    state.wordsPayload = new Uint8Array(wordsFile);
  }
  const objectFile = seedFiles.get("OBJECT");
  if (objectFile !== undefined) {
    state.container.putFile("OBJECT", objectFile);
    state.objectPayload = new Uint8Array(objectFile);
  }
  for (const [num, source] of seed.sources.logics) state.sources.logics.set(num, source);
  for (const [num, source] of seed.sources.pictures) state.sources.pictures.set(num, source);
  for (const [num, view] of seed.sources.views) state.sources.views.set(num, structuredClone(view));
  for (const [word, id] of seed.sources.words) state.sources.words.set(word, id);
  state.sources.objects = seed.sources.objects.map((object) => ({ ...object }));
  for (const [num, body] of seed.sources.sounds)
    state.sources.sounds.set(num, structuredClone(body));
  for (const [name, binding] of Object.entries(seed.bindings))
    state.authoring.bindings[name] = { ...binding };
  return seed;
}
