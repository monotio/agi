import assert from "node:assert/strict";
import { test } from "node:test";
import { ref, shallowRef, type ShallowRef } from "vue";
import { openEditableProject, type EditableProject } from "../src/project/editableProject.ts";
import { prepareLocalProject } from "../src/project/localProject.ts";
import {
  createGuidedActions,
  type GuidedActionsHost,
} from "../src/studio/logic/guided/guidedActions.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";

/**
 * The guided panel's controller over a real EditableProject draft: detached
 * previews, guarded apply, atomic undo, precise refusals — the same contracts
 * the Logic Studio mount relies on, driven through the genuine draft and
 * storage services rather than a fake.
 */

installIndexedDbFixture();
const cache = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => cache.get(key) ?? null,
    setItem: (key: string, value: string) => {
      cache.set(key, value);
    },
    removeItem: (key: string) => cache.delete(key),
  },
});

async function seedProject(name: string, kind: "blank" | "starter" = "starter") {
  const prepared = prepareLocalProject({ title: name, kind });
  await prepared.save();
  return prepared.projectId;
}

interface Harness {
  ws: ShallowRef<EditableProject | undefined>;
  host: GuidedActionsHost;
  /** Draft-change notifications the panel would forward to Logic Studio. */
  resynced: string[][];
  /** Marks a draft edit the controller did not make (manual typing etc.). */
  bump(): void;
}

/** A host over a swappable EditableProject — the LogicStudio seam in miniature. */
function fakeHost(): Harness {
  const ws = shallowRef<EditableProject>();
  const resynced: string[][] = [];
  const revision = ref(0);
  const host: GuidedActionsHost = {
    context() {
      const current = ws.value;
      if (!current) throw new Error("No project is open.");
      return {
        draft: current.draft,
        files: current.storedData().files,
        profileId: current.profileId,
      };
    },
    revisionTick: () => revision.value,
    onDraftChanged: (keys) => {
      resynced.push([...keys]);
      revision.value++;
    },
  };
  return {
    ws: ws as ShallowRef<EditableProject | undefined>,
    host,
    resynced,
    bump: () => revision.value++,
  };
}

function doc(ws: EditableProject, key: string): string {
  const content = ws.draft.capture().read(key)?.content;
  assert.equal(typeof content, "string", `${key} is a text document`);
  return content as string;
}

function editSource(ws: EditableProject, key: string, content: string): void {
  const snapshot = ws.draft.capture();
  ws.draft.edit(key, content, snapshot.version(key));
}

/** A compilable room whose entry is not the recognized ego-setup shape. */
const CUSTOM_ROOM1 = `// Bespoke entry — no recognized ego placement.
if (isset(f5)) {
  assignn(v50, clearing_pic);
  load.pic(v50);
  draw.pic(v50);
  show.pic();
}
return;
`;

test("preparing an action is detached: the draft, words and bindings change nothing", async () => {
  const projectId = await seedProject("guided-detached");
  const harness = fakeHost();
  const guided = createGuidedActions(harness.host);
  harness.ws.value = await openEditableProject(projectId);
  const ws = harness.ws.value;
  const before = ws.draft.capture();
  const wordsBefore = doc(ws, "words");
  const bindingsBefore = doc(ws, "bindings");

  const outcome = guided.prepare("add-room", { title: "Moonlit grove" });
  assert.ok(outcome?.ok, `expected a prepared operation, got ${JSON.stringify(outcome)}`);
  assert.equal(guided.pending.value, outcome);
  assert.equal(guided.refusal.value, null);

  // The preview carries detached contents and exact show-code ranges.
  assert.ok(outcome.affectedKeys.includes("logic:2"));
  assert.ok(outcome.affectedKeys.includes("picture:2"));
  assert.ok(outcome.affectedKeys.includes("world"));
  const logicPreview = outcome.showCode.find((entry) => entry.key === "logic:2");
  assert.ok(logicPreview);
  assert.ok(logicPreview.lines.length > 0);
  assert.ok(logicPreview.text.includes("Moonlit grove"));

  // Nothing was written: same revision, same documents, no new keys.
  const after = ws.draft.capture();
  assert.equal(after.revision, before.revision);
  assert.deepEqual([...after.keys], [...before.keys]);
  assert.equal(ws.draft.dirtyKeys().length, 0);
  assert.equal(doc(ws, "words"), wordsBefore);
  assert.equal(doc(ws, "bindings"), bindingsBefore);
  assert.equal(after.read("logic:2"), undefined);
  assert.equal(harness.resynced.length, 0);
});

test("apply commits one atomic transaction across source and aux; undo and redo restore it", async () => {
  const projectId = await seedProject("guided-atomic");
  const harness = fakeHost();
  const guided = createGuidedActions(harness.host);
  harness.ws.value = await openEditableProject(projectId);
  const ws = harness.ws.value;
  const logicBefore = doc(ws, "logic:1");
  const wordsBefore = doc(ws, "words");

  const outcome = guided.prepare("respond-to-command", {
    room: 1,
    command: "wave",
    response: "You wave at the trees.",
  });
  assert.ok(outcome?.ok);
  assert.equal(guided.apply(), true);

  // One transaction covers the source and the dictionary document.
  const applied = guided.applied.value;
  assert.ok(applied);
  assert.ok(applied.transaction.keys.includes("logic:1"));
  assert.ok(applied.transaction.keys.includes("words"));
  assert.equal(harness.resynced.length, 1);
  const source = doc(ws, "logic:1");
  assert.ok(source.includes('said("wave")'));
  assert.ok(source.includes("You wave at the trees."));
  const words = JSON.parse(doc(ws, "words")) as [string, number][];
  assert.ok(words.some(([word]) => word === "wave"));
  // Existing synonym groups keep their ids.
  assert.ok(words.some(([word, id]) => word === "look" && id === 100));
  assert.ok(ws.draft.dirtyKeys().length > 0);

  // One undo reverts every document of the transaction at once.
  assert.equal(guided.undo(), true);
  assert.equal(doc(ws, "logic:1"), logicBefore);
  assert.equal(doc(ws, "words"), wordsBefore);
  assert.equal(guided.applied.value?.undone, true);
  assert.equal(guided.redo(), true);
  assert.ok(doc(ws, "logic:1").includes('said("wave")'));
  assert.equal(guided.applied.value?.undone, false);
});

test("a stale preview refuses to apply and the newer edit stays authoritative", async () => {
  const projectId = await seedProject("guided-stale");
  const harness = fakeHost();
  const guided = createGuidedActions(harness.host);
  harness.ws.value = await openEditableProject(projectId);
  const ws = harness.ws.value;

  const outcome = guided.prepare("place-hero", { room: 1, x: 30, y: 120 });
  assert.ok(outcome?.ok);
  assert.equal(guided.pendingStale.value, false);

  // Manual typing after the preview makes the consulted snapshot stale.
  const room = doc(ws, "logic:1");
  editSource(ws, "logic:1", `${room}\n// typed meanwhile`);
  harness.bump();
  assert.equal(guided.pendingStale.value, true);

  assert.equal(guided.apply(), false);
  assert.notEqual(guided.notice.value, "");
  // No guided write landed; the manual edit is exactly what the draft holds.
  assert.equal(doc(ws, "logic:1"), `${room}\n// typed meanwhile`);
  assert.deepEqual(ws.draft.dirtyKeys(), ["logic:1"]);
});

test("an outcome cannot apply to another workspace lifetime, and a closed project refuses", async () => {
  const projectId = await seedProject("guided-lifetime");
  const harness = fakeHost();
  const guided = createGuidedActions(harness.host);
  harness.ws.value = await openEditableProject(projectId);
  const first = harness.ws.value;

  const outcome = guided.prepare("add-room", { title: "Held room" });
  assert.ok(outcome?.ok);

  // Reopening the same project is a foreign draft: the old preview must not cross.
  const reopened = await openEditableProject(projectId);
  harness.ws.value = reopened;
  assert.equal(guided.apply(), false);
  assert.notEqual(guided.notice.value, "");
  assert.equal(reopened.draft.capture().read("logic:2"), undefined);
  assert.equal(reopened.draft.dirtyKeys().length, 0);
  // The issuing draft was not written behind the panel's back either.
  assert.equal(first.draft.capture().read("logic:2"), undefined);

  // A workspace with no mounted project refuses instead of throwing.
  harness.ws.value = undefined;
  assert.equal(guided.prepare("place-hero", { room: 1, x: 10, y: 100 }), null);
  assert.equal(guided.notice.value, "No project is open.");
  assert.equal(guided.pending.value, null);
});

test("cancel discards the outcome: no draft, words or binding write", async () => {
  const projectId = await seedProject("guided-cancel");
  const harness = fakeHost();
  const guided = createGuidedActions(harness.host);
  harness.ws.value = await openEditableProject(projectId);
  const ws = harness.ws.value;
  const before = ws.draft.capture();

  const outcome = guided.prepare("respond-to-command", {
    room: 1,
    command: "sing",
    response: "The clearing hums back.",
  });
  assert.ok(outcome?.ok);
  guided.cancel();
  assert.equal(guided.pending.value, null);
  assert.equal(guided.refusal.value, null);
  assert.equal(guided.notice.value, "");

  const after = ws.draft.capture();
  assert.equal(after.revision, before.revision);
  assert.equal(ws.draft.dirtyKeys().length, 0);
  assert.ok(!doc(ws, "logic:1").includes("sing"));
  // The discarded proposal is spent: there is nothing to apply.
  assert.equal(guided.apply(), false);
});

test("custom code refuses precisely with its location; unrelated edits survive untouched", async () => {
  const projectId = await seedProject("guided-custom");
  const harness = fakeHost();
  const guided = createGuidedActions(harness.host);
  harness.ws.value = await openEditableProject(projectId);
  const ws = harness.ws.value;

  // An authored entry block the recognizer cannot read, plus an unrelated
  // dirty document that must stay exactly as typed.
  editSource(ws, "logic:1", CUSTOM_ROOM1);
  const pictureDraft = `# my drawing\nvis 6\nrect 1,1 20,20\nend\n`;
  editSource(ws, "picture:1", pictureDraft);
  harness.bump();

  const outcome = guided.prepare("place-hero", { room: 1, x: 40, y: 120 });
  assert.equal(outcome?.ok, false);
  if (outcome !== null && !outcome.ok) {
    assert.equal(outcome.code, "custom-code");
    assert.equal(outcome.key, "logic:1");
    assert.ok(outcome.message.length > 0);
  }
  assert.equal(guided.refusal.value?.code, "custom-code");
  assert.equal(guided.pending.value, null);

  // The refusal wrote nothing and the unrelated document is untouched.
  assert.equal(doc(ws, "logic:1"), CUSTOM_ROOM1);
  assert.equal(doc(ws, "picture:1"), pictureDraft);
  assert.deepEqual(ws.draft.dirtyKeys(), ["logic:1", "picture:1"]);
  assert.equal(harness.resynced.length, 0);
});

test("connect door writes real Walk rules in both room sources as one proposal", async () => {
  const projectId = await seedProject("guided-door");
  const harness = fakeHost();
  const guided = createGuidedActions(harness.host);
  harness.ws.value = await openEditableProject(projectId);
  const ws = harness.ws.value;

  const added = guided.prepare("add-room", { title: "Forest path", heroView: 0 });
  assert.ok(added?.ok);
  assert.equal(guided.apply(), true);

  const outcome = guided.prepare("connect-door", {
    room: 1,
    destination: 2,
    box: { x1: 120, y1: 60, x2: 150, y2: 90 },
    label: "north edge",
    returnDoor: { box: { x1: 0, y1: 120, x2: 30, y2: 150 }, label: "back to the clearing" },
  });
  assert.ok(outcome?.ok, `expected a prepared door, got ${JSON.stringify(outcome)}`);
  assert.equal(guided.apply(), true);

  const room1 = doc(ws, "logic:1");
  assert.ok(room1.includes("// @rule"), "the exit rule annotates the source");
  assert.ok(room1.includes("posn(o0, 120, 60, 150, 90)"));
  assert.ok(room1.includes("new.room(2)"));
  const room2 = doc(ws, "logic:2");
  assert.ok(room2.includes("new.room(1)"), "the return door lands in room 2");

  // Atomic undo removes both sides at once and frees the sources.
  assert.equal(guided.undo(), true);
  assert.ok(!doc(ws, "logic:1").includes("new.room(2)"));
  assert.ok(!doc(ws, "logic:2").includes("new.room(1)"));
});

test("place hero rewrites the recognized entry position; showCode aims at it", async () => {
  const projectId = await seedProject("guided-hero");
  const harness = fakeHost();
  const guided = createGuidedActions(harness.host);
  harness.ws.value = await openEditableProject(projectId);
  const ws = harness.ws.value;

  const outcome = guided.prepare("place-hero", { room: 1, x: 50, y: 120 });
  assert.ok(outcome?.ok, `expected a prepared placement, got ${JSON.stringify(outcome)}`);
  const preview = outcome.showCode.find((entry) => entry.key === "logic:1");
  assert.ok(preview);
  assert.ok(preview.text.includes("position(o0, 50, 120)"));

  assert.equal(guided.apply(), true);
  const applied = guided.applied.value;
  assert.ok(applied);
  // The recorded ranges are 1-based lines in the applied document.
  const lines = doc(ws, "logic:1").split("\n");
  const target = applied.showCode.find((entry) => entry.key === "logic:1");
  assert.ok(target);
  assert.ok(target.lines.length > 0);
  const shown = target.lines
    .map((range) => lines.slice(range.start - 1, range.end).join("\n"))
    .join("\n");
  assert.ok(shown.includes("position(o0, 50, 120)"));
});

test("play sound threads a cue through the existing command handler", async () => {
  const projectId = await seedProject("guided-sound");
  const harness = fakeHost();
  const guided = createGuidedActions(harness.host);
  harness.ws.value = await openEditableProject(projectId);
  const ws = harness.ws.value;

  const outcome = guided.prepare("play-sound", {
    room: 1,
    sound: 1,
    on: { type: "command", command: "look" },
    completionMessage: "The last note fades.",
  });
  assert.ok(outcome?.ok, `expected a prepared cue, got ${JSON.stringify(outcome)}`);
  assert.equal(guided.apply(), true);

  const source = doc(ws, "logic:1");
  const lookHandler = source.indexOf('said("look")');
  const soundCall = source.indexOf("sound(chime_sound");
  assert.ok(lookHandler >= 0 && soundCall > lookHandler, "the cue lands in the look handler");
  assert.ok(source.includes("The last note fades."));
  // A cue the handler already owns refuses rather than doubling the channel.
  const conflict = guided.prepare("play-sound", {
    room: 1,
    sound: 255,
    on: { type: "command", command: "listen" },
  });
  assert.equal(conflict?.ok, false);
  if (conflict !== null && !conflict.ok) assert.equal(conflict.code, "conflict");
});

test("the controller carries no provider: only the host seam it was given", async () => {
  const projectId = await seedProject("guided-provider-free");
  const harness = fakeHost();
  const guided = createGuidedActions(harness.host);
  harness.ws.value = await openEditableProject(projectId);

  // No ask/session/provider surface exists — prepare runs entirely on the draft.
  for (const member of ["ask", "connect", "provider", "session"])
    assert.equal((guided as unknown as Record<string, unknown>)[member], undefined);
  const outcome = guided.prepare("add-room", { title: "Offline room" });
  assert.ok(outcome?.ok);
  assert.equal(guided.apply(), true);
});
