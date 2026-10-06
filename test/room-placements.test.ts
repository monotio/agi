import assert from "node:assert/strict";
import { test } from "node:test";
import { roomPlacements, moveRoomPlacement } from "../src/authoring/roomPlacements.ts";

const setup = "animate.obj(o5);set.view(o5,2);set.loop(o5,1);set.cel(o5,3);";
test("room-entry constants supply static figures with editable positions", () => {
  const figures = roomPlacements({
    room: 6,
    sources: { "logic:6": `if(isset(f5)){${setup}position(o5,148,107);draw(o5);}return;` },
  });
  assert.equal(figures.length, 1);
  assert.deepEqual(
    [figures[0]!.object, figures[0]!.view, figures[0]!.x, figures[0]!.y, figures[0]!.reason],
    [5, 2, 148, 107, null],
  );
});
test("conditional and variable placement stay locked with their cause", () => {
  for (const [position, reason] of [
    ["if(isset(f20)){position(o5,40,100);}", "Conditional placement"],
    ["assignn(v20,40);assignn(v21,100);position.v(o5,v20,v21);", "position.v uses variables"],
  ]) {
    const figures = roomPlacements({
      room: 6,
      sources: { "logic:6": `if(isset(f5)){${setup}${position}draw(o5);}return;` },
    });
    assert.equal(figures[0]?.reason, reason);
    assert.equal(figures[0]?.x, 40);
  }
});
test("runtime positions stay unknown instead of using engine state", () => {
  const figures = roomPlacements({
    room: 6,
    sources: { "logic:6": `if(isset(f5)){${setup}position.v(o5,v20,v21);draw(o5);}return;` },
  });
  assert.equal(figures[0]?.x, null);
  assert.equal(figures[0]?.y, null);
});
test("room analysis follows shared entry setup and ignores per-cycle motion", () => {
  const figures = roomPlacements({
    room: 6,
    sources: {
      "logic:0":
        "if(equaln(v0,0)){new.room(6);}if(isset(f5)){animate.obj(o0);set.view(o0,2);}call.v(v0);return;",
      "logic:6": "if(isset(f5)){position(o0,80,140);draw(o0);}move.obj(o0,20,140,1,f10);return;",
    },
  });
  assert.deepEqual([figures[0]?.x, figures[0]?.y, figures[0]?.reason], [80, 140, null]);
});

test("a possible early return or opaque entry call locks the placement", () => {
  for (const gate of ["if(isset(f20)){return;}", "call.v(v20);"]) {
    const figures = roomPlacements({
      room: 6,
      sources: { "logic:6": `if(isset(f5)){${setup}${gate}position(o5,40,100);draw(o5);}return;` },
    });
    assert.ok(figures[0]?.reason);
  }
});
test("conditional animation cannot become draggable through a later literal position", () => {
  const figures = roomPlacements({
    room: 6,
    sources: { "logic:6": `if(isset(f20)){${setup}}position(o5,40,100);draw(o5);return;` },
  });
  assert.equal(figures[0]?.reason, "Conditional placement");
});
test("resetting the room-entry flag stops later entry-only placements", () => {
  const figures = roomPlacements({
    room: 6,
    sources: { "logic:6": `reset(f5);if(isset(f5)){${setup}position(o5,40,100);draw(o5);}return;` },
  });
  assert.deepEqual(figures, []);
});
test("drop edits only the operand spans and refuses a placement changed during dragging", () => {
  const source = `// Keep my words\nif(isset(f5)){${setup}position(o5, 148, 107);draw(o5);}return;`;
  const input = { room: 6, sources: { "logic:6": source } };
  const figure = roomPlacements(input)[0]!;
  assert.equal(moveRoomPlacement(input, figure, 150, 105), source.replace("148, 107", "150, 105"));
  assert.throws(
    () =>
      moveRoomPlacement(
        { ...input, sources: { "logic:6": source.replace("148, 107", "140, 107") } },
        figure,
        150,
        105,
      ),
    /placement changed/,
  );
});
