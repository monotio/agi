import { waitUntil } from "./async.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { providerSse } from "../../test/provider-stream.ts";
import { createStarterProject } from "../../src/authoring/starterProject.ts";
import { AgentSession } from "../src/agent/agentSession.ts";
import { GAME_DICTIONARY } from "../src/agent/stubAgent.ts";
import { Engine, HostWait, type EngineHost } from "../../src/runtime/engine.ts";

const OPENAI = { provider: "openai", apiKey: "test-placeholder", model: "gpt-6.1-sol" } as const;
const STUB = { provider: "stub", model: "offline-stub", apiKey: "" } as const;

class SeedHost implements EngineHost {
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
  saveGame(): boolean {
    return true;
  }
  restoreGame(): Uint8Array | null {
    return null;
  }
  print(): void {}
  displayAt(): void {}
  statusLine(): void {}
}

function sessionFiles(session: AgentSession): [string, number[]][] {
  return [...session.state.getFiles()]
    .map(([name, bytes]) => [name, [...bytes]] as [string, number[]])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function assertSeedIntact(session: AgentSession): void {
  const seed = createStarterProject("boilerplate");
  const want = seed.files();
  const files = session.state.getFiles();
  assert.deepEqual([...files.keys()].sort(), [...want.keys()].sort(), "file set");
  for (const [name, bytes] of files)
    assert.deepEqual([...bytes], [...want.get(name)!], `${name} intact`);
  assert.equal(session.state.profile.id, seed.profileId);
  assert.deepEqual(session.state.authoring.bindings, seed.bindings);
  assert.deepEqual([...session.state.sources.words], [...seed.sources.words]);
}

test("a failed first provider request leaves the installed Boilerplate intact and retryable", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return new Response("End this bounded seed test.", { status: 400 });
  });
  const session = new AgentSession(OPENAI, () => {});
  await assert.rejects(session.startGenesis("A quiet garden."));
  assert.equal(requests, 1);
  assertSeedIntact(session);
  assert.equal(session.state.genesisComplete, false, "nothing was handed over");

  // The untouched seed is admitted again: the retry reaches the provider.
  await assert.rejects(session.startGenesis("A quiet garden."));
  assert.equal(requests, 2, "the retry was admitted and made its own request");
  assertSeedIntact(session);
});

test("cancelling Genesis mid-request keeps the installed Boilerplate intact", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    requests++;
    await new Promise<never>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("request aborted")));
    });
    return new Response("unreachable", { status: 500 });
  });
  const session = new AgentSession(OPENAI, () => {});
  const work = session.startGenesis("A quiet garden.");
  const rejected = assert.rejects(work);
  await waitUntil(() => requests > 0, "the genesis request did not start");
  session.task.cancel();
  await rejected;
  assert.equal(requests, 1);
  assertSeedIntact(session);
});

test("Genesis refuses to reseed a session whose authored work diverged from the seed", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    if (requests !== 1) return new Response("End this bounded divergence test.", { status: 400 });
    return new Response(
      providerSse("openai", {
        id: `r${requests}`,
        output: [
          {
            type: "function_call",
            call_id: "w1",
            name: "write_logic",
            arguments: JSON.stringify({ room: 1, source: "return;" }),
          },
        ],
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  });
  const session = new AgentSession(OPENAI, () => {});
  await assert.rejects(session.startGenesis("A quiet garden."));
  assert.equal(requests, 2);
  const diverged = session.state.container.getResource("logic", 1)!;
  assert.equal(session.state.sources.logics.get(1), "return;", "the partial draft stays recorded");
  await assert.rejects(session.startGenesis("Again."), /authored work/);
  assert.equal(requests, 2, "a refused retry made no provider request");
  assert.deepEqual(
    [...session.state.container.getResource("logic", 1)!],
    [...diverged],
    "the authored room is retained for review, not silently reseeded",
  );
});

test("a session rehydrated from authored files is never reseeded or relaunched", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return new Response("no provider traffic expected", { status: 400 });
  });
  const manual = createStarterProject("boilerplate");
  const files = Object.fromEntries(manual.files());
  const session = AgentSession.fromAuthoredData(OPENAI, () => {}, files, [...manual.sources.words]);
  assert.equal(session.state.genesisComplete, true);
  assert.deepEqual(sessionFiles(session), filesOf(manual), "imported files preserved");
  await assert.rejects(session.startGenesis("Ignore the existing game."), /already holds/);
  assert.equal(requests, 0, "Genesis never launches on an existing project");
});

function filesOf(project: ReturnType<typeof createStarterProject>): [string, number[]][] {
  return [...project.files()]
    .map(([name, bytes]) => [name, [...bytes]] as [string, number[]])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

test("a second Genesis call refuses a completed session", async () => {
  const session = new AgentSession(STUB, () => {});
  await session.startGenesis("");
  const before = sessionFiles(session);
  await assert.rejects(session.startGenesis("Again."), /already holds/);
  assert.deepEqual(sessionFiles(session), before, "the completed game is untouched");
});

test("stub Genesis lands on the seeded session without stale source claims", async () => {
  const session = new AgentSession(STUB, () => {});
  await session.startGenesis("");
  const state = session.state;
  assert.ok(state.container.getResource("logic", 0), "the seeded boot remains");
  assert.ok(state.container.getResource("sound", 255), "the seeded death cue remains");
  assert.ok(state.sources.logics.get(0), "the seeded boot source claim stays honest");
  // The stub wrote its own room bytes: no seed source may claim them.
  assert.equal(state.sources.logics.get(1), undefined, "stub logic 1 carries no seed claim");
  assert.equal(state.sources.pictures.get(1), undefined, "stub picture 1 carries no seed claim");
  // WORDS.TOK was rebuilt from the stub dictionary; the claims match it.
  assert.deepEqual([...state.sources.words], [...GAME_DICTIONARY]);
});

test("the Boilerplate retained after a failed Genesis boots and plays in the real Engine", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("fail", { status: 400 }));
  const session = new AgentSession(OPENAI, () => {});
  await assert.rejects(session.startGenesis("A quiet garden."));
  const host = new SeedHost();
  const engine = new Engine(session.state.container, host, session.state.sources.words, {
    profile: session.state.profile,
  });
  for (let i = 0; i < 6; i++) engine.tick();
  assert.equal(engine.readState().room, 1);
  assert.deepEqual(engine.readObjects(), []);
  host.keys.push(0x0d);
  for (let i = 0; i < 2; i++) engine.tick();
  host.keys.push(0x1b);
  for (let i = 0; i < 3; i++) engine.tick();
  const rows = Array.from({ length: 25 }, (_, r) => engine.textRow(r)).join("\n");
  assert.equal(engine.modalKind, "menu");
  assert.match(rows, /File/);
  assert.doesNotMatch(rows, /I don't understand/);
});
