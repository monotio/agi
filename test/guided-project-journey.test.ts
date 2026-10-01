import { test } from "node:test";
import assert from "node:assert/strict";
import { readProjectDocuments } from "../src/authoring/projectDocuments.ts";
import { ProjectDraft } from "../src/authoring/projectDraft.ts";
import { compileProjectSelection } from "../src/authoring/projectSelection.ts";
import { createStarterProject } from "../src/authoring/starterProject.ts";
import {
  prepareGuidedAddRoom,
  prepareGuidedConnectDoor,
  prepareGuidedPlaceHero,
  prepareGuidedPlaySound,
  prepareGuidedRespondToCommand,
  type GuidedContext,
  type PreparedGuidedOperation,
} from "../src/authoring/guidedProject.ts";
import { openContainer } from "../src/container/container.ts";
import { parseWordsTok } from "../src/logic/words.ts";
import { parseSound } from "../src/sound/sound.ts";
import { PROFILES } from "../src/runtime/profile.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";

const ENTER = 0x0d;
const ARROW_DOWN = 0x5000;

class JourneyHost implements EngineHost {
  keys: number[] = [];
  lines: string[] = [];
  sounds: number[] = [];
  printed: string[] = [];
  waitKey(): number {
    return 0;
  }
  takeKeys(): number[] {
    return this.keys.splice(0);
  }
  takeInputLine(): string | null {
    return this.lines.shift() ?? null;
  }
  playSound(num: number): void {
    this.sounds.push(num);
  }
  print(text: string): void {
    this.printed.push(text);
  }
  displayAt(): void {}
  statusLine(): void {}
}

function mustPrepare(outcome: { ok: boolean; message?: string }): PreparedGuidedOperation {
  assert.ok(outcome.ok, `prepare refused: ${outcome.ok ? "" : outcome.message}`);
  return outcome as PreparedGuidedOperation;
}

function rows(engine: Engine): string {
  const out: string[] = [];
  for (let r = 0; r < 25; r++) out.push(engine.textRow(r));
  return out.join("\n");
}

/**
 * The authored walkthrough: Starter seed, then nothing but the five guided
 * operations — hero placed, a second room added, doors connected both ways,
 * a custom command answered, a sound cue bound to it — then compiled through
 * the shared selection pipeline and played by the real interpreter.
 */
test("a novice's guided chain produces a playable two-room game", () => {
  const project = createStarterProject("starter");
  const files = Object.fromEntries(project.files());
  const sources: Record<string, string> = {};
  for (const [num, source] of project.sources.logics) sources[`logic:${num}`] = source;
  for (const [num, source] of project.sources.pictures) sources[`picture:${num}`] = source;
  const read = readProjectDocuments({
    files,
    profileId: project.profileId,
    sources,
    bindings: project.bindings,
  });
  assert.deepEqual(read.diagnostics, []);
  const draft = new ProjectDraft(read.documents);
  const ctx: GuidedContext = { draft, files, profileId: project.profileId };

  // 1. Place the hero nearer the clearing's centre.
  mustPrepare(prepareGuidedPlaceHero(ctx, { room: 1, x: 100, y: 130 })).apply();

  // 2. Add a second room with the same hero standing at (76,110).
  const added = mustPrepare(
    prepareGuidedAddRoom(ctx, {
      title: "Moonlit Hall",
      heroView: "ego_view",
      spawn: { x: 76, y: 110 },
    }),
  );
  added.apply();
  assert.ok(added.affectedKeys.includes("logic:2"));
  assert.ok(added.affectedKeys.includes("picture:2"));

  // 3. Doors in both directions; arriving from room 1 stands ego at (100,140).
  mustPrepare(
    prepareGuidedConnectDoor(ctx, {
      room: 1,
      destination: 2,
      box: { x1: 70, y1: 150, x2: 120, y2: 167 },
      returnDoor: { box: { x1: 90, y1: 150, x2: 110, y2: 167 } },
      arrival: { x: 100, y: 140 },
    }),
  ).apply();

  // 4. A personalized answer to "wave".
  mustPrepare(
    prepareGuidedRespondToCommand(ctx, {
      room: 1,
      command: "wave",
      response: "You wave at the trees.",
    }),
  ).apply();

  // 5. The same command starts the seeded chime; completion prints a line.
  const cue = mustPrepare(
    prepareGuidedPlaySound(ctx, {
      room: 1,
      sound: "chime_sound",
      on: { type: "command", command: "wave" },
      completionMessage: "The tune fades.",
    }),
  );
  cue.apply();
  const bindings = JSON.parse(
    cue.changes.find((c) => c.key === "bindings")!.content as string,
  ) as Record<string, { kind: string; num: number }>;
  const doneFlag = bindings["cue_done"]!.num;

  // Compile the dependency-closed selection through the shared document path.
  const dirty = draft.dirtyKeys();
  const built = compileProjectSelection({
    draft,
    files,
    profileId: project.profileId,
    keys: dirty,
  });
  const gameFiles = built.compiled.files();
  const dictionary = new Map(
    parseWordsTok(gameFiles.get("WORDS.TOK")!).map(({ word, id }) => [word, id]),
  );
  assert.equal(dictionary.get("wave"), 104, "the new word registered beside the seeded ones");
  const container = openContainer(gameFiles, { profile: PROFILES[project.profileId] });
  const host = new JourneyHost();
  const engine = new Engine(container, host, dictionary, { profile: PROFILES[project.profileId] });

  const tickUntil = (want: () => boolean, limit: number, what: string) => {
    for (let i = 0; i < limit && !want(); i++) engine.tick();
    assert.ok(want(), `expected ${what} within ${limit} cycles`);
  };

  // Boot into room 1: the guided position, view and picture are in effect.
  tickUntil(() => engine.readState().room === 1 && engine.readState().inputEnabled, 20, "room 1");
  const ego = () => engine.readObjects().find((o) => o.num === 0)!;
  assert.equal(ego().x, 100);
  assert.equal(ego().y, 130);
  assert.equal(ego().view, 1);

  // "wave" answers and starts the cue.
  host.lines.push("wave");
  tickUntil(() => rows(engine).includes("You wave at the trees."), 20, "the wave reply");
  assert.deepEqual(host.sounds, [1], "the cue started SOUND 1");
  host.keys.push(ENTER);
  engine.tick();

  // The completion flag sets on the host-driven 60Hz sound channel once the
  // chime's parsed duration elapses; the guided handler then prints and resets.
  const chimeTicks = parseSound(container.getResource("sound", 1)!).duration;
  for (let i = 0; i <= chimeTicks; i++) engine.soundTick();
  assert.equal(
    engine.readState().flags[doneFlag],
    1,
    `flag ${doneFlag} latches when the cue finishes`,
  );
  tickUntil(() => host.printed.includes("The tune fades."), 10, "the completion line");
  // The modal print suspends the rest of the pass; reset runs after dismissal.
  host.keys.push(ENTER);
  engine.tick();
  assert.equal(engine.readState().flags[doneFlag], 0, "the completion handler resets the flag");

  // Walk south through the doorway: posn box → new.room(2), arrival override.
  host.keys.push(ARROW_DOWN);
  tickUntil(() => engine.readState().room === 2, 200, "the doorway transition");
  assert.equal(engine.readState().previousRoom, 1);
  assert.equal(ego().x, 100);
  assert.equal(ego().y, 140, "the coordinated arrival spawn, not the room's own");

  // Walk south again in room 2: the mirrored doorway returns to room 1.
  host.keys.push(ARROW_DOWN);
  tickUntil(() => engine.readState().room === 1, 200, "the return doorway");
  assert.equal(ego().x, 100);
  assert.equal(ego().y, 130, "room 1's own spawn, no arrival override from boot");
  for (let i = 0; i < 10; i++) engine.tick();
  assert.equal(engine.readState().room, 1, "the arrival point does not retrigger the door");
});
