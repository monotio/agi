import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createAgentSessionState,
  type AgentSessionState,
  type AgentToolResult,
} from "../src/agent/agentState.ts";
import {
  AGENT_TOOLS,
  ASK_TOOLS,
  AUTHORING_TOOL_NAMES,
  executeAgentTool,
  executeAgentToolAsync,
  STUDIO_ASSIST_TASK_TOOLS,
} from "../src/agent/tools.ts";
import {
  createStudioAssist,
  STUDIO_ASSIST_TOOLS,
  type StudioAssist,
} from "../src/agent/studioAssistTools.ts";
import {
  draftRevision,
  pictureAssistScope,
  viewAssistScope,
  type AssistDraft,
} from "../src/studio/assistScope.ts";
import { compileEditDocument } from "../src/studio/editValidation.ts";
import { parsePictureDocument } from "../src/studio/pictureDocument.ts";
import { openSprite } from "../src/studio/sprite/spriteDocument.ts";
import { parseView } from "../src/view/view.ts";
import { DEFAULT_V2_PROFILE } from "../src/runtime/profile.ts";
import { AFTER_BRIDGE, BRIDGE_SOURCE, DOT_EGO, ROBOT_VIEW } from "./studioAssistFixtures.ts";

/** Width and height from a PNG's IHDR. */
function pngSize(png: Uint8Array): [number, number] {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return [view.getUint32(16), view.getUint32(20)];
}

function session(): AgentSessionState {
  const state = createAgentSessionState();
  state.container.putResource("view", 0, DOT_EGO);
  return state;
}

function bridgeAssist(
  draft: () => AssistDraft = () => ({ kind: "picture", source: BRIDGE_SOURCE }),
) {
  const compiled = compileEditDocument(
    parsePictureDocument(BRIDGE_SOURCE).document,
    DEFAULT_V2_PROFILE,
  );
  return createStudioAssist({
    scope: pictureAssistScope({
      num: 1,
      compiled,
      targetIds: ["bridge"],
      lens: "walk",
    }),
    draft,
    lens: "walk",
  });
}

const loop1 = [
  { loop: 1, cel: 0 },
  { loop: 1, cel: 1 },
];

function robotAssist() {
  const document = openSprite(ROBOT_VIEW, DEFAULT_V2_PROFILE);
  return createStudioAssist({
    scope: viewAssistScope({ num: 2, document, targetCels: loop1 }),
    draft: () => ({ kind: "view", payload: ROBOT_VIEW }),
  });
}

const fields = (list: "pictureOps" | "spriteOps") => {
  const propose = STUDIO_ASSIST_TOOLS.find((tool) => tool.name === "propose_edit")!;
  return (propose.parameters.properties[list] as { items: { required: string[] } }).items.required;
};
const op = (list: "pictureOps" | "spriteOps", given: Record<string, unknown>) =>
  Object.fromEntries(fields(list).map((field) => [field, given[field] ?? null]));

const crossing = op("pictureOps", {
  type: "insertShape",
  atLine: AFTER_BRIDGE,
  shape: {
    kind: "rect",
    color: null,
    priority: 3,
    filled: true,
    x1: 60,
    y1: 120,
    x2: 99,
    y2: 139,
    points: null,
  },
  id: "crossing",
  label: "Crossing",
  kind: "walk",
});

function run(
  state: AgentSessionState,
  assist: StudioAssist,
  name: string,
  args: Record<string, unknown>,
) {
  return executeAgentToolAsync(state, name, args, {
    allowedTools: STUDIO_ASSIST_TASK_TOOLS,
    studio: assist,
  });
}

function propose(
  state: AgentSessionState,
  assist: StudioAssist,
  ops: Record<string, unknown>[],
  base = draftRevision(assist.focus.draft()),
): Promise<AgentToolResult> {
  const picture = assist.focus.scope.kind === "picture";
  return run(state, assist, "propose_edit", {
    baseRevision: base,
    summary: "A test change.",
    pictureOps: picture ? ops : null,
    spriteOps: picture ? null : ops,
  });
}

test("the two Studio tools are catalogued with strict schemas", () => {
  for (const name of ["read_edit_context", "propose_edit"]) {
    const tool = AGENT_TOOLS.find((candidate) => candidate.name === name)!;
    assert.ok(tool, name);
    assert.deepEqual(tool.parameters.required, Object.keys(tool.parameters.properties));
  }
  for (const list of ["pictureOps", "spriteOps"] as const) {
    const propose = AGENT_TOOLS.find((tool) => tool.name === "propose_edit")!;
    const items = (
      propose.parameters.properties[list] as {
        items: { properties: object; required: string[]; additionalProperties: boolean };
      }
    ).items;
    assert.deepEqual(items.required, Object.keys(items.properties), list);
    assert.equal(items.additionalProperties, false);
  }
});

test("outside a Studio assist task the Studio tools are denied", async () => {
  const state = session();
  const args = { images: null };
  const refused = /only available in a Studio assist task/;
  assert.match(executeAgentTool(state, "read_edit_context", args).error ?? "", refused);
  assert.match(
    (await executeAgentToolAsync(state, "read_edit_context", args)).error ?? "",
    refused,
  );
  // Genesis, room authoring and Remix: not in the phase's availability.
  assert.ok(!AUTHORING_TOOL_NAMES.includes("propose_edit"));
  const phase = await executeAgentToolAsync(
    state,
    "propose_edit",
    {},
    {
      allowedTools: AUTHORING_TOOL_NAMES,
      studio: bridgeAssist(),
    },
  );
  assert.match(phase.error ?? "", /not available in this phase/);
  // Ask: read-only, and the Studio tools are not among its reads.
  assert.ok(!ASK_TOOLS.includes("read_edit_context"));
  const ask = await executeAgentToolAsync(state, "read_edit_context", args, { readOnly: true });
  assert.match(ask.error ?? "", /Ask mode is read-only/);
  // Inside the task, writers stay denied.
  const writer = await run(state, bridgeAssist(), "write_words", { words: ["x"], groups: null });
  assert.match(writer.error ?? "", /not available in this phase/);
});

test("read_edit_context is bounded to the selection and its neighbours", async () => {
  const state = session();
  const assist = bridgeAssist();
  const result = await run(state, assist, "read_edit_context", { images: true });
  assert.equal(result.success, true, result.error ?? "");
  const details = result.details!;
  assert.equal(details["baseRevision"], draftRevision({ kind: "picture", source: BRIDGE_SOURCE }));
  assert.deepEqual(details["lockedPlanes"], ["visual"]);
  assert.deepEqual(details["selectionArea"], {
    cells: 960,
    bbox: { x0: 60, y0: 118, x1: 99, y1: 141 },
  });
  // Rows 118, 119, 140, 141 of sky under the bridge: 4 x 40 baseline cells.
  // Baselines from the horizon (36) down: rows 37..167. Only the river's
  // barrier outline blocks: rows 120 and 139 (2 x 160) and its side columns
  // on rows 121..138 (2 x 18); the water inside is walkable. Under the
  // bridge that leaves 960 - 80 bank cells.
  assert.deepEqual(details["walkable"], { inSelection: 880, overall: 131 * 160 - 356 });
  assert.deepEqual(details["depthValuesLocked"], true);
  assert.deepEqual(details["controls"], [
    { value: 0, cells: 80, bbox: { x0: 60, y0: 120, x1: 99, y1: 139 } },
    { value: 3, cells: 720, bbox: { x0: 60, y0: 121, x1: 99, y1: 138 } },
  ]);
  const message = result.message ?? "";
  assert.match(message, /-- selected 'bridge', lines 12-/);
  assert.match(message, /-- neighbour 'river', lines 5-11/);
  assert.doesNotMatch(message, /'sky'/, "the sky is not a neighbour of the bridge");
  // Crop: the bridge's 40x24 cells plus 4 on each side, 48x32, enlarged 3x;
  // pictureComparisonPng draws three panels of 2x-wide cells.
  assert.deepEqual(
    result.images!.map((image) => pngSize(image.png)),
    [
      [48 * 3 * 2 * 3, 32 * 3],
      [320, 168],
    ],
  );
});

test("propose_edit works on a detached copy and returns a before | after | diff candidate", async () => {
  const state = session();
  const files = [...state.getFiles()].map(([name, bytes]) => [name, [...bytes]]);
  let reads = 0;
  const live = BRIDGE_SOURCE;
  const assist = bridgeAssist(() => {
    reads++;
    return { kind: "picture", source: live };
  });
  const result = await propose(state, assist, [crossing]);
  assert.equal(result.success, true, result.error ?? "");
  assert.ok(reads > 0, "the draft is read at call time");
  assert.equal(live, BRIDGE_SOURCE);
  assert.deepEqual(
    [...state.getFiles()].map(([name, bytes]) => [name, [...bytes]]),
    files,
    "the session's resources are untouched",
  );
  assert.deepEqual(pngSize(result.images![0]!.png), [960, 336]);
  assert.equal(result.details!["candidateId"], "c1");
  assert.deepEqual(result.details!["walkable"], { before: 880, after: 960 });
  assert.deepEqual(result.details!["changed"], {
    visual: { cells: 0, bbox: null },
    priority: { cells: 80, bbox: { x0: 60, y0: 120, x1: 99, y1: 139 } },
  });
  const candidate = assist.candidate!;
  assert.equal(candidate.kind, "picture");
  assert.equal(candidate.baseRevision, draftRevision({ kind: "picture", source: BRIDGE_SOURCE }));
  assert.match(
    candidate.kind === "picture" ? candidate.draft.source : "",
    /# @item crossing "Crossing" walk/,
  );
  // The creator sees the same estimate on the candidate card.
  assert.deepEqual(candidate.kind === "picture" && candidate.walkable, { before: 880, after: 960 });
});

test("propose_edit takes insertPoint: a new vertex on the selected item's line", async () => {
  const propose_ = STUDIO_ASSIST_TOOLS.find((tool) => tool.name === "propose_edit")!;
  const types = (
    propose_.parameters.properties["pictureOps"] as {
      items: { properties: { type: { enum: string[] } } };
    }
  ).items.properties.type.enum;
  assert.ok(types.includes("insertPoint"));
  assert.match(propose_.description, /insertPoint itemId line pointIndex x y/);
  // The art lens, so the bridge's colour may change; its first row, line 15,
  // 60,118-99,118, dips to 80,119 in the middle.
  const compiled = compileEditDocument(
    parsePictureDocument(BRIDGE_SOURCE).document,
    DEFAULT_V2_PROFILE,
  );
  const assist = createStudioAssist({
    scope: pictureAssistScope({ num: 1, compiled, targetIds: ["bridge"], lens: "art" }),
    draft: () => ({ kind: "picture", source: BRIDGE_SOURCE }),
    lens: "art",
  });
  const result = await propose(session(), assist, [
    op("pictureOps", {
      type: "insertPoint",
      itemId: "bridge",
      line: 15,
      pointIndex: 1,
      x: 80,
      y: 119,
    }),
  ]);
  assert.equal(result.success, true, result.error ?? "");
  const candidate = assist.candidate!;
  const source = candidate.kind === "picture" ? candidate.draft.source : "";
  assert.equal(source.split("\n")[14], "line 60,118 80,119 99,118");
  assert.match(source, /# @item bridge "Bridge" art/, "the item keeps its id");
});

test("a fill spilling out of the selection is refused with what to do about it", async () => {
  // A water fill seeded in the floor above the river floods rows 0..119
  // (19,200 cells); the bridge's area holds 80 of them (x 60..99, rows 118
  // and 119), so 19,120 spill.
  const state = session();
  const assist = bridgeAssist();
  const refused = await propose(state, assist, [
    op("pictureOps", {
      type: "insertFill",
      atLine: AFTER_BRIDGE,
      x: 80,
      y: 60,
      priority: 3,
      id: "puddle",
      label: "Puddle",
    }),
  ]);
  assert.match(
    refused.error ?? "",
    /^Refused; nothing was proposed: the Puddle fill would spill outside the selection \(19,120 cells\); close the outline or keep the fill seed inside it\. Keep every fill inside a closed outline within the selection\./,
  );
  assert.deepEqual(
    (refused.details!["violations"] as { constraint: string }[]).map((v) => v.constraint),
    ["fill-spill"],
  );
});

test("art under the lock is refused in plain words, and a retry replaces nothing until it passes", async () => {
  const state = session();
  const assist = bridgeAssist();
  const art = op("pictureOps", {
    type: "setItemColor",
    itemId: "bridge",
    plane: "visual",
    value: 8,
  });
  const refused = await propose(state, assist, [art]);
  assert.equal(refused.success, false);
  assert.match(
    refused.error ?? "",
    /^Refused; nothing was proposed: the art \(visual plane\) is locked, but 960 cells at 60,118\.\.99,141 would change\. Leave the locked plane exactly as it is\. There is no candidate yet\. 3 proposals left/,
  );
  assert.equal(assist.candidate, null);
  const retry = await propose(state, assist, [crossing]);
  assert.equal(retry.success, true, retry.error ?? "");
  assert.equal(retry.details?.["candidateId"], "c2");
  assert.deepEqual([assist.proposals, assist.refusals], [2, 1]);
});

test("depth painted in the Walk lens is refused at proposal time, so the model can retry", async () => {
  const state = session();
  const assist = bridgeAssist();
  const floor = { ...crossing, shape: { ...(crossing["shape"] as object), priority: 4 } };
  const refused = await propose(state, assist, [floor]);
  assert.match(
    refused.error ?? "",
    /^Refused; nothing was proposed: depth values 4–15 are locked in the Walk lens, but 800 cells at 60,120\.\.99,139 would change\. In the Walk lens paint only control values 0–3/,
  );
  assert.equal(assist.candidate, null);
  assert.equal((await propose(state, assist, [crossing])).success, true);
});

test("an operation on an unselected item is refused before it runs", async () => {
  const state = session();
  const assist = bridgeAssist();
  const result = await propose(state, assist, [
    op("pictureOps", { type: "moveItem", itemId: "river", dx: 0, dy: 1 }),
  ]);
  assert.match(
    result.error ?? "",
    /pictureOps\[0\] \(moveItem\) edits river, which is not selected/,
  );
});

test("a stale base is refused: an old revision, or a draft changed mid-request", async () => {
  const state = session();
  const stale = await propose(state, bridgeAssist(), [crossing], "picture-1-00000000");
  assert.match(stale.error ?? "", /not the draft's current revision.*Call read_edit_context again/);
  const edited = BRIDGE_SOURCE.replace('"Sky"', '"Clouds"');
  const moved = bridgeAssist(() => ({ kind: "picture", source: edited }));
  const changed = await propose(state, moved, [crossing]);
  assert.match(changed.error ?? "", /the creator changed the draft after asking/);
});

test("proposals stop at the request's ceiling", async () => {
  const state = session();
  const assist = createStudioAssist(bridgeAssist().focus, { maxProposals: 1 });
  assert.equal((await propose(state, assist, [crossing])).success, true);
  const over = await propose(state, assist, [crossing]);
  assert.match(over.error ?? "", /allows 1 proposals and all were used/);
  assert.equal(assist.proposals, 1);
});

test("blue eyes on loop 1 leave loop 0 and the live payload alone", async () => {
  const state = session();
  const assist = robotAssist();
  const before = ROBOT_VIEW.slice();
  const context = await run(state, assist, "read_edit_context", { images: true });
  assert.equal(context.success, true, context.error ?? "");
  assert.deepEqual(context.details!["colours"], [
    { loop: 1, cel: 0, colours: { 7: 7, 12: 1 } },
    { loop: 1, cel: 1, colours: { 7: 7, 12: 1 } },
  ]);
  // One tile per selected cel: 4x3 cels enlarged 4x, 2:1 wide.
  assert.deepEqual(pngSize(context.images![0]!.png), [32, 12 * 2 + 4]);
  const result = await propose(state, assist, [
    op("spriteOps", { type: "recolor", recolorScope: "cels", cels: loop1, from: 12, to: 1 }),
  ]);
  assert.equal(result.success, true, result.error ?? "");
  assert.deepEqual(result.details!["changedCels"], [
    { loop: 1, cel: 0, pixels: 1 },
    { loop: 1, cel: 1, pixels: 1 },
  ]);
  assert.deepEqual(result.details!["isolated"], [1]);
  // before | after | diff tiles of 32x12 with 4-pixel gutters, two rows.
  assert.deepEqual(pngSize(result.images![0]!.png), [3 * 32 + 2 * 4, 2 * 12 + 4]);
  assert.deepEqual([...ROBOT_VIEW], [...before]);
  const candidate = assist.candidate!;
  assert.equal(candidate.kind, "view");
  const view = parseView(candidate.kind === "view" ? candidate.draft.payload : new Uint8Array());
  // Loop 1 displays loop 0 mirrored: the eye at x 1 shows at x 2, now blue.
  assert.equal(view.loops[1]!.cels[0]!.pixels[1 * 4 + 2], 1);
  assert.equal(view.loops[0]!.cels[0]!.pixels[1 * 4 + 1], 12);
});

test("a propagated recolor reaching the unselected mirror is refused", async () => {
  const result = await propose(session(), robotAssist(), [
    op("spriteOps", {
      type: "recolor",
      recolorScope: "cels",
      cels: loop1,
      from: 12,
      to: 1,
      propagate: true,
    }),
  ]);
  assert.match(result.error ?? "", /loop 0, cel 0 is not selected, but 1 pixel of it would change/);
});
