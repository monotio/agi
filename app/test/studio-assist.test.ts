import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { effectScope, ref } from "vue";
import { AgentSession } from "../src/agent/agentSession.ts";
import type { AgentLogEntry } from "../src/agent/agentLog.ts";
import type { AgentRunState } from "../src/agent/agentRun.ts";
import { STUB_DECLINE_TEXT, type StudioAssistResult } from "../src/agent/studioAssist.ts";
import { createAgentSessionState } from "../../src/agent/agentState.ts";
import type { StudioCandidate, StudioFocus } from "../../src/agent/studioAssistTools.ts";
import { draftRevision, pictureAssistScope } from "../../src/studio/assistScope.ts";
import { DEFAULT_V2_PROFILE } from "../../src/runtime/profile.ts";
import type { PictureItemKind } from "../../src/studio/pictureDocument.ts";
import { openSprite } from "../../src/view/spriteDocument.ts";
import { viewAssistScope } from "../../src/studio/assistScope.ts";
import { applySpriteEdit } from "../../src/studio/sprite/spriteOperations.ts";
import { BRIDGE_SOURCE, DOT_EGO, ROBOT_VIEW } from "../../test/studioAssistFixtures.ts";
import { testRevision } from "./identity.ts";
import { NO_UNLOCKS, type LensUnlocks } from "../src/studio/studioLocks.ts";
import {
  assistSteps,
  refusalWords,
  STALE_TEXT,
  useStudioAssist,
  type StudioAssistHost,
} from "../src/studio/useStudioAssist.ts";
import { useStudioDraft } from "../src/studio/useStudioDraft.ts";
import { useSpriteDraft } from "../src/studio/sprite/useSpriteDraft.ts";
import {
  numberList,
  pictureChangeSummary,
  pictureScopeChips,
  viewChangeSummary,
  viewScopeChips,
  walkableWords,
} from "../src/studio/studioAssistText.ts";

/** Room Studio's draft on the bridge fixture, in the Walk lens, and a host on a stub session. */
function bridgeStudio(unlocks: LensUnlocks = NO_UNLOCKS) {
  const scope = effectScope();
  const log: AgentLogEntry[] = [];
  let task: AgentRunState | null = null;
  const live = createAgentSessionState();
  live.container.putResource("view", 0, DOT_EGO);
  const session = new AgentSession(
    { provider: "stub", apiKey: "", model: "offline-stub" },
    (kind, detail, data) => {
      if (data && typeof data === "object" && "task" in data) {
        task = (data as { task: AgentRunState }).task;
        return;
      }
      log.push({ id: String(log.length), seq: log.length + 1, timestamp: 0, kind, detail, data });
    },
    live,
  );
  const host: StudioAssistHost = {
    run: (request) => session.runStudioAssist(request),
    cancel: () => session.task.cancel(),
    resume: () => session.task.resume(),
    task: () => task,
    log: () => log,
  };
  const lens = ref<"walk">("walk");
  const locks = ref(unlocks);
  const selected = ref<string[]>(["bridge"]);
  return scope.run(() => {
    const draft = useStudioDraft({
      base: { source: BRIDGE_SOURCE, revision: testRevision("bridge") },
      profile: DEFAULT_V2_PROFILE,
      lens,
      unlocks: locks,
    });
    const current = () => ({ kind: "picture" as const, source: draft.source.value });
    const applied: StudioCandidate[] = [];
    const assist = useStudioAssist({
      host: () => host,
      configured: () => true,
      frozen: () => false,
      selected: () => selected.value.length > 0,
      focus: (): StudioFocus => ({
        scope: pictureAssistScope({
          num: 1,
          compiled: draft.compiled.value,
          targetIds: selected.value,
          lens: lens.value,
          unlocks: locks.value,
        }),
        draft: current,
        lens: lens.value,
      }),
      current,
      apply: (candidate, focus) => {
        applied.push(candidate);
        if (candidate.kind !== "picture" || focus.scope.kind !== "picture")
          return { ok: false, message: "wrong kind" };
        const outcome = draft.adopt(candidate.draft.source, "AI edit", focus.scope);
        return outcome.ok ? outcome : { ok: false, message: outcome.refusal.message };
      },
    });
    return { assist, draft, applied, log, selected, dispose: () => scope.stop() };
  })!;
}

/** A host whose request waits until the test settles it (or Stop cancels it). */
function heldHost() {
  let settle!: (result: StudioAssistResult) => void;
  let fail!: (error: Error) => void;
  const calls = { run: 0, cancel: 0 };
  const host: StudioAssistHost = {
    run: () => {
      calls.run++;
      return new Promise<StudioAssistResult>((resolve, reject) => {
        settle = resolve;
        fail = reject;
      });
    },
    cancel: () => {
      calls.cancel++;
      fail(new Error("Agent task cancelled. Unapplied changes were discarded."));
    },
    resume: () => {},
    task: () => null,
    log: () => [],
  };
  return { host, calls, settle: (result: StudioAssistResult) => settle(result) };
}

function heldStudio(host: StudioAssistHost, options: { configured?: boolean } = {}) {
  const source = ref(BRIDGE_SOURCE);
  const applied: StudioCandidate[] = [];
  const current = () => ({ kind: "picture" as const, source: source.value });
  const focus = (): StudioFocus => ({
    scope: { ...bridgeScope(), baseRevision: draftRevision(current()) },
    draft: current,
  });
  const scope = effectScope();
  const assist = scope.run(() =>
    useStudioAssist({
      host: () => host,
      configured: () => options.configured ?? true,
      frozen: () => false,
      selected: () => true,
      focus,
      current,
      apply: (candidate) => (applied.push(candidate), { ok: true }),
    }),
  )!;
  return { assist, source, applied, scope };
}

function bridgeScope() {
  const draft = useStudioDraft({
    base: { source: BRIDGE_SOURCE, revision: testRevision("bridge") },
    profile: DEFAULT_V2_PROFILE,
    lens: "walk",
    unlocks: NO_UNLOCKS,
  });
  return pictureAssistScope({
    num: 1,
    compiled: draft.compiled.value,
    targetIds: ["bridge"],
    lens: "walk",
  });
}

const fakeCandidate = (baseRevision: string): StudioCandidate => ({
  kind: "picture",
  candidateId: "c1",
  num: 1,
  baseRevision,
  revision: "picture-x",
  summary: "Opened the barrier.",
  ops: [],
  draft: { kind: "picture", source: `${BRIDGE_SOURCE}\n` },
  previewPng: new Uint8Array(),
  check: { ok: true, violations: [] },
});

describe("useStudioAssist", () => {
  it("runs a request to a candidate and accepts it as one undo step", async () => {
    const studio = bridgeStudio();
    const { assist, draft } = studio;
    assert.equal(assist.phase.value, "idle");
    const asking = assist.ask("Make this bridge walkable without changing the art");
    assert.equal(assist.phase.value, "running");
    assert.equal(assist.holds.value, true);
    await asking;
    assert.equal(assist.phase.value, "candidate");
    assert.equal(assist.stale.value, false);
    assert.deepEqual(assist.steps.value, ["Read the selection", "Proposed a change"]);
    const before = draft.compiled.value;
    assert.equal(draft.source.value, BRIDGE_SOURCE, "a candidate is not applied until accepted");
    assert.equal(assist.accept(), true);
    assert.equal(assist.phase.value, "accepted");
    assert.equal(assist.holds.value, false);
    assert.equal(draft.history.value.past.length, 1);
    // Only the 80 bank cells under the bridge (x 60..99, rows 120 and 139) change: 0 -> 3.
    const after = draft.compiled.value;
    assert.deepEqual(after.visual, before.visual);
    const changed: number[] = [];
    for (let i = 0; i < after.priority.length; i++)
      if (after.priority[i] !== before.priority[i]) changed.push(i);
    assert.equal(changed.length, 80);
    for (const i of changed) {
      const x = i % 160;
      const y = (i - x) / 160;
      assert.ok(x >= 60 && x <= 99 && (y === 120 || y === 139), `${x},${y}`);
      assert.deepEqual([before.priority[i], after.priority[i]], [0, 3]);
    }
    assert.deepEqual(
      assist.thread.value.map((turn) => turn.role),
      ["creator", "ai"],
    );
    assert.equal(draft.undo(), true);
    assert.equal(draft.source.value, BRIDGE_SOURCE, "one undo restores the draft");
    studio.dispose();
  });

  it("shows a refusal and the retry, and the final candidate respects the locks", async () => {
    const studio = bridgeStudio();
    await studio.assist.ask("bad: repaint the bridge, then make it walkable");
    assert.deepEqual(studio.assist.steps.value, [
      "Read the selection",
      "Refused: would change the art; trying again",
      "Proposed a change",
    ]);
    assert.equal(studio.assist.candidate.value?.candidateId, "c2");
    const before = studio.draft.compiled.value.visual;
    assert.equal(studio.assist.accept(), true);
    assert.deepEqual(studio.draft.compiled.value.visual, before);
    studio.dispose();
  });

  it("rejecting leaves the draft untouched", async () => {
    const studio = bridgeStudio();
    await studio.assist.ask("make this walkable");
    studio.assist.reject();
    assert.equal(studio.assist.phase.value, "rejected");
    assert.equal(studio.assist.candidate.value, null);
    assert.equal(studio.assist.accept(), false);
    assert.equal(studio.draft.source.value, BRIDGE_SOURCE);
    assert.deepEqual(studio.applied, []);
    studio.dispose();
  });

  it("a declined request shows the AI's reason and changes nothing", async () => {
    const studio = bridgeStudio();
    await studio.assist.ask("impossible: walk onto the ceiling");
    assert.equal(studio.assist.phase.value, "declined");
    assert.equal(studio.assist.reply.value, STUB_DECLINE_TEXT);
    assert.equal(studio.assist.holds.value, false);
    assert.equal(studio.draft.source.value, BRIDGE_SOURCE);
    // Ask again continues the thread on the same selection.
    await studio.assist.ask("make it walkable then");
    assert.equal(studio.assist.phase.value, "candidate");
    assert.equal(studio.assist.thread.value.length, 4);
    // Another selection starts a new thread.
    studio.selected.value = ["river"];
    await studio.assist.ask("impossible");
    assert.equal(studio.assist.thread.value.length, 2);
    studio.dispose();
  });

  it("a candidate goes stale when the draft changes, and cannot be accepted", async () => {
    const held = heldHost();
    const studio = heldStudio(held.host);
    const asking = studio.assist.ask("make this walkable");
    const base = draftRevision({ kind: "picture", source: BRIDGE_SOURCE });
    // The creator changes the draft (an undo, say) while the AI works.
    studio.source.value = BRIDGE_SOURCE.replace('"Bridge"', '"Old bridge"');
    held.settle({ text: "Done.", candidate: fakeCandidate(base), proposals: 1, refusals: 0 });
    await asking;
    assert.equal(studio.assist.phase.value, "candidate");
    assert.equal(studio.assist.stale.value, true);
    assert.equal(studio.assist.accept(), false);
    assert.equal(studio.assist.error.value, STALE_TEXT);
    assert.deepEqual(studio.applied, []);
    // Back to the base text: the candidate applies again.
    studio.source.value = BRIDGE_SOURCE;
    assert.equal(studio.assist.stale.value, false);
    assert.equal(studio.assist.accept(), true);
    assert.equal(studio.applied.length, 1);
    studio.scope.stop();
  });

  it("Stop cancels the request and leaves the draft untouched", async () => {
    const held = heldHost();
    const studio = heldStudio(held.host);
    const asking = studio.assist.ask("make this walkable");
    assert.equal(studio.assist.running.value, true);
    studio.assist.stop();
    await asking;
    assert.equal(held.calls.cancel, 1);
    assert.equal(studio.assist.phase.value, "stopped");
    assert.equal(studio.assist.error.value, "");
    assert.equal(studio.source.value, BRIDGE_SOURCE);
    assert.deepEqual(studio.applied, []);
    studio.scope.stop();
  });

  it("a failed request says why; leaving Studio mid-request stops it", async () => {
    const held = heldHost();
    const studio = heldStudio(held.host);
    const asking = studio.assist.ask("make this walkable");
    studio.scope.stop();
    assert.equal(held.calls.cancel, 1);
    await asking;
    const failing: StudioAssistHost = {
      ...heldHost().host,
      run: () => Promise.reject(new Error("Provider unavailable")),
    };
    const other = heldStudio(failing);
    await other.assist.ask("make this walkable");
    assert.equal(other.assist.phase.value, "failed");
    assert.equal(other.assist.error.value, "Provider unavailable");
    other.scope.stop();
  });

  it("an accept the draft refuses keeps the candidate and says why", async () => {
    const held = heldHost();
    const scope = effectScope();
    const source = BRIDGE_SOURCE;
    const current = () => ({ kind: "picture" as const, source });
    const assist = scope.run(() =>
      useStudioAssist({
        host: () => held.host,
        configured: () => true,
        frozen: () => false,
        selected: () => true,
        focus: () => ({ scope: bridgeScope(), draft: current }),
        current,
        apply: () => ({ ok: false, message: "This would change the art." }),
      }),
    )!;
    const asking = assist.ask("walk");
    held.settle({
      text: "Done.",
      candidate: fakeCandidate(draftRevision(current())),
      proposals: 1,
      refusals: 0,
    });
    await asking;
    assert.equal(assist.accept(), false);
    assert.equal(assist.phase.value, "candidate");
    assert.equal(assist.error.value, "This would change the art.");
    scope.stop();
  });

  it("says why nothing can be asked: no AI here, no provider, frozen, nothing selected", async () => {
    const scope = effectScope();
    const make = (over: Partial<Parameters<typeof useStudioAssist>[0]>) =>
      scope.run(() =>
        useStudioAssist({
          host: () => heldHost().host,
          configured: () => true,
          frozen: () => false,
          selected: () => true,
          focus: () => null,
          current: () => ({ kind: "picture", source: "" }),
          apply: () => ({ ok: true }),
          ...over,
        }),
      )!;
    assert.equal(make({ host: () => null }).blocked.value, "unavailable");
    const unconfigured = make({ configured: () => false });
    assert.equal(unconfigured.blocked.value, "connect");
    await unconfigured.ask("walk");
    assert.equal(unconfigured.phase.value, "idle");
    assert.equal(make({ frozen: () => true }).blocked.value, "frozen");
    assert.equal(make({ selected: () => false }).blocked.value, "selection");
    assert.equal(make({}).blocked.value, null);
    scope.stop();
  });
});

describe("the adopting drafts", () => {
  it("Room Studio refuses a candidate outside its scope, whatever the request claims", () => {
    const scope = effectScope();
    scope.run(() => {
      const draft = useStudioDraft({
        base: { source: BRIDGE_SOURCE, revision: testRevision("bridge") },
        profile: DEFAULT_V2_PROFILE,
        lens: "walk",
        unlocks: NO_UNLOCKS,
      });
      const request = pictureAssistScope({
        num: 1,
        compiled: draft.compiled.value,
        targetIds: ["bridge"],
        lens: "walk",
      });
      // Recolouring the bridge's art: the Walk lens locks the art.
      const repainted = BRIDGE_SOURCE.replace("vis 6", "vis 8");
      const outcome = draft.adopt(repainted, "AI edit", request);
      assert.equal(outcome.ok, false);
      assert.equal(draft.source.value, BRIDGE_SOURCE);
      assert.equal(draft.history.value.past.length, 0);
      // A draft that moved since the request: the scope's base is stale, so
      // even the unchanged text is refused.
      draft.apply({ type: "setItemMeta", itemId: "bridge", label: "Old bridge" }, "Edit");
      assert.equal(draft.adopt(BRIDGE_SOURCE, "AI edit", request).ok, false);
      assert.equal(draft.history.value.past.length, 1);
    });
    scope.stop();
  });

  it("Sprite Studio adopts a candidate on the targeted loop as one undo step", () => {
    const scope = effectScope();
    scope.run(() => {
      const draft = useSpriteDraft({
        base: { bytes: ROBOT_VIEW, revision: testRevision("robot") },
        profile: DEFAULT_V2_PROFILE,
      });
      const request = viewAssistScope({
        num: 1,
        document: draft.document.value,
        targetCels: [
          { loop: 1, cel: 0 },
          { loop: 1, cel: 1 },
        ],
        protectedLoops: [0],
      });
      // Loop 1's eye turns blue through the kernel; loop 0 keeps its red eye.
      const recolour = (cels: { loop: number; cel: number }[]) => {
        const result = applySpriteEdit(draft.document.value, {
          type: "recolor",
          scope: cels,
          from: 12,
          to: 1,
        });
        assert.ok(!("error" in result));
        return result.document.payload;
      };
      const loop1 = [0, 1].map((cel) => ({ loop: 1, cel }));
      const red0 = [...draft.document.value.loops[0]!.cels[0]!.pixels];
      assert.equal(draft.document.value.loops[1]!.alias, 0);
      const outcome = draft.adopt(recolour(loop1), "AI edit", request);
      assert.equal(outcome.ok, true, JSON.stringify(outcome));
      assert.equal(draft.history.value.past.length, 1);
      const after = draft.document.value;
      assert.deepEqual([...after.loops[0]!.cels[0]!.pixels], red0);
      assert.ok(after.loops[1]!.cels.every((c) => c.pixels.includes(1) && !c.pixels.includes(12)));
      // A candidate reaching loop 0 is refused, and nothing changes.
      assert.equal(draft.undo(), true);
      const both = recolour([...loop1, { loop: 0, cel: 0 }, { loop: 0, cel: 1 }]);
      assert.equal(draft.adopt(both, "AI edit", request).ok, false);
      assert.equal(draft.history.value.past.length, 0);
    });
    scope.stop();
  });

  it("Sprite Studio adopts an owner-loop candidate while its mirror stays protected", () => {
    const scope = effectScope();
    scope.run(() => {
      const draft = useSpriteDraft({
        base: { bytes: ROBOT_VIEW, revision: testRevision("robot") },
        profile: DEFAULT_V2_PROFILE,
      });
      // As Sprite Studio asks about loop 0: every other loop, the mirror 1, protected.
      const loop0 = [0, 1].map((cel) => ({ loop: 0, cel }));
      const request = viewAssistScope({
        num: 1,
        document: draft.document.value,
        targetCels: loop0,
        protectedLoops: [1],
      });
      const shown1 = draft.document.value.loops[1]!.cels.map((c) => [...c.pixels]);
      const result = applySpriteEdit(draft.document.value, {
        type: "recolor",
        scope: loop0,
        from: 12,
        to: 1,
      });
      assert.ok(!("error" in result));
      const outcome = draft.adopt(result.document.payload, "AI edit", request);
      assert.equal(outcome.ok, true, JSON.stringify(outcome));
      assert.deepEqual(
        draft.document.value.loops[1]!.cels.map((c) => [...c.pixels]),
        shown1,
        "the protected mirror shows what it showed",
      );
    });
    scope.stop();
  });
});

describe("assist words", () => {
  it("names refusals plainly and lists the activity", () => {
    assert.equal(
      refusalWords([
        { constraint: "locked-plane", plane: "visual" },
        { constraint: "outside-mask", plane: "visual" },
      ]),
      "would change the art",
    );
    assert.equal(
      refusalWords([{ constraint: "walk-depth" }, { constraint: "outside-target" }]),
      "would change depth values and would change things outside the selection",
    );
    assert.equal(
      refusalWords([{ constraint: "fill-spill", plane: "priority" }]),
      "would spill a fill outside the selection",
    );
    assert.equal(
      refusalWords([
        { constraint: "locked-plane", plane: "priority" },
        { constraint: "fill-spill", plane: "priority" },
      ]),
      "would change the depth",
    );
    assert.equal(
      refusalWords([{ constraint: "extra-copy", plane: "visual" }]),
      "would copy the selection more than once, or in other colours",
    );
    const entry = (kind: AgentLogEntry["kind"], detail: string, data?: unknown): AgentLogEntry => ({
      id: detail,
      timestamp: 0,
      kind,
      detail,
      data,
    });
    const refused = {
      result: { details: { violations: [{ constraint: "locked-plane", plane: "priority" }] } },
    };
    assert.deepEqual(
      assistSteps([
        entry("request", '[Studio] "walk" (picture 1)'),
        entry("request", "[Studio] read_edit_context"),
        entry("request", "[Studio] propose_edit"),
        entry("error", "[Studio] propose_edit -> Refused", refused),
        entry("request", "[Studio] propose_edit"),
      ]),
      ["Reading the selection…", "Refused: would change the depth; trying again", "Proposing…"],
    );
  });

  it("builds scope chips and change summaries from decoded pixels", () => {
    assert.equal(numberList([3, 0, 1, 2, 5]), "0–3, 5");
    assert.equal(numberList([0, 1]), "0, 1");
    assert.deepEqual(
      pictureScopeChips(["Bench occluder"]).map((chip) => chip.text),
      ["Bench occluder"],
    );
    assert.deepEqual(pictureScopeChips(["Bench", "Bench shadow", "Sign"]), [
      { text: "These 3 items", lock: false, title: "Bench, Bench shadow, Sign" },
    ]);
    assert.deepEqual(
      viewScopeChips({
        targetCels: [0, 1, 2, 3].map((cel) => ({ loop: 1, cel })),
        protectedLoops: [0],
      }).map((chip) => chip.text),
      ["Cels 0–3 · Loop 1", "Loop 0 protected"],
    );
    const plane = (fill: number) => new Uint8Array(160 * 168).fill(fill);
    const after = { visual: plane(1), priority: plane(4) };
    after.priority.fill(3, 0, 412);
    const everywhere = plane(1);
    assert.equal(
      pictureChangeSummary(
        { visual: plane(1), priority: plane(4) },
        after,
        "Bench occluder",
        everywhere,
      ),
      "412 depth cells inside Bench occluder",
    );
    // An area of the first 400 cells: the other 12 changed cells lie outside it.
    const first400 = plane(0).fill(1, 0, 400);
    assert.equal(
      pictureChangeSummary(
        { visual: plane(1), priority: plane(4) },
        after,
        "Bench occluder",
        first400,
      ),
      "400 depth cells inside Bench occluder, 12 outside",
    );
    // Art outside, depth inside: each plane named.
    const art = { visual: plane(1), priority: plane(4) };
    art.visual.fill(7, 500, 503);
    art.priority.fill(3, 0, 10);
    assert.equal(
      pictureChangeSummary({ visual: plane(1), priority: plane(4) }, art, "Bench", first400),
      "10 depth cells inside Bench, 3 art cells outside",
    );
    assert.equal(
      pictureChangeSummary({ visual: plane(1), priority: plane(4) }, art, "Bench", plane(0)),
      "3 art cells and 10 depth cells outside Bench",
    );
    // No pixel changes: the summary names what the proposal does to the items.
    type Item = { id: string; label: string; kind: PictureItemKind; locked: boolean };
    const bench: Item = { id: "bench", label: "Bench occluder", kind: "depth", locked: false };
    const sign: Item = { id: "sign", label: "Sign", kind: "art", locked: false };
    const same = (items: readonly Item[]) => ({
      visual: plane(1),
      priority: plane(4),
      document: { items },
    });
    assert.equal(
      pictureChangeSummary(
        same([bench]),
        same([{ ...bench, label: "Old bench" }]),
        "Bench occluder",
        everywhere,
      ),
      'No pixels change: relabels Bench occluder as "Old bench"',
    );
    assert.equal(
      pictureChangeSummary(
        same([bench, sign]),
        same([{ ...sign, kind: "mixed" }, bench, { ...sign, id: "sign-2", label: "Sign copy" }]),
        "Sign",
        everywhere,
      ),
      "No pixels change: makes Sign a mixed item, adds Sign copy, changes the drawing order",
    );
    assert.equal(
      pictureChangeSummary(same([bench, sign]), same([bench]), "Sign", everywhere),
      "No pixels change: removes Sign",
    );
    assert.equal(
      pictureChangeSummary(same([bench]), same([bench]), "Bench occluder", everywhere),
      "No pixels change (only the picture's notes)",
    );
    assert.deepEqual(walkableWords({ before: 880, after: 960 }), {
      line: "Floor (estimate): 880 → 960 cells in the selection",
      unchanged: null,
    });
    assert.deepEqual(walkableWords({ before: 0, after: 0 }), {
      line: "Floor (estimate): 0 → 0 cells in the selection",
      unchanged: "The floor stays as it was.",
    });
    assert.equal(
      walkableWords({ before: 2, after: 1 }).line,
      "Floor (estimate): 2 → 1 cell in the selection",
    );
    const robot = openSprite(ROBOT_VIEW, DEFAULT_V2_PROFILE);
    const blue = applySpriteEdit(robot, {
      type: "recolor",
      scope: [0, 1].map((cel) => ({ loop: 1, cel })),
      from: 12,
      to: 1,
    });
    assert.ok(!("error" in blue));
    assert.equal(viewChangeSummary(robot, blue.document), "2 pixels in loop 1, cels 0, 1");
  });
});
