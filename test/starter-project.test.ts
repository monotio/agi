import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openContainer } from "../src/container/container.ts";
import { compileProjectLogic } from "../src/authoring/projectLogic.ts";
import {
  createStarterProject,
  STARTER_EGO_VIEW_SOURCE,
  type StarterKind,
} from "../src/authoring/starterProject.ts";
import { compilePictureSource } from "../src/picture/source.ts";
import { parseWordsTok } from "../src/logic/words.ts";
import { decodeInventoryFile } from "../src/runtime/inventoryFile.ts";
import { Engine, HostWait, type EngineHost } from "../src/runtime/engine.ts";
import { PROFILES } from "../src/runtime/profile.ts";
import { buildSound } from "../src/sound/build.ts";
import { compileSoundDocumentSource } from "../src/sound/source.ts";
import type { SoundDocumentEnvelope } from "../src/sound/document.ts";
import { buildView, parseView } from "../src/view/view.ts";
import { compileViewSource } from "../src/view/viewSource.ts";
import type { GameContainer, ResourceKind } from "../src/types.ts";

const PROFILE = PROFILES["2.936"]!;
const KINDS: readonly StarterKind[] = ["blank", "starter"];

class StarterHost implements EngineHost {
  keys: number[] = [];
  lines: string[] = [];
  sounds: number[] = [];
  waitKey(): number {
    throw new HostWait();
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
  soundOutput(): void {}
  saved: Uint8Array[] = [];
  restoreImage: Uint8Array | null = null;
  saveGame(bytes: Uint8Array): boolean {
    this.saved.push(bytes);
    return true;
  }
  restoreGame(): Uint8Array | null {
    return this.restoreImage;
  }
  print(): void {}
  displayAt(): void {}
  statusLine(): void {}
}

function boot(kind: StarterKind) {
  const project = createStarterProject(kind);
  const container = openContainer(project.files());
  const host = new StarterHost();
  const engine = new Engine(container, host, project.sources.words, { profile: PROFILE });
  return { project, container, engine, host };
}

function tick(engine: Engine, n = 1): void {
  for (let i = 0; i < n; i++) engine.tick();
}

function surfaceRows(engine: Engine): string[] {
  const rows: string[] = [];
  for (let r = 0; r < 25; r++) rows.push(engine.textRow(r));
  return rows;
}

function resourceNumbers(container: GameContainer, kind: ResourceKind): number[] {
  const out: number[] = [];
  for (let num = 0; num < 256; num++) if (container.getResource(kind, num)) out.push(num);
  return out;
}

// ---------- determinism and ownership ----------

describe("starter project determinism and ownership", () => {
  for (const kind of KINDS) {
    test(`${kind}: identical content on every call, independent buffers`, () => {
      const a = createStarterProject(kind);
      const b = createStarterProject(kind);
      const fa = a.files();
      const fb = b.files();
      assert.deepEqual([...fa.keys()].sort(), [...fb.keys()].sort());
      for (const [name, bytes] of fa) {
        assert.deepEqual([...bytes], [...fb.get(name)!], `${name} bytes differ`);
        assert.notEqual(bytes, fb.get(name), `${name} must not share a buffer`);
      }
      assert.deepEqual(a.seed, b.seed, "seed provenance is deterministic");
      assert.equal(a.profileId, "2.936");
      assert.equal(b.profileId, "2.936");
    });
  }

  test("mutating returned files never reaches later calls or the seed", () => {
    const project = createStarterProject("starter");
    const first = project.files();
    const vol = first.get("VOL.0")!;
    const original = vol[0]!;
    vol[0] = original ^ 0xff;
    const second = project.files();
    assert.equal(second.get("VOL.0")![0], original);
    assert.ok(second.get("OBJECT"), "OBJECT file still present");
    const fresh = createStarterProject("starter");
    assert.equal(fresh.files().get("VOL.0")![0], original);
    assert.equal(project.seed.digest, fresh.seed.digest);
  });

  test("seed digests differ between kinds and stay stable per kind", () => {
    const blank = createStarterProject("blank");
    const starter = createStarterProject("starter");
    assert.notEqual(blank.seed.digest, starter.seed.digest);
    assert.match(blank.seed.digest, /^[0-9a-f]{64}$/);
    assert.equal(blank.seed.templateRevision, 1);
    assert.equal(starter.seed.templateRevision, 2);
    assert.notEqual(blank.seed.templateId, starter.seed.templateId);
  });
});

// ---------- supplied sources reproduce the stored bytes ----------

describe("starter project source fidelity", () => {
  for (const kind of KINDS) {
    test(`${kind}: every authored source recompiles exactly to its resource`, () => {
      const project = createStarterProject(kind);
      const container = openContainer(project.files());
      const bindings = project.bindings;
      for (const [num, source] of project.sources.logics) {
        const compiled = compileProjectLogic(source, {
          profile: PROFILE,
          dictionary: project.sources.words,
          bindings,
        }).assembly.payload;
        const stored = container.getResource("logic", num);
        assert.ok(stored, `LOGIC ${num} missing`);
        assert.deepEqual([...compiled], [...stored], `LOGIC ${num} source does not recompile`);
      }
      for (const [num, source] of project.sources.pictures) {
        const compiled = compilePictureSource(source, { profile: PROFILE }).bytes;
        const stored = container.getResource("picture", num);
        assert.ok(stored, `PIC ${num} missing`);
        assert.deepEqual([...compiled], [...stored], `PIC ${num} source does not recompile`);
      }
      for (const [num, input] of project.sources.views) {
        const compiled = buildView(input, PROFILE);
        const stored = container.getResource("view", num);
        assert.ok(stored, `VIEW ${num} missing`);
        assert.deepEqual([...compiled], [...stored], `VIEW ${num} does not rebuild`);
      }
      for (const [num, body] of project.sources.sounds) {
        const compiled = Array.isArray(body)
          ? buildSound(body)
          : compileSoundDocumentSource(body, PROFILE.id);
        const stored = container.getResource("sound", num);
        assert.ok(stored, `SOUND ${num} missing`);
        assert.deepEqual([...compiled], [...stored], `SOUND ${num} does not rebuild`);
      }
      // WORDS.TOK and OBJECT round-trip through the real parsers.
      const wordsFile = project.files().get("WORDS.TOK");
      assert.ok(wordsFile, "WORDS.TOK missing");
      const decoded = new Map(parseWordsTok(wordsFile).map(({ word, id }) => [word, id]));
      assert.deepEqual(decoded, new Map(project.sources.words));
      const objectFile = project.files().get("OBJECT");
      assert.ok(objectFile, "OBJECT missing");
      const table = decodeInventoryFile(objectFile, PROFILE);
      assert.equal(
        table[0]! | (table[1]! << 8),
        project.sources.objects.length * PROFILE.inventoryEntryBytes,
      );
    });
  }
});

// ---------- blank ----------

describe("blank starter project", () => {
  test("carries only the minimal editable resources — no hero, menu, death or story", () => {
    const project = createStarterProject("blank");
    const container = openContainer(project.files());
    assert.deepEqual(resourceNumbers(container, "logic"), [0, 1]);
    assert.deepEqual(resourceNumbers(container, "picture"), [1]);
    assert.deepEqual(resourceNumbers(container, "view"), []);
    assert.deepEqual(resourceNumbers(container, "sound"), []);
    assert.equal(project.sources.views.size, 0);
    assert.equal(project.sources.sounds.size, 0);
    assert.equal(project.sources.words.size, 0);
    assert.equal(project.sources.objects.length, 0);
    assert.equal(project.sources.logics.get(0)!.includes("set.menu"), false);
    assert.equal(project.sources.logics.get(0)!.includes("call"), true);
  });

  test("boots into room 1 with no actor and keeps running", () => {
    const { engine } = boot("blank");
    tick(engine, 6);
    const state = engine.readState();
    assert.equal(state.room, 1);
    assert.equal(state.terminated, false);
    assert.deepEqual(engine.readObjects(), [], "blank seed has no screen objects");
    assert.deepEqual(engine.readMenuState().headings, [], "blank seed builds no menu");
    tick(engine, 10);
    assert.equal(engine.readState().terminated, false);
  });
});

// ---------- starter ----------

describe("starter starter project", () => {
  test("boots into room 1 showing a visible animated ego", () => {
    const { engine } = boot("starter");
    tick(engine, 6);
    assert.equal(engine.readState().room, 1);
    const objects = engine.readObjects();
    const ego = objects.find((o) => o.num === 0);
    assert.ok(ego, "ego is an active screen object");
    assert.equal(ego.view, 1);
    assert.ok(ego.width >= 6 && ego.height >= 28, "the hero is clearly visible");
    assert.equal(ego.cycling, true, "the hero cycles while walking");
  });

  test("the ego view is an original four-direction animated figure", () => {
    const project = createStarterProject("starter");
    assert.deepEqual(
      project.sources.views.get(1),
      compileViewSource(STARTER_EGO_VIEW_SOURCE),
      "the stored view definition is the compiled authored source",
    );
    const container = openContainer(project.files());
    const payload = container.getResource("view", 1)!;
    const view = parseView(payload, PROFILE);
    assert.equal(view.loops.length, 4, "right/left/front/back loops");
    for (const [index, loop] of view.loops.entries()) {
      assert.ok(loop.cels.length >= 2, `loop ${index} animates`);
      const first = loop.cels[0]!;
      const differs = loop.cels.some(
        (cel) =>
          cel.width !== first.width ||
          cel.height !== first.height ||
          cel.pixels.some((px, i) => px !== first.pixels[i]),
      );
      assert.ok(differs, `loop ${index} has visibly different cels`);
    }
  });

  test("arrow keys walk ego and direction selects the right loop", () => {
    const { engine, host } = boot("starter");
    tick(engine, 6);
    const start = engine.readObjects().find((o) => o.num === 0)!;
    host.keys.push(0x4d00); // right arrow
    tick(engine, 12);
    const walking = engine.readObjects().find((o) => o.num === 0)!;
    assert.ok(walking.x > start.x, `ego moved right (${start.x} -> ${walking.x})`);
    assert.equal(walking.loop, 0, "loop 0 faces right");
    host.keys.push(0x4b00); // left arrow turns around
    tick(engine, 8);
    const back = engine.readObjects().find((o) => o.num === 0)!;
    assert.equal(back.loop, 1, "loop 1 faces left");
    assert.ok(back.x < walking.x, "ego moved back left");
    host.keys.push(0x4800); // up arrow
    tick(engine, 8);
    const up = engine.readObjects().find((o) => o.num === 0)!;
    assert.equal(up.loop, 3, "loop 3 faces away");
    assert.ok(up.y < back.y, "ego moved up");
  });

  test("look answers exactly once, with no parser fallback", () => {
    const { engine, host } = boot("starter");
    tick(engine, 6);
    host.lines.push("look");
    tick(engine, 3);
    const text = surfaceRows(engine).join("\n");
    assert.match(text, /sunny clearing/);
    assert.equal((text.match(/sunny clearing/g) ?? []).length, 1);
    assert.doesNotMatch(text, /I don't understand/);
    assert.doesNotMatch(text, /I don't know/);
  });

  test("help answers exactly once, with no parser fallback", () => {
    const { engine, host } = boot("starter");
    tick(engine, 6);
    host.lines.push("help");
    tick(engine, 3);
    const text = surfaceRows(engine).join("\n");
    assert.match(text, /arrow keys walk/i);
    assert.equal((text.match(/arrow keys walk/gi) ?? []).length, 1);
    assert.doesNotMatch(text, /I don't understand/);
    assert.doesNotMatch(text, /I don't know/);
  });

  test("listen plays the seeded cue and answers once, with no parser fallback", () => {
    const { engine, host } = boot("starter");
    tick(engine, 6);
    host.lines.push("listen");
    tick(engine, 3);
    const text = surfaceRows(engine).join("\n");
    assert.match(text, /meadowlark/i);
    assert.doesNotMatch(text, /I don't understand/);
    assert.doesNotMatch(text, /I don't know/);
    assert.deepEqual(host.sounds, [1], "the meadowlark cue is SOUND 1");
  });

  test("the listen cue is an editable tagged sound document over its native bytes", () => {
    const project = createStarterProject("starter");
    const body = project.sources.sounds.get(1)!;
    assert.ok(!Array.isArray(body) && typeof body === "object", "SOUND 1 is a tagged document");
    const envelope = body as SoundDocumentEnvelope;
    assert.equal(envelope.format, "agi.sound-document");
    assert.equal(envelope.version, 1);
    assert.equal(envelope.profileId, "2.936");
    const container = openContainer(project.files());
    const native = container.getResource("sound", 1);
    assert.ok(native, "SOUND 1 exists in the container");
    assert.deepEqual([...compileSoundDocumentSource(body, "2.936")], [...native]);
  });

  test("hear shares the listen word group", () => {
    const project = createStarterProject("starter");
    const listen = project.sources.words.get("listen");
    assert.ok(listen, "listen is in the seeded dictionary");
    assert.equal(project.sources.words.get("hear"), listen, "hear is a listen synonym");
  });

  test("ESC opens the seeded menu bar; a saved image restores past a death", () => {
    const { engine, host } = boot("starter");
    tick(engine, 6);
    host.keys.push(0x1b);
    tick(engine, 2);
    assert.equal(engine.modalKind, "menu");
    assert.deepEqual(
      engine.readMenuState().headings.map((h) => h.title),
      ["File", "Speed", "Sound", "Help"],
    );
    host.keys.push(0x1b); // leave the menu
    tick(engine, 2);
    assert.equal(engine.modalKind, null);
    const image = engine.serialize();
    host.lines.push("die");
    tick(engine, 2);
    host.keys.push(0x0d);
    tick(engine, 3);
    assert.equal(engine.readState().flags[202], 1);
    host.restoreImage = image;
    host.keys.push(0x4100); // F7
    tick(engine, 3);
    assert.equal(engine.readState().flags[202], 0, "restore revived the player");
  });

  test("the authored die command prints the room line then enters the shared death", () => {
    const { engine, host } = boot("starter");
    tick(engine, 6);
    host.lines.push("die");
    tick(engine, 2);
    // The room's print window is modal; ENTER drains it and the resumed pass
    // runs call(255)'s init.
    host.keys.push(0x0d);
    tick(engine, 3);
    assert.equal(engine.readState().flags[202], 1, "the death logic marked the player dead");
    assert.deepEqual(host.sounds, [255], "the shared death sound plays once");
    const rows = surfaceRows(engine);
    assert.match(rows[10]!, /You have died/);
    assert.match(rows[12]!, /> Restore/);
    assert.equal(engine.readState().inputEnabled, false, "parser input stays off while dead");
  });
});

test("editing a returned binding cannot change future Starter projects", () => {
  const project = createStarterProject("starter");
  const binding = project.bindings["ego_view"]! as { num: number };
  const original = binding.num;
  try {
    binding.num = 17;
    const fresh = createStarterProject("starter");
    assert.equal(fresh.bindings["ego_view"]!.num, original);
    assert.equal(fresh.seed.digest, project.seed.digest);
  } finally {
    binding.num = original;
  }
});

test("editing returned sound notes cannot change future Starter projects", () => {
  const project = createStarterProject("starter");
  const body = project.sources.sounds.get(255)!;
  assert.ok(Array.isArray(body), "SOUND 255 stays a plain editable track list");
  const note = body[0]!.notes[0]!;
  const original = note.duration;
  try {
    note.duration = original + 1;
    const fresh = createStarterProject("starter");
    const freshBody = fresh.sources.sounds.get(255)!;
    assert.ok(Array.isArray(freshBody));
    assert.equal(freshBody[0]!.notes[0]!.duration, original);
    assert.equal(fresh.seed.digest, project.seed.digest);
  } finally {
    note.duration = original;
  }
});

test("the clearing has a sky, sun, solid tree and the path described by look", () => {
  const { engine } = boot("starter");
  tick(engine, 6);
  const pixels = engine.getFrame().visual;
  const at = (x: number, y: number) => pixels[y * 160 + x];
  assert.equal(at(5, 20), 9, "blue sky");
  assert.equal(at(135, 18), 14, "yellow sun");
  assert.equal(at(25, 40), 10, "light green leaves");
  assert.equal(at(31, 80), 6, "solid brown trunk");
  assert.equal(at(76, 80), 6, "path leads north");
  assert.equal(at(5, 150), 2, "grass left of path");
  assert.equal(at(140, 150), 2, "grass right of path");
});
