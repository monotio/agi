import { test } from "node:test";
import assert from "node:assert/strict";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { Engine, HostWait, type EngineHost } from "../src/runtime/engine.ts";
import { translatePlatformKey } from "../src/runtime/keys.ts";
import { PROFILES, type AgiProfile } from "../src/runtime/profile.ts";
import { buildObjectFile } from "../src/agent/agentState.ts";
import { buildView } from "../src/view/view.ts";

class Host implements EngineHost {
  keys: number[] = [];
  print(): void {}
  displayAt(): void {}
  statusLine(): void {}
  quit(): void {}
  takeInputLine(): null {
    return null;
  }
  takeKeys(): number[] {
    return this.keys.splice(0);
  }
}
function game(source: string, host: Host, profile?: AgiProfile): Engine {
  const container = createContainer();
  container.putResource("logic", 0, assembleLogic(source, { dictionary: new Map() }).payload);
  return new Engine(container, host, undefined, profile ? { profile } : undefined);
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

test("have.key reads script-mapped keys raw; the input phase maps what it leaves", () => {
  // The original applies set.key mappings only in the cycle's input phase;
  // have.key dequeues raw keys (docs/fidelity.md, "Script key mappings and
  // have.key"). Keys arriving during the logic pass are still raw for it.
  class LateHost extends Host {
    polls = 0;
    override takeKeys(): number[] {
      return ++this.polls === 2 ? [0x61, 0x62, 0x61] : [];
    }
  }
  const host = new LateHost();
  const engine = game(
    `
    set.key(97,0,7);
    if (!isset(f200)) {
      set(f200);
      if (have.key()) { assignv(v100,v19); }
      assignn(v19,0);
      if (have.key()) { assignv(v101,v19); }
    }
    return;
  `,
    host,
  );
  engine.tick();
  assert.equal(engine.vars[100], 0x61, "a mapped key is still a raw key for have.key");
  assert.equal(engine.vars[101], 0x62, "the next raw key is polled in order");
  assert.equal(engine.controllers[7], 0, "have.key never raises a controller");
  engine.tick();
  assert.equal(engine.controllers[7], 1, "the unread suffix maps in the next input phase");
  assert.equal(engine.vars[19], 0, "and is not a raw key there");
});

test("a have.key busy loop accepts a script-mapped key delivered while it waits", () => {
  // A busy loop spins inside one logic pass, so the original's timer-driven
  // keyboard poll always queues the key raw for the loop's have.key.
  class WaitingHost extends Host {
    answers = [0x0d, 0x62];
    waitKey(): number {
      return this.answers.shift() ?? 0x62;
    }
  }
  const engine = game(
    `
    set.key(13,0,7);
    assignn(v19,0);
  wait:
    if (!have.key()) { goto wait; }
    assignv(v100,v19);
    return;
  `,
    new WaitingHost(),
  );
  engine.tick();
  assert.equal(engine.vars[100], 0x0d, "the mapped Enter ends the loop");
  assert.equal(engine.controllers[7], 0);
});

test("a satisfied OR group skips the remaining members' handlers", () => {
  // The original steps over a satisfied OR group's leftover conditions
  // without executing them: a skipped have.key must not consume the pending
  // key, which the following condition still sees. The key is delivered by
  // the handler's own takeKeys call so it is never parked in v19.
  class LateHost extends Host {
    polls = 0;
    override takeKeys(): number[] {
      return ++this.polls === 2 ? [0x62] : [];
    }
  }
  const engine = game(
    `set(f60);
    if (isset(f60) || have.key()) { set(f61); }
    assignn(v19, 0);
    if (have.key()) { assignv(v100, v19); }
    return;`,
    new LateHost(),
  );
  engine.tick();
  assert.equal(engine.flags[61], 1);
  assert.equal(engine.vars[100], 0x62, "the skipped have.key leaves the key for the next poll");
});

test("have.key consumes an extended key but reports false and keeps v19 at zero", () => {
  // The original handler writes v19's low byte only when nonzero; F-keys and
  // navigation codes are consumed yet never satisfy have.key.
  class LateHost extends Host {
    polls = 0;
    override takeKeys(): number[] {
      return ++this.polls === 2 ? [0x3b00, 0x62] : [];
    }
  }
  const engine = game(
    `if (have.key()) { assignn(v100, 1); }
    assignn(v19, 0);
    if (have.key()) { assignv(v101, v19); }
    return;`,
    new LateHost(),
  );
  engine.tick();
  assert.equal(engine.vars[100], 0, "the F-key does not satisfy have.key");
  assert.equal(engine.vars[101], 0x62, "the following ASCII key is still polled");
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

test("a script-bound Escape cancels inventory and leaves the remaining input raw in order", () => {
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
  assert.equal(engine.vars[100], 97, "resumed have.key reads the mapped a raw");
  assert.equal(engine.vars[101], 98, "raw b follows in order");
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

test("have.key reads a queued key raw after a script adds its binding", () => {
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

test("editing keys reach v19 before the line editor consumes them", () => {
  // Player-visible rule: a script reads the key byte in v19 even when the
  // line editor consumes it — Enter, Backspace and echoing printables all
  // land in v19. The type-1 input case stores the event's low byte into v19
  // unconditionally and FIRST, before the acceptance gate and before
  // EditLine (kq3 2.936 0x35B0; demopac4 3.002.102 0x3963; gr1 3.002.149
  // 0x38FB).
  const host = new Host();
  const engine = game(
    `
    if (!isset(f200)) { set(f200); accept.input(); }
    if (isset(f201)) { reset(f201); assignv(v100,v19); }
    return;
  `,
    host,
  );
  engine.tick();
  engine.flags[201] = 1; // logic reads v19 in the same cycle the key lands
  host.keys.push(0x61); // 'a': echoed into the edit buffer
  engine.tick();
  assert.equal(engine.vars[100], 0x61, "the echoed printable is visible in v19");
  engine.flags[201] = 1;
  host.keys.push(0x08); // Backspace: consumed by the editor
  engine.tick();
  assert.equal(engine.vars[100], 0x08, "Backspace is visible in v19");
  engine.flags[201] = 1;
  host.keys.push(0x0d); // Enter accepts the line AND lands in v19
  engine.tick();
  assert.equal(engine.vars[100], 0x0d, "Enter is visible in v19");
});

test("have.key normalizes keypad Enter to a carriage return", () => {
  // Player-visible rule: keypad Enter satisfies have.key as Enter (v19 =
  // 0x0d), not as a stray 0x01 byte. The event queue stores the full word
  // (demopac4 3.002.102 PostEvent 0x48DD) and ButtonToChar (0x4A78) maps
  // 0x0101/0x0301 → CR inside GetKey, which have.key drains (0x0C13).
  class LateHost extends Host {
    polls = 0;
    override takeKeys(): number[] {
      // Polls 1-2 are the boot and current cycle's input phases; the third
      // poll is have.key's own drain inside the logic pass.
      return ++this.polls === 3 ? [0x0101] : [];
    }
  }
  const host = new LateHost();
  const engine = game(
    `
    if (isset(f201)) {
      reset(f201);
      assignn(v19,0);
      if (have.key()) { assignv(v100,v19); } else { assignn(v100,255); }
    }
    return;
  `,
    host,
  );
  engine.tick();
  engine.flags[201] = 1;
  engine.tick();
  assert.equal(engine.vars[100], 0x0d, "keypad Enter reads as Enter");
});

test("the input-phase line editor never normalizes keypad words", () => {
  // Player-visible rule: keypad Enter does not accept the command line — the
  // EditLine path is the one key consumer ButtonToChar never reaches
  // (demopac4 3.002.102: no call to 0x4A78 from EditLine 0x3A05); the word
  // reaches the editor as low byte 0x01.
  const host = new Host();
  const engine = game(
    `
    if (!isset(f200)) { set(f200); accept.input(); }
    return;
  `,
    host,
  );
  engine.tick();
  host.keys.push(0x61, 0x0101);
  engine.tick();
  assert.equal(engine.flags[2], 0, "no line was accepted");
  assert.equal(engine.vars[19], 0x01, "the editor saw the raw low byte");
});

test("a message window dismisses on Enter or Escape only, never Space", () => {
  // Player-visible rule: Space does not acknowledge a modal message. Every
  // print/show.obj/show.pri modal funnels to WaitAcAb → ChkAcAb: CR accepts,
  // ESC aborts, anything else keeps waiting (demopac4 3.002.102 ChkAcAb
  // 0x4A34: cmp 0x0d / cmp 0x1b / else -1; kq3 2.936 0x45F0).
  const host = new Host();
  const engine = game(
    `
    if (!isset(f200)) { set(f200); print("hello"); }
    return;
  `,
    host,
  );
  engine.tick();
  assert.equal(engine.modalKind, "print");
  host.keys.push(0x20);
  engine.tick();
  assert.equal(engine.modalKind, "print", "Space is not an acknowledgement");
  host.keys.push(0x0d);
  engine.tick();
  assert.equal(engine.modalKind, null, "Enter dismisses");
});

test("show.obj dismisses on Escape but not Space", () => {
  const host = new Host();
  const container = createContainer();
  container.putResource(
    "logic",
    0,
    assembleLogic(`if (!isset(f200)) { set(f200); load.view(1); show.obj(1); } return;`, {
      dictionary: new Map(),
    }).payload,
  );
  container.putResource(
    "view",
    1,
    buildView({ loops: [{ cels: [{ width: 1, height: 1, pixels: [1] }] }] }),
  );
  const engine = new Engine(container, host);
  engine.tick();
  assert.equal(engine.modalKind, "showObj");
  host.keys.push(0x20);
  engine.tick();
  assert.equal(engine.modalKind, "showObj", "Space is not an acknowledgement");
  host.keys.push(0x1b);
  engine.tick();
  assert.equal(engine.modalKind, null, "Escape dismisses");
});

test("the non-interactive inventory list dismisses on any event", () => {
  // Player-visible rule: with f13 clear the carried-items list ends on ANY
  // event — navigation, a controller, or an extended key with a zero low
  // byte — not just on printable keys. demopac4 3.002.102 0x3696: a bare
  // WaitEvent; kq3 2.936 0x32E9 likewise.
  const host = new Host();
  const engine = game(
    `
    if (!isset(f200)) { set(f200); status(); }
    return;
  `,
    host,
  );
  engine.tick();
  assert.equal(engine.modalKind, "inventory");
  host.keys.push(0x4800); // Up arrow: a navigation event, not a key byte
  engine.tick();
  assert.equal(engine.modalKind, null, "navigation dismisses the list");

  const host2 = new Host();
  const engine2 = game(
    `
    if (!isset(f200)) { set(f200); status(); }
    return;
  `,
    host2,
  );
  engine2.tick();
  host2.keys.push(0x3b00); // F1: type-1 event with a zero low byte
  engine2.tick();
  assert.equal(engine2.modalKind, null, "an extended key dismisses the list");
});

test("a keypad Enter from the host's waitKey accepts the quit confirmation", () => {
  // Player-visible rule: keypad Enter confirms quit exactly like the main
  // keyboard's Enter. ButtonToChar runs inside GetKey, and a synchronous
  // waitKey answer IS GetKey's return — the confirmation's key loop must
  // normalize it (demopac4 3.002.102 ButtonToChar 0x4A78 in GetKey 0x49D2).
  class KeypadHost extends Host {
    quits = 0;
    answers = [0x0101, 0x1b]; // keypad Enter, then Escape
    waitKey(): number {
      return this.answers.shift() ?? 0x1b;
    }
    override quit(): void {
      this.quits++;
    }
  }
  const host = new KeypadHost();
  const engine = game("quit(0); return;", host);
  engine.tick();
  assert.equal(host.quits, 1, "keypad Enter confirmed the quit");
});

test("a keypad Enter delivered as the host answer accepts the quit confirmation", () => {
  // Same rule on the suspended path: the confirmation parked on HostWait and
  // the delivered keypad word must normalize before the accept test.
  class SuspendedHost extends Host {
    quits = 0;
    waitKey(): number {
      throw new HostWait();
    }
    override quit(): void {
      this.quits++;
    }
  }
  const host = new SuspendedHost();
  const engine = game("quit(0); return;", host);
  engine.tick();
  assert.equal(engine.awaitingKey, true, "the confirmation parked");
  engine.deliverHostAnswer(0x0301); // joystick-button Enter
  engine.tick();
  assert.equal(host.quits, 1, "the delivered keypad word confirmed the quit");
});

test("PC, Amiga and IIgs profiles preserve 0x0101..0x0401 for set.key and normalize them in GetKey per platform", () => {
  // All 20 binaries store 16-bit (type, value) event words in the 20-slot
  // eventQueue and bind 0x0101..0x0401 in set.key across PC, Amiga and IIgs.
  // In GetKey (have.key, confirmations, modals):
  // - PC (all 13 builds) and Amiga (2.082 h76+0x278, 2.176..2.333 h103+0x28e)
  //   ButtonToChar maps 0x0101/0x0301 -> 0x0d (CR) and 0x0201/0x0401 -> 0x1b (ESC).
  // - Apple IIgs 1.014 (eventseg+0x351) ButtonToChar maps all four
  //   0x0101..0x0401 -> 0x0d (CR), and GetUserInput (seg2+0x1638) rewrites
  //   unmapped 0x0101/0x0201 -> 0x0d before v19 and EditLine.
  for (const profile of [
    "2.089",
    "2.411",
    "2.936",
    "3.002.149",
    "amiga-2.082",
    "amiga-2.316",
    "iigs-1.014",
  ] as const) {
    // 1. set.key(1, 4, 7) matches 0x0401 on every platform
    const mappedHost = new Host();
    const mappedEngine = game("set.key(1,4,7); return;", mappedHost, PROFILES[profile]);
    mappedEngine.tick();
    mappedHost.keys.push(0x0401);
    mappedEngine.tick();
    assert.equal(mappedEngine.controllers[7], 1, `${profile}: set.key(1,4,7) matches 0x0401`);

    // 2. have.key() calls GetKey -> ButtonToChar
    class LateHost extends Host {
      polls = 0;
      override takeKeys(): number[] {
        return ++this.polls === 3 ? [0x0201] : [];
      }
    }
    const host = new LateHost();
    const engine = game(
      `
      if (isset(f201)) {
        reset(f201);
        assignn(v19,0);
        if (have.key()) { assignv(v100,v19); } else { assignn(v100,255); }
      }
      return;
    `,
      host,
      PROFILES[profile],
    );
    engine.tick();
    engine.flags[201] = 1;
    engine.tick();
    const expected = profile === "iigs-1.014" ? 0x0d : 0x1b;
    assert.equal(engine.vars[100], expected, `${profile}: have.key() on 0x0201`);

    // 3. quit(0) confirmation normalizes 0x0101 to Enter (0x0d) on all platforms
    class KeypadHost extends Host {
      quits = 0;
      answers = [0x0101, 0x1b];
      waitKey(): number {
        return this.answers.shift() ?? 0x1b;
      }
      override quit(): void {
        this.quits++;
      }
    }
    const quitHost = new KeypadHost();
    const quitEngine = game("quit(0); return;", quitHost, PROFILES[profile]);
    quitEngine.tick();
    assert.equal(quitHost.quits, 1, `${profile}: quit(0) confirmation on 0x0101`);
  }

  // 4. On IIgs 1.014, unmapped 0x0101/0x0201 in GetUserInput become 0x0d (Enter)
  // before v19 and EditLine (seg2+0x1638..0x1654).
  const iigsHost = new Host();
  const iigsEngine = game(
    "if (!isset(f200)) { set(f200); accept.input(); } return;",
    iigsHost,
    PROFILES["iigs-1.014"],
  );
  iigsEngine.tick();
  iigsHost.keys.push(0x61, 0x0201);
  iigsEngine.tick();
  assert.equal(iigsEngine.vars[19], 0x0d, "iigs-1.014: unmapped 0x0201 stores 0x0d in v19");
});

test("F-IN-01: direction events clear ego.motionMode under player control on 2.272+, Amiga and IIgs, and leave it intact on 2.001..2.230", () => {
  for (const id of [
    "2.001",
    "2.089",
    "2.230",
    "2.272",
    "2.411",
    "2.936",
    "3.002.149",
    "amiga-2.082",
    "amiga-2.202",
    "amiga-2.316",
    "iigs-1.014",
  ] as const) {
    const host = new Host();
    const engine = game("return;", host, PROFILES[id]);
    engine.tick();
    engine.screenObjects[0]!.motionMode = 1; // MOTION_WANDER while under player control
    host.keys.push(0x4d00);
    engine.tick();
    const omitsClear = id === "2.001" || id === "2.089" || id === "2.230";
    assert.equal(
      engine.screenObjects[0]!.motionMode,
      omitsClear ? 1 : 0,
      `${id}: direction event motionMode clear`,
    );
  }
});

test("Keypad 5 (0xf500) stops ego on 2.001, 2.272+, Amiga and IIgs, but is ignored on 2.089 and 2.230", () => {
  for (const id of [
    "2.001",
    "2.089",
    "2.230",
    "2.272",
    "2.936",
    "3.002.149",
    "amiga-2.082",
    "amiga-2.316",
    "iigs-1.014",
  ] as const) {
    const host = new Host();
    const engine = game("return;", host, PROFILES[id]);
    engine.tick();
    host.keys.push(0x4d00); // start moving East (dir 3)
    engine.tick();
    assert.equal(engine.vars[6], 3, `${id}: moving East`);
    host.keys.push(0xf500); // Keypad 5
    engine.tick();
    const ignored = id === "2.089" || id === "2.230";
    assert.equal(engine.vars[6], ignored ? 3 : 0, `${id}: Keypad 5 stop behavior`);
  }
});

test("Amiga and IIgs left-clicking inside an unlabeled print or show.obj window dismisses it; clicking outside leaves it open", () => {
  class ClickHost extends Host {
    clicks: [number, number][] = [];
    takePointerClicks(): readonly (readonly [number, number])[] {
      return this.clicks.splice(0);
    }
  }
  for (const id of ["amiga-2.082", "amiga-2.202", "amiga-2.316", "iigs-1.014"] as const) {
    const host = new ClickHost();
    const engine = game(
      'if (!isset(f200)) { set(f200); print("Hello world"); } return;',
      host,
      PROFILES[id],
    );
    engine.tick();
    assert.equal(engine.modalKind, "print", `${id}: print modal opened`);
    // Click far outside the centered window (top-left corner (10, 10))
    host.clicks.push([10, 10]);
    engine.tick();
    assert.equal(engine.modalKind, "print", `${id}: click outside window keeps modal open`);
    // Click inside the centered window (center of screen (160, 88))
    host.clicks.push([160, 88]);
    engine.tick();
    assert.equal(engine.modalKind, null, `${id}: click inside window dismisses modal`);
  }
});

test("Amiga and IIgs left-click on text.screen or show.pri.screen enqueues Enter only on amiga-2.082 and iigs-1.014", () => {
  class ClickHost extends Host {
    clicks: [number, number][] = [];
    takePointerClicks(): readonly (readonly [number, number])[] {
      return this.clicks.splice(0);
    }
  }
  for (const id of ["amiga-2.082", "amiga-2.202", "amiga-2.316", "iigs-1.014"] as const) {
    const host = new ClickHost();
    const engine = game(
      "if (!isset(f200)) { set(f200); show.pri.screen(); } return;",
      host,
      PROFILES[id],
    );
    engine.tick();
    assert.equal(engine.modalKind, "showPri", `${id}: show.pri.screen modal opened`);
    host.clicks.push([160, 100]);
    engine.tick();
    const dismisses = id === "amiga-2.082" || id === "iigs-1.014";
    assert.equal(
      engine.modalKind,
      dismisses ? null : "showPri",
      `${id}: show.pri.screen click behavior`,
    );
  }
});

test("all profile families store v19 before the line editor, require Enter/Escape for print modals, and end bare status() on any event", () => {
  for (const profile of [
    "2.089",
    "2.411",
    "2.936",
    "3.002.149",
    "amiga-2.316",
    "iigs-1.014",
  ] as const) {
    const host = new Host();
    const engine = game(
      `
      if (!isset(f200)) { set(f200); accept.input(); }
      if (isset(f201)) { reset(f201); assignv(v100,v19); }
      return;
    `,
      host,
      PROFILES[profile],
    );
    engine.tick();
    host.keys.push(0x61);
    engine.tick();
    engine.flags[201] = 1;
    host.keys.push(0x0d);
    engine.tick();
    assert.equal(engine.vars[100], 0x0d, `${profile}: Enter stored in v19 before line editor`);

    const printHost = new Host();
    const printEngine = game(
      'if (!isset(f200)) { set(f200); print("hello"); } return;',
      printHost,
      PROFILES[profile],
    );
    printEngine.tick();
    printHost.keys.push(0x20); // Space does not dismiss ChkAcAb
    printEngine.tick();
    assert.equal(printEngine.modalKind, "print", `${profile}: Space keeps print modal open`);
    printHost.keys.push(0x0d);
    printEngine.tick();
    assert.equal(printEngine.modalKind, null, `${profile}: Enter dismisses print modal`);

    const invHost = new Host();
    const invEngine = game(
      "if (!isset(f200)) { set(f200); status(); } return;",
      invHost,
      PROFILES[profile],
    );
    invEngine.tick();
    assert.equal(invEngine.modalKind, "inventory");
    invHost.keys.push(0x4800);
    invEngine.tick();
    assert.equal(
      invEngine.modalKind,
      null,
      `${profile}: WaitEvent closes bare status() on any event`,
    );
  }
});

test("translatePlatformKey implements PC, Amiga and Apple IIgs native key translation", () => {
  // Amiga: Help -> F1 (0x3b00), Alt+Help -> 0xff00, Delete -> 0x7f, Ctrl+X -> 0x18 on 2.082 / 0x03 on 2.176+, Amiga+Q -> 0x0171
  assert.equal(translatePlatformKey({ key: "Help", code: "Help" }, "amiga-2.202"), 0x3b00);
  assert.equal(
    translatePlatformKey({ key: "Help", code: "Help", altKey: true }, "amiga-2.202"),
    0xff00,
  );
  assert.equal(translatePlatformKey({ key: "Delete", code: "Delete" }, "amiga-2.202"), 0x7f);
  assert.equal(
    translatePlatformKey({ key: "x", code: "KeyX", ctrlKey: true }, "amiga-2.082"),
    0x18,
  );
  assert.equal(
    translatePlatformKey({ key: "x", code: "KeyX", ctrlKey: true }, "amiga-2.202"),
    0x03,
  );
  assert.equal(
    translatePlatformKey({ key: "z", code: "KeyZ", altKey: true }, "amiga-2.202"),
    0x2c00,
  );
  assert.equal(
    translatePlatformKey({ key: "q", code: "KeyQ", metaKey: true }, "amiga-2.202"),
    0x0171,
  );

  // Amiga Meta-qualified word (0x0171) matches set.key(113, 1, c)
  const amigaHost = new Host();
  const amigaEngine = game("set.key(113, 1, 9); return;", amigaHost, PROFILES["amiga-2.202"]);
  amigaEngine.tick();
  amigaHost.keys.push(0x0171);
  amigaEngine.tick();
  assert.equal(amigaEngine.controllers[9], 1);

  // Apple IIgs: Shift+1..0 (!..)) -> F1..F10 (0x3b00..0x4400), Option+D -> 0x2000, Option+/ -> 0xff00 (sound toggle), Delete -> 0x08
  assert.equal(
    translatePlatformKey({ key: "!", code: "Digit1", shiftKey: true }, "iigs-1.014"),
    0x3b00,
  );
  assert.equal(
    translatePlatformKey({ key: ")", code: "Digit0", shiftKey: true }, "iigs-1.014"),
    0x4400,
  );
  assert.equal(
    translatePlatformKey({ key: "d", code: "KeyD", altKey: true }, "iigs-1.014"),
    0x2000,
  );
  assert.equal(
    translatePlatformKey({ key: "/", code: "Slash", altKey: true }, "iigs-1.014"),
    0xff00,
  );
  assert.equal(translatePlatformKey({ key: "Delete", code: "Delete" }, "iigs-1.014"), 0x08);

  // IIgs Option+/ (0xff00) toggles f9 (F_SOUND_ENABLED) in GetUserInput
  const iigsHost = new Host();
  const iigsEngine = game("return;", iigsHost, PROFILES["iigs-1.014"]);
  iigsEngine.tick();
  const beforeSound = iigsEngine.flags[9];
  iigsHost.keys.push(0xff00);
  iigsEngine.tick();
  assert.equal(iigsEngine.flags[9], beforeSound ? 0 : 1);

  // Keypad 5 (Numpad5) produces 0xf500 except on 2.089 and 2.230
  assert.equal(translatePlatformKey({ key: "Clear", code: "Numpad5" }, "2.936"), 0xf500);
  assert.equal(translatePlatformKey({ key: "5", code: "Numpad5" }, "amiga-2.202"), 0xf500);
  assert.equal(translatePlatformKey({ key: "5", code: "Numpad5" }, "iigs-1.014"), 0xf500);
  assert.equal(translatePlatformKey({ key: "Clear", code: "Numpad5" }, "2.089"), undefined);
  assert.equal(translatePlatformKey({ key: "Clear", code: "Numpad5" }, "2.230"), undefined);
});

test("Amiga right-button double-click enqueues 0x0401 when no window is open, and persistent f15 windows follow Amiga vs IIgs click rules", () => {
  class ClickHost extends Host {
    clicks: [number, number][] = [];
    takePointerClicks(): readonly (readonly [number, number])[] {
      return this.clicks.splice(0);
    }
  }
  const amigaHost = new ClickHost();
  const amigaEngine = game("set.key(1, 4, 12); return;", amigaHost, PROFILES["amiga-2.316"]);
  amigaEngine.tick();
  assert.equal(amigaEngine.pointerRightDoubleClick(), true);
  amigaEngine.tick();
  assert.equal(
    amigaEngine.controllers[12],
    1,
    "Amiga right double-click triggers 0x0401 controller",
  );

  // Non-Amiga ignores pointerRightDoubleClick
  const pcHost = new ClickHost();
  const pcEngine = game("set.key(1, 4, 12); return;", pcHost, PROFILES["2.936"]);
  pcEngine.tick();
  assert.equal(pcEngine.pointerRightDoubleClick(), false);

  // Persistent f15 window on Amiga 2.316 vs IIgs 1.014
  for (const id of ["amiga-2.316", "iigs-1.014"] as const) {
    const host = new ClickHost();
    const container = createContainer();
    container.putResource(
      "view",
      0,
      buildView({
        loops: [
          { cels: [{ width: 6, height: 12, transparentColor: 0, pixels: new Uint8Array(72) }] },
        ],
      }),
    );
    container.putResource(
      "logic",
      0,
      assembleLogic(
        `
        if (!isset(f200)) {
          set(f200);
          load.view(0);
          animate.obj(o0);
          set.view(o0, 0);
          assignn(v10, 1);
          step.size(o0, v10);
          step.time(o0, v10);
          position(o0, 20, 120);
          draw(o0);
          set(f15);
          print("persistent");
        }
        return;
      `,
        { dictionary: new Map() },
      ).payload,
    );
    const engine = new Engine(container, host, undefined, { profile: PROFILES[id] });
    engine.tick();
    assert.equal(engine.modalKind, null, `${id}: f15 print is non-blocking`);
    if (id === "amiga-2.316") {
      assert.equal(
        engine.pointerRightDoubleClick(),
        false,
        "Amiga right double-click suppressed while persistent window is open",
      );
    }

    // Clicking outside persistent window: blocks click-to-walk on Amiga (while latching f19), starts click-to-walk on IIgs
    host.clicks.push([2, 140]);
    engine.tick();
    if (id === "amiga-2.316") {
      assert.equal(
        engine.flags[19],
        1,
        "Amiga 2.316 sets f19 on click even when persistent window blocks walk",
      );
      assert.equal(engine.vars[6], 0, "Amiga 2.316 persistent window blocks click-to-walk");
    } else {
      assert.notEqual(
        engine.vars[6],
        0,
        "IIgs 1.014 persistent window allows click-to-walk outside window",
      );
    }

    // Clicking inside persistent window enqueues Enter (0x0d) -> v19 = 13
    host.clicks.push([160, 88]);
    engine.tick();
    assert.equal(engine.vars[19], 0x0d, `${id}: clicking inside persistent window enqueues Enter`);
  }
});

test("init.joy and joystick polling follow PC, Amiga and Apple IIgs binary rules", () => {
  class JoyHost extends Host {
    joy: { x: number; y: number; button1?: boolean; button2?: boolean } | null = null;
    sampleJoystick() {
      return this.joy;
    }
  }

  // 1. Disconnected joystick on PC and IIgs: init.joy opens no modal and leaves joy disabled
  for (const id of ["2.936", "iigs-1.014"] as const) {
    const host = new JoyHost();
    const engine = game("if (!isset(f200)) { set(f200); init.joy(); } return;", host, PROFILES[id]);
    engine.tick();
    assert.equal(engine.modalKind, null, `${id}: disconnected init.joy opens no modal`);
  }

  // 2. PC connected joystick calibration (50% deadzone), axis movement, and f8/v15 button FSM
  {
    const host = new JoyHost();
    host.joy = { x: 100, y: 100, button1: false, button2: false };
    const engine = game(
      `
      if (!isset(f200)) {
        set(f200);
        set.key(1, 1, 1);
        set.key(1, 2, 2);
        set.key(1, 3, 3);
        set.key(1, 4, 4);
        init.joy();
      }
      return;
    `,
      host,
      PROFILES["3.002.149"],
    );
    engine.tick();
    assert.equal(engine.modalKind, "print", "PC init.joy opens calibration prompt when connected");
    host.keys.push(0x0d); // Press Enter to calibrate at (100, 100) -> deadzone [50, 150]
    engine.tick();
    assert.equal(engine.modalKind, null, "Enter closes PC calibration prompt");

    // Deflect right (x = 160 > 150) -> direction 3
    host.joy = { x: 160, y: 100, button1: false, button2: false };
    engine.tick();
    assert.equal(engine.vars[6], 3, "PC joystick right deflection sets egoDir = 3");

    // Center (x = 100, y = 100) -> direction 0
    host.joy = { x: 100, y: 100, button1: false, button2: false };
    engine.tick();
    assert.equal(engine.vars[6], 0, "PC joystick return to center sets egoDir = 0");

    // Button 1 single-click with f8 = 0 -> immediate 0x0101 on release
    host.joy = { x: 100, y: 100, button1: true, button2: false };
    engine.tick();
    host.joy = { x: 100, y: 100, button1: false, button2: false };
    engine.tick();
    assert.equal(engine.controllers[1], 1, "PC button 1 release with f8=0 triggers 0x0101");

    // Button 1 double-click with f8 = 1 -> 0x0301 on second release
    engine.flags[8] = 1;
    engine.vars[15] = 5;
    host.joy = { x: 100, y: 100, button1: true, button2: false };
    engine.tick();
    host.joy = { x: 100, y: 100, button1: false, button2: false };
    engine.tick();
    assert.equal(
      engine.controllers[1],
      0,
      "PC button 1 first release with f8=1 waits for double-click",
    );
    host.joy = { x: 100, y: 100, button1: true, button2: false };
    engine.tick();
    host.joy = { x: 100, y: 100, button1: false, button2: false };
    engine.tick();
    assert.equal(engine.controllers[3], 1, "PC button 1 second release with f8=1 triggers 0x0301");
  }

  // 3. Amiga joystick enabled at boot without calibration modal; double-click on button 1 emits 0x0401
  {
    const host = new JoyHost();
    host.joy = { x: 0, y: -1, button1: false, button2: false };
    const engine = game(
      "if (!isset(f200)) { set(f200); set.key(1, 1, 1); set.key(1, 4, 4); init.joy(); } return;",
      host,
      PROFILES["amiga-2.202"],
    );
    engine.tick();
    assert.equal(engine.modalKind, null, "Amiga init.joy opens no modal");
    assert.equal(engine.vars[6], 1, "Amiga digital joystick up sets egoDir = 1");

    host.joy = { x: 0, y: 0, button1: false, button2: false };
    engine.flags[8] = 1;
    engine.vars[15] = 5;
    engine.tick();
    host.joy = { x: 0, y: 0, button1: true, button2: false };
    engine.tick();
    host.joy = { x: 0, y: 0, button1: false, button2: false };
    engine.tick();
    host.joy = { x: 0, y: 0, button1: true, button2: false };
    engine.tick();
    host.joy = { x: 0, y: 0, button1: false, button2: false };
    engine.tick();
    assert.equal(engine.controllers[4], 1, "Amiga button 1 double-click triggers 0x0401");
  }

  // 4. Apple IIgs joystick calibration via button press (75% deadzone) and button -> Enter (0x0d)
  {
    const host = new JoyHost();
    host.joy = { x: 100, y: 100, button1: false, button2: false };
    const engine = game(
      "if (!isset(f200)) { set(f200); init.joy(); } return;",
      host,
      PROFILES["iigs-1.014"],
    );
    engine.tick();
    assert.equal(engine.modalKind, "print", "IIgs init.joy opens calibration prompt");
    host.joy = { x: 100, y: 100, button1: true, button2: false };
    engine.tick();
    assert.equal(engine.modalKind, null, "IIgs joystick button press calibrates and closes prompt");
    // Deadzone is [25, 175]; x = 40 is still inside deadzone on IIgs (whereas < 50 is outside on PC)
    host.joy = { x: 40, y: 100, button1: false, button2: false };
    engine.tick();
    assert.equal(engine.vars[6], 0, "IIgs x=40 stays inside [25, 175] deadzone");
    // x = 20 < 25 deflects left -> direction 7
    host.joy = { x: 20, y: 100, button1: false, button2: false };
    engine.tick();
    assert.equal(engine.vars[6], 7, "IIgs x=20 deflects left (dir 7)");
    // Button press posts Enter (0x0d)
    host.joy = { x: 20, y: 100, button1: true, button2: false };
    engine.tick();
    assert.equal(engine.vars[19], 0x0d, "IIgs joystick button posts Enter (0x0d)");
  }
});
