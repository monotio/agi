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

test("Studio gets the booted snapshot's container files, for the actor probe's VIEWs", () => {
  const { game, session } = fixture();
  game.putResource("view", 2, Uint8Array.of(1, 1, 1, 0, 0));
  const files = Object.fromEntries(game.files);
  const source = studioPictureSource({ files, profile: session.profile }, 4, session);
  assert.deepEqual([...(source?.files.keys() ?? [])].sort(), Object.keys(files).sort());
  for (const [name, bytes] of source?.files ?? []) assert.equal(bytes, files[name]);
});

test("without a live session, Studio trusts the stored project's picture text by the same rule", () => {
  const { game, bytes } = fixture();
  const files = Object.fromEntries(game.files);
  const stored = (text: string) => ({ sources: { pictures: [[4, text]] } });
  // A catalog game plays without a session: its stored sources describe the bytes.
  assert.equal(
    studioPictureSource({ files, profile: null }, 4, undefined, stored(SOURCE))?.authoredSource,
    SOURCE,
  );
  // Text that compiles to other bytes, a picture it does not name, or no
  // sources at all leave Studio disassembling.
  const other = ["vis 2", "rect 0,0 5,5", "end"].join("\n");
  for (const state of [stored(other), { sources: { pictures: [[5, SOURCE]] } }, {}, undefined]) {
    const source = studioPictureSource({ files, profile: null }, 4, undefined, state);
    assert.deepEqual([...(source?.bytes ?? [])], [...bytes]);
    assert.equal(source?.authoredSource, undefined);
  }
  // A live session speaks for the game: its missing text is not filled from storage.
  const session = createAgentSessionState(game);
  assert.equal(
    studioPictureSource({ files, profile: null }, 4, session, stored(SOURCE))?.authoredSource,
    undefined,
  );
});
