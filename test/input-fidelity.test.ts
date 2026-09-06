import { test } from "node:test";
import assert from "node:assert/strict";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import { buildObjectFile } from "../src/agent/tools.ts";

class Host implements EngineHost {
  keys: number[] = [];
  print(): void {}
  displayAt(): void {}
  statusLine(): void {}
  takeInputLine(): null {
    return null;
  }
  takeKeys(): number[] {
    return this.keys.splice(0);
  }
}
function game(source: string, host: Host): Engine {
  const container = createContainer();
  container.putResource("logic", 0, assembleLogic(source, { dictionary: new Map() }).payload);
  return new Engine(container, host);
}

test("navigation is a movement event even when set.key binds the same PC word", () => {
  const host = new Host();
  const engine = game("set.key(0,72,7); return;", host);
  engine.tick();
  host.keys.push(0x4800);
  engine.tick();
  assert.equal(engine.vars[6], 1);
  assert.equal(engine.controllers[7], 0);
});

test("ASCII key words discard their scan byte before controller matching", () => {
  const host = new Host();
  const engine = game("set.key(97,0,7); return;", host);
  engine.tick();
  host.keys.push(0x1e61);
  engine.tick();
  assert.equal(engine.controllers[7], 1);
});

test("only the first nineteen events fit in the shared input queue", () => {
  const host = new Host();
  const engine = game("return;", host);
  host.keys.push(...Array<number>(19).fill(0x4800), 0x4d00);
  engine.tick();
  assert.equal(engine.vars[6], 1, "the twentieth event is dropped, leaving north selected");
});

test("a tracked release precedes a subsequently pressed direction in the same cycle", () => {
  const host = new Host();
  const engine = game("hold.key(); return;", host);
  engine.tick();
  host.keys.push(0x4800);
  engine.releaseTrackedKey();
  host.keys.push(0x4d00);
  engine.tick();
  assert.equal(engine.vars[6], 3, "north, release, east leaves east selected");
});

test("have.key discards mapped status events and retains unread raw events", () => {
  class LateHost extends Host {
    polls = 0;
    override takeKeys(): number[] {
      return ++this.polls === 2 ? [0x61, 0x62, 0x63] : [];
    }
  }
  const host = new LateHost();
  const engine = game(
    `
    set.key(97,0,7);
    if (have.key()) { assignv(v100,v19); }
    assignn(v19,0);
    if (have.key()) { assignv(v101,v19); }
    return;
  `,
    host,
  );
  engine.tick();
  assert.equal(engine.vars[100], 0x62, "mapped a is not a raw key");
  assert.equal(engine.vars[101], 0x63, "later raw c is retained for the next poll");
  assert.equal(engine.controllers[7], 0, "have.key discards status events");
});

test("have.key succeeds for an unmapped extended key even though its low byte is zero", () => {
  class LateHost extends Host {
    polls = 0;
    override takeKeys(): number[] {
      return ++this.polls === 2 ? [0x3b00] : [];
    }
  }
  const engine = game("if (have.key()) { assignn(v100,1); } return;", new LateHost());
  engine.tick();
  assert.equal(engine.vars[100], 1);
  assert.equal(engine.vars[19], 0);
});

test("a zero raw event makes have.key false without swallowing the following key", () => {
  class LateHost extends Host {
    polls = 0;
    override takeKeys(): number[] {
      return ++this.polls === 2 ? [0, 0x62] : [];
    }
  }
  const engine = game(
    `
    if (have.key()) { assignn(v100,1); }
    if (have.key()) { assignv(v101,v19); }
    return;
  `,
    new LateHost(),
  );
  engine.tick();
  assert.equal(engine.vars[100], 0);
  assert.equal(engine.vars[101], 0x62);
});

test("acknowledging a modal leaves later queued keys available to the resumed logic", () => {
  const host = new Host();
  const engine = game(
    `
    print("Continue");
    assignn(v19,0);
    if (have.key()) { assignv(v100,v19); }
    return;
  `,
    host,
  );
  engine.tick();
  assert.equal(engine.modalKind, "print");
  host.keys.push(0x0d, 0x62);
  engine.tick();
  assert.equal(engine.modalKind, null);
  assert.equal(engine.vars[100], 0x62);
});

test("modal confirmation aliases normalize before raw key ASCII reduction", () => {
  for (const word of [0x0101, 0x0301, 0x0201, 0x0401]) {
    const host = new Host();
    const engine = game('print("Continue"); return;', host);
    engine.tick();
    host.keys.push(word);
    engine.tick();
    assert.equal(engine.modalKind, null, `confirmation word ${word.toString(16)}`);
  }
});

test("script-bound Enter and Escape still select or dismiss a modal menu", () => {
  for (const key of [13, 27]) {
    const host = new Host();
    const engine = game(
      `
      if(!isset(f200)) {
        set(f200); set(f14); set.key(13,0,7); set.key(27,0,7); set.key(0,59,9);
        set.menu("Game"); set.menu.item("Continue",8); submit.menu(); menu.input();
      }
      if(controller(9)) { assignn(v100,1); }
      return;
    `,
      host,
    );
    engine.tick();
    engine.tick();
    assert.equal(engine.modalKind, "menu");
    host.keys.push(key, 0x3b00, 31);
    engine.tick();
    assert.equal(engine.modalKind, null);
    engine.tick();
    assert.equal(engine.controllers[7], 0);
    assert.equal(engine.controllers[8], key === 13 ? 1 : 0);
    assert.equal(engine.vars[100], 1, "the mapped F1 suffix reaches resumed script logic");
    assert.equal(engine.vars[19], 31, "the following raw suffix is preserved");
  }
});

test("a script-bound Escape cancels inventory and maps the remaining input in order", () => {
  const host = new Host();
  const container = createContainer();
  container.putFile("OBJECT", buildObjectFile([{ name: "key" }]));
  container.putResource(
    "logic",
    0,
    assembleLogic(
      `
    set.key(27,0,7); set.key(97,0,8); get(0); set(f13); status();
    assignn(v19,0);
    if(have.key()) { assignv(v100,v19); }
    assignn(v19,0);
    if(have.key()) { assignv(v101,v19); }
    return;
  `,
      { dictionary: new Map() },
    ).payload,
  );
  const engine = new Engine(container, host);
  engine.tick();
  assert.equal(engine.modalKind, "inventory");
  host.keys.push(27, 97, 98, 99);
  engine.tick();
  assert.equal(engine.modalKind, null);
  assert.equal(engine.vars[25], 255);
  assert.equal(engine.vars[100], 98, "mapped a is discarded by resumed have.key");
  assert.equal(engine.vars[101], 99, "raw b and c retain their order");
  assert.equal(engine.controllers[7], 0);
  assert.equal(engine.controllers[8], 0);
});

test("queued script-bound Escape can dismiss consecutive modal windows", () => {
  const host = new Host();
  const engine = game(
    `
    set.key(27,0,7); print("First"); print("Second"); assignn(v100,1); return;
  `,
    host,
  );
  engine.tick();
  host.keys.push(27, 27);
  engine.tick();
  assert.equal(engine.modalKind, "print");
  engine.tick();
  assert.equal(engine.modalKind, null);
  assert.equal(engine.vars[100], 1);
  assert.equal(engine.controllers[7], 0);
});

test("ordinary queued raw input keeps its classification when a later script adds a binding", () => {
  class LateHost extends Host {
    polls = 0;
    override takeKeys(): number[] {
      return ++this.polls === 2 ? [0x61, 0x62] : [];
    }
  }
  const engine = game(
    `
    if(have.key()) {
      set.key(98,0,7); assignn(v19,0);
      if(have.key()) { assignv(v100,v19); }
    }
    return;
  `,
    new LateHost(),
  );
  engine.tick();
  assert.equal(engine.vars[100], 98);
});

test("deferred tracked releases use eligibility captured when the key was released", () => {
  const eligible = game("return;", new Host());
  eligible.vars[6] = 3;
  eligible.releaseTrackedKey(true);
  eligible.tick();
  assert.equal(eligible.vars[6], 0, "an admitted release survives a later closed gate");

  const ineligible = game("hold.key(); return;", new Host());
  ineligible.tick();
  ineligible.vars[6] = 3;
  ineligible.releaseTrackedKey(false);
  ineligible.tick();
  assert.equal(ineligible.vars[6], 3, "opening the gate later does not admit an earlier release");
});
