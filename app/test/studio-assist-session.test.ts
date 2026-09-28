import { providerSse } from "../../test/provider-stream.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentSession } from "../src/agent/agentSession.ts";
import { createAgentSessionState, type AgentSessionState } from "../../src/agent/agentState.ts";
import { STUDIO_ASSIST_TASK_TOOLS } from "../../src/agent/tools.ts";
import type { StudioFocus } from "../../src/agent/studioAssistTools.ts";
import { pictureAssistScope, viewAssistScope } from "../../src/studio/assistScope.ts";
import { compileEditDocument } from "../../src/studio/editValidation.ts";
import { parsePictureDocument } from "../../src/studio/pictureDocument.ts";
import { openSprite } from "../../src/view/spriteDocument.ts";
import { DEFAULT_V2_PROFILE, PROFILES } from "../../src/runtime/profile.ts";
import { parseView } from "../../src/view/view.ts";
import { BRIDGE_SOURCE, DOT_EGO, ROBOT_VIEW } from "../../test/studioAssistFixtures.ts";
import { STUB_DECLINE_TEXT } from "../src/agent/studioAssist.ts";

function state(): AgentSessionState {
  const session = createAgentSessionState();
  session.container.putResource("view", 0, DOT_EGO);
  return session;
}

function bridgeFocus(): StudioFocus {
  const compiled = compileEditDocument(
    parsePictureDocument(BRIDGE_SOURCE).document,
    DEFAULT_V2_PROFILE,
  );
  return {
    scope: pictureAssistScope({
      num: 1,
      compiled,
      targetIds: ["bridge"],
      lens: "walk",
    }),
    draft: () => ({ kind: "picture", source: BRIDGE_SOURCE }),
    lens: "walk",
  };
}

function robotFocus(): StudioFocus {
  return {
    scope: viewAssistScope({
      num: 2,
      document: openSprite(ROBOT_VIEW, DEFAULT_V2_PROFILE),
      targetCels: [
        { loop: 1, cel: 0 },
        { loop: 1, cel: 1 },
      ],
    }),
    draft: () => ({ kind: "view", payload: ROBOT_VIEW }),
  };
}

function stubSession(events: string[] = []) {
  const live = state();
  const files = [...live.getFiles()].map(([name, bytes]) => [name, [...bytes]]);
  const session = new AgentSession(
    { provider: "stub", apiKey: "", model: "offline-stub" },
    (_kind, detail) => events.push(detail),
    live,
  );
  const untouched = () =>
    assert.deepEqual(
      [...live.getFiles()].map(([name, bytes]) => [name, [...bytes]]),
      files,
      "a Studio assist request never writes the session's resources",
    );
  return { session, untouched };
}

test("stub: 'make walkable' opens the barrier under the selection with control values only", async () => {
  const { session, untouched } = stubSession();
  const result = await session.runStudioAssist({
    instruction: "Make this bridge walkable without changing the art",
    focus: bridgeFocus(),
  });
  assert.deepEqual([result.proposals, result.refusals], [1, 0]);
  const candidate = result.candidate!;
  assert.equal(candidate.kind, "picture");
  assert.equal(candidate.candidateId, "c1");
  assert.match(
    candidate.kind === "picture" ? candidate.draft.source : "",
    // The banks' box (x 60..99, y 120..139) turns to water, the value beside
    // them: control 0 -> 3 passes the default Walk locks.
    /# @item bridge-walk "Bridge walkway" walk\nvis off\npri 3\nline 60,120 99,120\n/,
  );
  assert.equal(result.text, "Proposed: Make this bridge walkable without changing the art.");
  untouched();
});

test("stub: 'eyes blue' recolours loop 1 only", async () => {
  const { session, untouched } = stubSession();
  const result = await session.runStudioAssist({
    instruction: "Make the robot's eyes blue on the left-facing loop",
    focus: robotFocus(),
  });
  const candidate = result.candidate!;
  assert.equal(candidate.kind, "view");
  const view = parseView(candidate.kind === "view" ? candidate.draft.payload : new Uint8Array());
  assert.deepEqual(
    view.loops.map((loop) => loop.cels.map((cel) => [...cel.pixels].filter((p) => p === 1).length)),
    [
      [0, 0],
      [1, 1],
    ],
  );
  untouched();
});

test("stub: a proposal that touches locked art is refused and the retry is the candidate", async () => {
  const events: string[] = [];
  const { session, untouched } = stubSession(events);
  const result = await session.runStudioAssist({
    instruction: "bad: repaint the bridge, then make it walkable",
    focus: bridgeFocus(),
  });
  assert.deepEqual([result.proposals, result.refusals], [2, 1]);
  assert.equal(result.candidate?.candidateId, "c2");
  assert.ok(
    events.some((line) =>
      /propose_edit -> Refused; nothing was proposed: the art \(visual plane\) is locked/.test(
        line,
      ),
    ),
    events.join("\n"),
  );
  untouched();
});

test("stub: an impossible request reads the selection and declines with its reason", async () => {
  const events: string[] = [];
  const { session, untouched } = stubSession(events);
  const result = await session.runStudioAssist({
    instruction: "impossible: walk onto the ceiling",
    focus: bridgeFocus(),
  });
  assert.equal(result.candidate, null);
  assert.deepEqual([result.proposals, result.refusals], [0, 0]);
  assert.equal(result.text, STUB_DECLINE_TEXT);
  assert.ok(events.some((line) => line.startsWith("[Studio] read_edit_context ->")));
  untouched();
});

test("a provider turn offers only the Studio task tools and is denied anything else", async (t) => {
  const bodies: Record<string, unknown>[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    const output =
      bodies.length === 1
        ? [
            {
              type: "function_call",
              call_id: "w",
              name: "write_picture",
              arguments: JSON.stringify({ room: 1, source: "vis 1\nfill 0,0\nend" }),
            },
          ]
        : [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "I cannot write pictures here." }],
            },
          ];
    return new Response(providerSse("openai", { id: `s${bodies.length}`, output }), {
      headers: { "Content-Type": "text/event-stream" },
    });
  });
  const live = state();
  const session = new AgentSession(
    { provider: "openai", apiKey: "test-placeholder", model: "test" },
    () => {},
    live,
  );
  const result = await session.runStudioAssist({
    instruction: "Make this bridge walkable",
    focus: bridgeFocus(),
  });
  assert.equal(result.candidate, null);
  assert.equal(result.text, "I cannot write pictures here.");
  const choice = bodies[0]!["tool_choice"] as { tools: { name: string }[] };
  assert.deepEqual(
    choice.tools.map((tool) => tool.name),
    [...STUDIO_ASSIST_TASK_TOOLS],
  );
  assert.match(
    JSON.stringify(bodies[1]!["input"]),
    /'write_picture' is not available in this phase/,
  );
  assert.equal(live.container.getResource("picture", 1), null);
});

test("the request's tools read the draft under the Studio's profile, not the session's", async () => {
  // A pen is not available before AGI 2.4: the same draft compiles under the
  // session's 2.936 and is refused under the Studio's 2.089.
  const penSource = BRIDGE_SOURCE.replace(
    "end\n",
    ['# @item dot "Dot" art', "vis 1", "pen 0", "plot 10,10", "# @end", "end", ""].join("\n"),
  );
  const focus = (profile?: StudioFocus["profile"]): StudioFocus => ({
    ...bridgeFocus(),
    draft: () => ({ kind: "picture", source: penSource }),
    ...(profile ? { profile } : {}),
  });
  const read = async (profile?: StudioFocus["profile"]) => {
    const events: string[] = [];
    const { session } = stubSession(events);
    await session.runStudioAssist({
      instruction: "impossible: walk onto the ceiling",
      focus: focus(profile),
    });
    return events.find((line) => line.startsWith("[Studio] read_edit_context ->"));
  };
  assert.doesNotMatch((await read())!, /pen is not available/);
  assert.match((await read(PROFILES["2.089"]))!, /pen is not available in profile 2\.089/);
});
