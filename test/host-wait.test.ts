import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine, HostWait, type EngineHost } from "../src/runtime/engine.ts";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { decodeSave } from "../src/runtime/persistence.ts";

/**
 * Resumable host interactions (docs/dont-prevent-application.md stage 1). A
 * host that cannot answer synchronously — the bridge worker, whose reply
 * lands on a later event-loop pass — throws HostWait out of the host method.
 * The engine parks the live logic stack, stays inspectable meanwhile, and
 * resumes exactly where it stopped once `deliverHostAnswer` feeds the reply
 * into a later tick.
 */

/** Every interaction service suspends; the test delivers each answer. */
class SuspendingHost implements EngineHost {
  prints: string[] = [];
  writes: { slot: number | undefined; bytes: Uint8Array }[] = [];
  saved: Uint8Array | null = null;
  quitCalls = 0;
  prepareCalls: number[] = [];

  print(text: string): void {
    this.prints.push(text);
  }
  displayAt(): void {}
  statusLine(): void {}
  takeInputLine(): string | null {
    return null;
  }
  takeKeys(): number[] {
    return [];
  }
  waitKey(): number {
    throw new HostWait();
  }
  promptString(): string {
    throw new HostWait();
  }
  promptNumber(): number {
    throw new HostWait();
  }
  listSaveGames(): { slot: number; bytes: Uint8Array }[] {
    throw new HostWait();
  }
  promptSaveDescription(): string | null {
    throw new HostWait();
  }
  saveGame(bytes: Uint8Array, slot?: number): boolean {
    this.writes.push({ bytes, slot });
    throw new HostWait();
  }
  restoreGame(): Uint8Array | null {
    throw new HostWait();
  }
  prepareRoom(room: number): boolean {
    this.prepareCalls.push(room);
    throw new HostWait();
  }
  quit(): void {
    this.quitCalls++;
  }
}

function gameWith(logic0: string) {
  const container = createContainer();
  container.putResource("logic", 0, assembleLogic(logic0, { dictionary: new Map() }).payload);
  return container;
}

test("have.key suspends the condition list, then resumes with the delivered key once", () => {
  const engine = new Engine(
    gameWith(`
      increment(v60);
      wait: if (!have.key()) { goto wait; }
      assignv(v100,v19);
      assignn(v101, 7);
      return;
    `),
    new SuspendingHost(),
    new Map(),
  );
  engine.tick();
  assert.equal(engine.vars[60], 1, "the pass ran up to the wait");
  assert.equal(engine.hostInteraction?.kind, "key");
  assert.equal(engine.hostInteractionPending, true);
  assert.equal(engine.continuationPending, true, "the logic stack is parked");

  // The suspended pass stays inspectable; serialization still describes it.
  assert.ok(engine.serialize().length > 0);

  engine.deliverHostAnswer(0x62);
  engine.tick();
  assert.equal(engine.hostInteractionPending, false);
  assert.equal(engine.vars[100], 0x62, "the delivered key reached the IF once");
  assert.equal(engine.vars[60], 1, "the resumed pass did not re-run earlier actions");
  assert.equal(engine.vars[101], 7, "execution continued past the resumed IF");
});

test("get.num suspends and the delivered number stores into its variable", () => {
  const engine = new Engine(
    gameWith(`#message 1 "How many?"\nget.num(1, v100);\nassignn(v101, 7);\nreturn;`),
    new SuspendingHost(),
    new Map(),
  );
  engine.tick();
  assert.equal(engine.hostInteraction?.kind, "getnum");
  assert.equal(engine.vars[100], 0, "nothing stored before the answer");

  engine.deliverHostAnswer(0x142);
  engine.tick();
  assert.equal(engine.vars[100], 0x42, "the low byte stores, as get.num specifies");
  assert.equal(engine.vars[101], 7);
});

test("get.string suspends and the delivered reply stores into its slot", () => {
  const engine = new Engine(
    gameWith(`#message 1 "Name?"\nget.string(s1, 1, 0, 0, 10);\nassignn(v101, 7);\nreturn;`),
    new SuspendingHost(),
    new Map(),
  );
  engine.tick();
  assert.equal(engine.hostInteraction?.kind, "getstring");

  engine.deliverHostAnswer("LONELY HERO OF THE WASTES");
  engine.tick();
  assert.equal(engine.strings[1], "LONELY HER", "the reply is bounded by maxLen");
  assert.equal(engine.vars[101], 7);
});

test("save.game drives its selector one suspended host need at a time", () => {
  const host = new SuspendingHost();
  const engine = new Engine(gameWith(`save.game();\nassignn(v100, 99);\nreturn;`), host, new Map());
  const step = (answer: unknown) => {
    engine.deliverHostAnswer(answer);
    engine.tick();
  };

  engine.tick();
  assert.equal(engine.hostInteraction?.kind, "saveDialog");
  assert.equal(engine.modalKind, "save", "the selector stays up while suspended");

  step([]); // list -> selector key
  assert.equal(engine.hostInteraction?.kind, "saveDialog");
  step(13); // select slot 1 -> description
  step("Mid-flight"); // description -> overwrite/confirm key
  step(13); // confirm -> write
  assert.equal(engine.hostInteractionPending, true, "the write itself is suspended");
  step(true); // write -> done
  assert.equal(engine.hostInteractionPending, false);
  assert.equal(host.writes.length, 1, "the file image was written exactly once");
  assert.equal(decodeSave(host.writes[0]!.bytes, engine.profile).description, "Mid-flight");
  assert.equal(engine.vars[100], 99, "the suspended pass resumed past save.game");
});

test("abortInteraction drops a suspended selector and restores the covered text", () => {
  const engine = new Engine(
    gameWith(`save.game();\nassignn(v100, 99);\nreturn;`),
    new SuspendingHost(),
    new Map(),
  );
  const before = engine.textCells.slice();
  engine.tick();
  engine.deliverHostAnswer([]);
  engine.tick();
  assert.equal(engine.modalKind, "save");

  engine.abortInteraction();
  assert.equal(engine.hostInteractionPending, false);
  assert.equal(engine.modalKind, null);
  assert.equal(engine.continuationPending, false, "the parked stack went with it");
  assert.deepEqual(
    engine.textCells.slice(80, 23 * 80),
    before.slice(80, 23 * 80),
    "cells under the selector are restored",
  );

  // The next tick starts a fresh pass: save.game runs again and re-suspends.
  engine.tick();
  assert.equal(engine.hostInteraction?.kind, "saveDialog");
});

test("quit confirmation suspends; the delivered key resumes the session action", () => {
  const host = new SuspendingHost();
  const engine = new Engine(gameWith(`quit(0);\nassignn(v100, 99);\nreturn;`), host, new Map());
  engine.tick();
  assert.equal(engine.hostInteraction?.kind, "confirm");
  assert.ok(
    host.prints.some((text) => text.includes("Quit")),
    "the confirm window is up",
  );

  engine.deliverHostAnswer(27); // Escape: declined, the game goes on
  engine.tick();
  assert.equal(engine.vars[100], 99);
  assert.equal(host.quitCalls, 0);
});

test("a quit confirmed through the suspended wait terminates the game", () => {
  const host = new SuspendingHost();
  const engine = new Engine(gameWith(`quit(0);\nreturn;`), host, new Map());
  engine.tick();
  assert.equal(engine.hostInteraction?.kind, "confirm");

  engine.deliverHostAnswer(13); // Enter
  engine.tick();
  assert.equal(host.quitCalls, 1);
});

test("new.room suspends on prepareRoom and enters the room on delivery", () => {
  const host = new SuspendingHost();
  const engine = new Engine(
    gameWith(
      `increment(v60);\nif (equaln(v0, 0)) { new.room(5); }\nif (equaln(v0, 5)) { assignn(v101, 7); }\nreturn;`,
    ),
    host,
    new Map(),
  );
  engine.tick();
  assert.equal(engine.hostInteraction?.kind, "room");
  assert.deepEqual(host.prepareCalls, [5]);
  assert.equal(engine.vars[0], 0, "still in the old room while the host authors");

  engine.patchResource("logic", 5, assembleLogic("return;", { dictionary: new Map() }).payload);
  engine.deliverHostAnswer(true);
  engine.tick();
  assert.equal(engine.vars[0], 5);
  engine.tick();
  assert.equal(engine.vars[101], 7, "the fresh pass in the new room ran");
  assert.deepEqual(host.prepareCalls, [5], "the destination was authored once");
});

test("declined prepareRoom keeps the old room and prints the edge message", () => {
  const host = new SuspendingHost();
  const engine = new Engine(
    gameWith(`increment(v60);\nif (equaln(v60, 1)) { new.room(5); }\nreturn;`),
    host,
    new Map(),
  );
  engine.tick();
  assert.equal(engine.hostInteraction?.kind, "room");

  engine.deliverHostAnswer(false);
  engine.tick();
  assert.equal(engine.vars[0], 0, "a refused room keeps the player put");
  assert.ok(
    host.prints.some((text) => text.includes("not available")),
    "the edge message prints",
  );
});

test("reenterRoom suspends on prepareRoom and completes on a later poll", () => {
  const host = new SuspendingHost();
  const engine = new Engine(gameWith(`increment(v60);\nreturn;`), host, new Map());
  engine.tick();
  assert.equal(engine.vars[60], 1);

  assert.throws(() => engine.reenterRoom(9), HostWait);
  engine.tick();
  assert.equal(engine.vars[0], 0, "parked on the room answer");
  assert.equal(engine.vars[60], 1, "no pass ran while parked");

  engine.patchResource("logic", 9, assembleLogic("return;", { dictionary: new Map() }).payload);
  engine.deliverHostAnswer(true);
  engine.tick();
  assert.equal(engine.vars[0], 9);
});

test("restart confirmation suspends; Enter restarts", () => {
  const engine = new Engine(
    gameWith(
      `increment(v60);\nif (equaln(v60, 1)) { restart.game(); }\nassignn(v100, 99);\nreturn;`,
    ),
    new SuspendingHost(),
    new Map(),
  );
  engine.tick();
  assert.equal(engine.hostInteraction?.kind, "confirm");

  engine.deliverHostAnswer(13); // Enter: accepted
  engine.tick();
  assert.equal(engine.modalKind, null);
  assert.equal(engine.vars[100], 0, "restart cleared the run before the assign");
});

test("suspended restore selector applies the image", () => {
  const engine = new Engine(
    gameWith(`increment(v60);\nif (equaln(v60, 3)) { restore.game(); }\nreturn;`),
    new SuspendingHost(),
    new Map(),
  );
  engine.tick();
  const image = engine.serialize();
  engine.tick();
  engine.tick();
  assert.equal(engine.vars[60], 3);
  assert.equal(engine.hostInteraction?.kind, "saveDialog");

  engine.deliverHostAnswer([{ slot: 1, bytes: image }]);
  engine.tick();
  engine.deliverHostAnswer(13); // Enter selects slot 1
  engine.tick();
  assert.equal(engine.hostInteraction?.kind, "saveDialog", "parked on the read");

  engine.deliverHostAnswer(image);
  engine.tick();
  assert.equal(engine.hostInteractionPending, false);
  assert.equal(engine.modalKind, null);
  assert.equal(engine.vars[60], 1, "the restored image's cycle state");
  engine.tick();
  assert.equal(engine.vars[60], 2);
});

test("a declined key wait (answer 0) does not hang", () => {
  const engine = new Engine(
    gameWith(
      `increment(v60);\nwait: if (!have.key()) { goto wait; }\nassignv(v100,v19);\nassignn(v101, 7);\nreturn;`,
    ),
    new SuspendingHost(),
    new Map(),
  );
  engine.tick();
  assert.equal(engine.hostInteraction?.kind, "key");

  engine.deliverHostAnswer(0);
  engine.tick();
  // Answer 0 presses nothing: the wait either re-parks or completes.
  if (engine.hostInteractionPending) {
    engine.deliverHostAnswer(0x62);
    engine.tick();
  }
  assert.equal(engine.vars[100], 0x62);
  assert.equal(engine.vars[101], 7);
});
