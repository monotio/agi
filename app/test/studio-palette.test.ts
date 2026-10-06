import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { effectScope, ref } from "vue";
import { DEFAULT_V2_PROFILE } from "../../src/runtime/profile.ts";
import { commandTimeline } from "../../src/studio/pictureQuery.ts";
import { defaultValues, type StudioTool } from "../src/studio/studioTools.ts";
import { NO_UNLOCKS } from "../src/studio/studioLocks.ts";
import type { StudioLens } from "../src/studio/studioView.ts";
import { paletteContext, useStudioPalette } from "../src/studio/useStudioPalette.ts";
import { useStudioEditing } from "../src/studio/useStudioEditing.ts";
import { useStudioDraft } from "../src/studio/useStudioDraft.ts";
import { testRevision } from "./identity.ts";

const SOURCE = `# @item a "Art" art
vis 2
pri off
line 10,20 20,20
# @end
# @item b "Both" mixed
vis 3
pri 8
line 40,90 50,90
# @end
# @item w "Wall" walk
vis off
pri 0
line 70,130 80,130
# @end
end`;
function setup(lens: StudioLens, ids: string[]) {
  const scope = effectScope();
  const result = scope.run(() => {
    const tool = ref<StudioTool>("select");
    const view = ref(lens);
    const selectedId = ref<string | undefined>(ids[0]);
    const selected = ref(ids);
    const draft = useStudioDraft({
      base: { source: SOURCE, revision: testRevision("palette") },
      profile: DEFAULT_V2_PROFILE,
      lens: view,
      unlocks: NO_UNLOCKS,
    });
    const editing = useStudioEditing({
      draft,
      selectedId,
      itemIds: () => selected.value,
      frozen: () => false,
      selectItems: (ids) => {
        selected.value = [...ids];
        selectedId.value = ids[0];
      },
    });
    const current = ref(defaultValues(lens));
    const palette = useStudioPalette({
      tool,
      lens: view,
      selected: () => selected.value.length > 0,
      timeline: () => commandTimeline(draft.document.value),
      editing,
      current,
      setValues: (patch) => {
        current.value = { ...current.value, ...patch };
      },
      frozen: () => false,
    });
    return { palette, draft, editing, current, tool };
  })!;
  return { ...result, stop: () => scope.stop() };
}
describe("palette context", () => {
  for (const lens of ["art", "depth", "walk"] as const) {
    for (const selected of [false, true]) {
      it(`${lens}, selection ${selected}: each tool exposes its usable values`, () => {
        for (const tool of ["line", "rect", "polygon", "fill", "brush"] as const)
          assert.deepEqual(paletteContext(tool, lens, selected), { action: "draw", lens });
        assert.deepEqual(paletteContext("select", lens, selected), {
          action: selected ? "recolour" : "hint",
          lens,
        });
        for (const tool of ["point", "pipette", "hand", "walk", "door", "edge"] as const)
          assert.deepEqual(paletteContext(tool, lens, selected), { action: "hint", lens });
      });
    }
  }
});
for (const [lens, ids, patch] of [
  ["art", ["a", "b"], { visual: 4 }],
  ["depth", ["b"], { priority: 10 }],
  ["walk", ["w"], { priority: 3 }],
] as const) {
  it(`${lens}: recolours the selection in one reversible step and leaves drawing values alone`, () => {
    const s = setup(lens, [...ids]);
    try {
      const before = s.draft.source.value;
      const drawing = { ...s.current.value };
      s.palette.choose(patch);
      assert.notEqual(s.draft.source.value, before);
      assert.equal(s.draft.history.value.past.length, 1);
      const at = lens === "art" ? "visual" : "priority";
      const expected = lens === "art" ? 4 : lens === "depth" ? 10 : 3;
      for (const [id, x, y] of [
        ["a", 10, 20],
        ["b", 40, 90],
        ["w", 70, 130],
      ] as const)
        if ((ids as readonly string[]).includes(id))
          assert.equal(s.draft.compiled.value[at][y * 160 + x], expected);
      assert.deepEqual(s.current.value, drawing);
      assert.equal(s.editing.undo(), true);
      assert.equal(s.draft.source.value, before);
    } finally {
      s.stop();
    }
  });
}
it("recolours a combined group as one step", () => {
  const s = setup("art", ["a", "b"]);
  try {
    assert.equal(s.editing.combine("Pair"), true);
    const before = s.draft.source.value;
    s.palette.choose({ visual: 4 });
    assert.notEqual(s.draft.source.value, before);
    assert.equal(s.draft.history.value.past.length, 2);
    assert.equal(s.draft.compiled.value.visual[20 * 160 + 10], 4);
    assert.equal(s.draft.compiled.value.visual[90 * 160 + 40], 4);
    s.editing.undo();
    assert.equal(s.draft.source.value, before);
  } finally {
    s.stop();
  }
});
for (const [lens, ids, patch, message] of [
  [
    "art",
    ["a", "w"],
    { visual: 4 },
    "Wall has no visual colour. Select a shape with visual colour to recolour it.",
  ],
  [
    "depth",
    ["a"],
    { priority: 10 },
    "Art has no depth band. Paint a depth band or select a shape with one.",
  ],
  [
    "walk",
    ["b"],
    { priority: 0 },
    "Both has no walk line. Select a Wall, Gate, Trigger or Water shape.",
  ],
] as const) {
  it(`${lens}: refuses the whole selection when an item lacks that kind of colour`, () => {
    const s = setup(lens, [...ids]);
    try {
      const before = s.draft.source.value;
      s.palette.choose(patch);
      assert.equal(s.draft.source.value, before);
      assert.equal(s.draft.history.value.past.length, 0);
      assert.equal(s.editing.notice.value?.text, message);
    } finally {
      s.stop();
    }
  });
}
it("a drawing tool changes future drawing, while an idle tool leaves it alone", () => {
  const s = setup("art", []);
  try {
    s.palette.choose({ visual: 4 });
    assert.equal(s.current.value.visual, 0);
    s.tool.value = "brush";
    s.palette.choose({ visual: 4 });
    assert.equal(s.current.value.visual, 4);
    assert.equal(s.draft.history.value.past.length, 0);
  } finally {
    s.stop();
  }
});

it("the current selection colour creates no extra History step", () => {
  const s = setup("art", ["a"]);
  try {
    s.palette.choose({ visual: 2 });
    assert.equal(s.draft.history.value.past.length, 0);
  } finally {
    s.stop();
  }
});
it("loose drawing commands ask for a shape instead of silently ignoring a colour", () => {
  const s = setup("art", ["loose"]);
  try {
    s.palette.choose({ visual: 4 });
    assert.equal(s.draft.history.value.past.length, 0);
    assert.equal(s.editing.notice.value?.text, "Select a shape in Items to recolour it.");
  } finally {
    s.stop();
  }
});
