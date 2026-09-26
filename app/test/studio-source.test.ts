import assert from "node:assert/strict";
import { test } from "node:test";
import { createContainer } from "../../src/container/container.ts";
import { createAgentSessionState } from "../../src/agent/tools.ts";
import { compilePictureSource } from "../../src/picture/source.ts";
import { studioPictureSource } from "../src/world/studioSource.ts";

const SOURCE = ["vis 1", "rect 0,0 5,5", "end"].join("\n");

/** A booted snapshot and an authoring session that agree on PIC 4. */
function fixture() {
  const game = createContainer();
  const session = createAgentSessionState(game);
  const bytes = compilePictureSource(SOURCE, { profile: session.profile }).bytes;
  game.putResource("picture", 4, bytes);
  session.sources.pictures.set(4, SOURCE);
  return { game, session, bytes };
}

test("Studio trusts the agent's picture text only while it compiles to the booted bytes", () => {
  const { game, session, bytes } = fixture();
  const files = Object.fromEntries(game.files);
  const trusted = studioPictureSource({ files, profile: session.profile }, 4, session);
  assert.deepEqual([...(trusted?.bytes ?? [])], [...bytes]);
  assert.equal(trusted?.authoredSource, SOURCE);

  // Text that no longer compiles to the stored picture is dropped.
  session.sources.pictures.set(4, ["vis 2", "rect 0,0 5,5", "end"].join("\n"));
  assert.equal(
    studioPictureSource({ files, profile: null }, 4, session)?.authoredSource,
    undefined,
  );

  // A booted snapshot that differs from the session's resource is not the
  // picture the text describes, even when the text matches the session.
  session.sources.pictures.set(4, SOURCE);
  const booted = createContainer();
  booted.putResource("picture", 4, Uint8Array.of(0xf0, 1, 0xff));
  const other = studioPictureSource(
    { files: Object.fromEntries(booted.files), profile: null },
    4,
    session,
  );
  assert.deepEqual([...(other?.bytes ?? [])], [0xf0, 1, 0xff]);
  assert.equal(other?.authoredSource, undefined);
  assert.ok(other?.profile, "a profile is detected when the scan had none");
});
