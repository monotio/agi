/**
 * Preview-plan issuer authority. The handle returned by preparePreviewUpdate
 * is an opaque token: nothing it exposes can reach the staged candidate, and
 * no constructed, cloned, spread, Object.create'd or foreign-engine handle
 * authorizes a commit. Deferred outcomes keep the issuer record alive and
 * re-run every dynamic check on retry; committed and terminal verdicts
 * consume it exactly once. Behavior expectations are asserted on real
 * installed bytes, not on the handle's shape.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openContainer, createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { buildWordsTok } from "../src/logic/words.ts";
import { buildObjectFile } from "../src/authoring/inventory.ts";
import type { GameContainer } from "../src/types.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import { PreviewUpdatePlan } from "../src/runtime/previewAdmission.ts";

const DICT = new Map<string, number>([["look", 100]]);

const LOGIC_0 = `
if (!isset(f200)) {
  set(f200);
  assignn(v0, 1);
  new.room.v(v0);
}
call.v(v0);
return;
`;

const LOGIC_1 = `addn(v200, 1); return;`;
const LOGIC_1_CHANGED = `addn(v200, 2); return;`;

/** One-channel two-tick tone, valid SOUND payload for patchResources. */
const SOUND = new Uint8Array([
  8, 0, 15, 0, 15, 0, 15, 0, 2, 0, 0x23, 0x81, 0x94, 0xff, 0xff, 0xff, 0xff,
]);

class QuietHost implements EngineHost {
  print(): void {}
  displayAt(): void {}
  statusLine(): void {}
  takeInputLine(): string | null {
    return null;
  }
  takeKeys(): number[] {
    return [];
  }
}

function buildGame(): GameContainer {
  const container = createContainer();
  container.putFile("WORDS.TOK", buildWordsTok([{ word: "look", id: 100 }]));
  container.putFile("OBJECT", buildObjectFile([{ name: "key", startingRoom: 1 }]));
  container.putResource("logic", 0, assembleLogic(LOGIC_0, { dictionary: DICT }).payload);
  container.putResource("logic", 1, assembleLogic(LOGIC_1, { dictionary: DICT }).payload);
  return container;
}

function booted(): Engine {
  const engine = new Engine(buildGame(), new QuietHost(), DICT);
  engine.tick();
  return engine;
}

function candidateFiles(engine: Engine, edit: (container: GameContainer) => void) {
  const staged = openContainer(engine.containerFiles);
  edit(staged);
  return new Map(staged.files);
}

/** Every field a client of the public return type can read, as a plain map. */
function exposedFields(plan: PreviewUpdatePlan): Record<string, unknown> {
  const exposed: Record<string, unknown> = {};
  for (const name of Object.getOwnPropertyNames(plan)) {
    exposed[name] = (plan as unknown as Record<string, unknown>)[name];
  }
  for (const name of Object.getOwnPropertyNames(PreviewUpdatePlan.prototype)) {
    exposed[name] = (plan as unknown as Record<string, unknown>)[name];
  }
  return exposed;
}

test("an issued handle exposes no staged state; the validated image is what commits", () => {
  const engine = booted();
  const changed = assembleLogic(LOGIC_1_CHANGED, { dictionary: DICT }).payload;
  const files = candidateFiles(engine, (c) => c.putResource("logic", 1, changed));
  const plan = engine.preparePreviewUpdate({ files });

  // The breach the root review demonstrated: the staged container was a
  // readable field of the public return type and accepted writes after
  // validation. Reach whatever the handle exposes and corrupt it through
  // the same opening.
  const staged = exposedFields(plan)["staged"] as { container?: GameContainer } | null | undefined;
  staged?.container?.putResource("logic", 1, new Uint8Array([0xff]));

  const result = engine.commitPreviewUpdate(plan);
  assert.equal(result.status, "committed");
  assert.deepEqual(
    openContainer(engine.containerFiles).getResource("logic", 1),
    changed,
    "the committed image is the validated one, not post-validation bytes",
  );
  const v200 = engine.vars[200]!;
  engine.tick();
  assert.equal(engine.vars[200], v200 + 2, "the validated candidate is what runs");
});

test("unissued, cloned, spread and field-forged handles cannot authorize a commit", () => {
  const engine = booted();
  const changed = assembleLogic(LOGIC_1_CHANGED, { dictionary: DICT }).payload;
  const files = candidateFiles(engine, (c) => c.putResource("logic", 1, changed));
  const volBefore = engine.containerFiles.get("VOL.0")!.slice();
  const plan = engine.preparePreviewUpdate({ files });
  const exposed = exposedFields(plan);

  // A prototype shell grafted with every reachable field of the real plan.
  const clone = Object.assign(Object.create(PreviewUpdatePlan.prototype), exposed);
  assert.equal(
    engine.commitPreviewUpdate(clone).status,
    "refused",
    "a cloned handle carrying copied issuer fields does not commit",
  );

  // A subclass instance with the same grafted fields.
  class ForgedPlan extends PreviewUpdatePlan {}
  const subclassed = Object.assign(new ForgedPlan(), exposed);
  assert.equal(engine.commitPreviewUpdate(subclassed).status, "refused");

  // Fresh construction, a bare prototype shell and a spread look-alike.
  assert.equal(engine.commitPreviewUpdate(new PreviewUpdatePlan()).status, "refused");
  assert.equal(
    engine.commitPreviewUpdate(Object.create(PreviewUpdatePlan.prototype)).status,
    "refused",
  );
  assert.equal(
    engine.commitPreviewUpdate({ ...plan } as unknown as PreviewUpdatePlan).status,
    "refused",
    "a spread of the handle's fields is not the handle",
  );

  // Caller-supplied issuer state, including a hand-built staged image.
  const malicious = openContainer(files);
  malicious.putResource("logic", 1, new Uint8Array([0xff]));
  const callerBuilt = Object.assign(Object.create(PreviewUpdatePlan.prototype), {
    owner: engine,
    generation: 0,
    consumed: false,
    terminal: null,
    staged: {
      container: malicious,
      changed: [],
      logicParses: new Map(),
      viewParses: new Map(),
      dictionary: null,
      inventory: null,
      composition: (exposed["staged"] as { composition?: unknown } | null | undefined)?.composition,
      compositionAffected: false,
      surface: null,
      compositionBlocked: null,
    },
  });
  assert.equal(
    engine.commitPreviewUpdate(callerBuilt).status,
    "refused",
    "caller-supplied fields never make an issued plan",
  );
  assert.deepEqual(
    engine.containerFiles.get("VOL.0"),
    volBefore,
    "no forged commit touched the installed image",
  );

  // The real plan is unaffected by the forgeries and still commits.
  assert.equal(engine.commitPreviewUpdate(plan).status, "committed");
  assert.deepEqual(openContainer(engine.containerFiles).getResource("logic", 1), changed);
});

test("a deferred commit keeps the plan and revalidates; release then retry commits", () => {
  const engine = booted();
  const changed = assembleLogic(LOGIC_1_CHANGED, { dictionary: DICT }).payload;
  const files = candidateFiles(engine, (c) => c.putResource("logic", 1, changed));
  const plan = engine.preparePreviewUpdate({ files });

  engine.setExecutionObserver(() => {});
  assert.equal(engine.commitPreviewUpdate(plan).status, "deferred");
  assert.equal(
    engine.commitPreviewUpdate(plan).status,
    "deferred",
    "a busy boundary does not consume the plan",
  );
  engine.setExecutionObserver(null);
  assert.equal(engine.commitPreviewUpdate(plan).status, "committed");
  assert.deepEqual(openContainer(engine.containerFiles).getResource("logic", 1), changed);
  assert.equal(
    engine.commitPreviewUpdate(plan).status,
    "refused",
    "a committed plan cannot commit again",
  );
});

test("a deferred plan that goes stale refuses terminally and is consumed", () => {
  const engine = booted();
  const changed = assembleLogic(LOGIC_1_CHANGED, { dictionary: DICT }).payload;
  const files = candidateFiles(engine, (c) => c.putResource("logic", 1, changed));
  const plan = engine.preparePreviewUpdate({ files });

  engine.setExecutionObserver(() => {});
  assert.equal(engine.commitPreviewUpdate(plan).status, "deferred");
  // The installed image moves between preparation and commit.
  engine.patchResources([{ kind: "sound", num: 9, payload: SOUND }]);
  engine.setExecutionObserver(null);

  const stale = engine.commitPreviewUpdate(plan);
  assert.equal(stale.status, "refused");
  assert.match(stale.reason ?? "", /stale/);
  const again = engine.commitPreviewUpdate(plan);
  assert.equal(again.status, "refused");
  assert.match(again.reason ?? "", /consumed/, "the stale refusal was terminal");
  assert.deepEqual(
    openContainer(engine.containerFiles).getResource("logic", 1),
    assembleLogic(LOGIC_1, { dictionary: DICT }).payload,
    "the stale candidate never installed",
  );
});

test("a terminal preparation verdict consumes the plan exactly once", () => {
  const engine = booted();
  const files = candidateFiles(engine, (c) => c.putResource("logic", 1, new Uint8Array([1, 2, 3])));
  const plan = engine.preparePreviewUpdate({ files });
  const first = engine.commitPreviewUpdate(plan);
  assert.equal(first.status, "refused");
  const second = engine.commitPreviewUpdate(plan);
  assert.equal(second.status, "refused");
  assert.match(second.reason ?? "", /consumed/);
});

test("an unchanged candidate settles once", () => {
  const engine = booted();
  const plan = engine.preparePreviewUpdate({ files: engine.containerFiles });
  assert.equal(engine.commitPreviewUpdate(plan).status, "unchanged");
  const second = engine.commitPreviewUpdate(plan);
  assert.equal(second.status, "refused");
  assert.match(second.reason ?? "", /consumed/);
});

test("a plan issued by one engine is refused by another and stays live for its issuer", () => {
  const first = booted();
  const second = booted();
  const changed = assembleLogic(LOGIC_1_CHANGED, { dictionary: DICT }).payload;
  const files = candidateFiles(first, (c) => c.putResource("logic", 1, changed));
  const plan = first.preparePreviewUpdate({ files });

  const foreign = second.commitPreviewUpdate(plan);
  assert.equal(foreign.status, "refused");
  assert.equal(second.patchGeneration, 0, "the foreign attempt installed nothing");
  assert.equal(first.commitPreviewUpdate(plan).status, "committed");
});

test("caller-side candidate byte mutation after preparation cannot reach the commit", () => {
  const engine = booted();
  const changed = assembleLogic(LOGIC_1_CHANGED, { dictionary: DICT }).payload;
  const files = candidateFiles(engine, (c) => c.putResource("logic", 1, changed));
  const plan = engine.preparePreviewUpdate({ files });

  // The caller rewrites and drops entries of the map it still owns.
  files.get("VOL.0")![0] = 0xee;
  files.set("VOL.0", new Uint8Array([0xee]));
  files.delete("WORDS.TOK");
  assert.equal(engine.commitPreviewUpdate(plan).status, "committed");
  const installed = openContainer(engine.containerFiles);
  assert.deepEqual(installed.getResource("logic", 1), changed);
  assert.ok(engine.containerFiles.has("WORDS.TOK"), "the deleted file survived staging");
});
