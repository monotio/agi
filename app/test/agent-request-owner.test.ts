import assert from "node:assert/strict";
import test from "node:test";
import {
  approveCapturedReview,
  captureReviewOwner,
  type ReviewOwner,
} from "../src/agent/agentRequestOwner.ts";

for (const changed of ["owner", "session", "game", "review", "writable"] as const) {
  test(`Apply cannot cross a changed ${changed} while editor writes finish`, async () => {
    let approvals = 0;
    const captured: ReviewOwner = {
      owner: {
        approve: async () => {
          approvals++;
        },
      },
      session: {},
      game: {},
      review: {},
      writable: true,
    };
    let active = captured;
    let release!: () => void;
    const writes = new Promise<void>((resolve) => {
      release = resolve;
    });
    const applying = approveCapturedReview(
      captured,
      () => active,
      () => writes,
    );
    active =
      changed === "writable"
        ? { ...captured, writable: false }
        : ({ ...captured, [changed]: {} } as ReviewOwner);
    release();
    await assert.rejects(applying, /Return to Create|game or review changed/);
    assert.equal(approvals, 0);
  });
}
test("Apply admits the captured review only after editor writes finish", async () => {
  const events: string[] = [];
  const captured: ReviewOwner = {
    owner: {
      approve: async () => {
        events.push("apply");
      },
    },
    session: {},
    game: {},
    review: {},
    writable: true,
  };
  await approveCapturedReview(
    captured,
    () => captured,
    async () => {
      events.push("flush");
    },
  );
  assert.deepEqual(events, ["flush", "apply"]);
});

test("the panel capture adapter refuses a replacement proposal from the same controller", async () => {
  let pending = { messageId: "first-proposal" };
  let applied: string | undefined;
  const owner = {
    pending: () => pending,
    approve: async () => {
      applied = pending.messageId;
    },
  };
  const session = {};
  const game = {};
  const captured = captureReviewOwner(owner, session, game, true);
  let release!: () => void;
  const writes = new Promise<void>((resolve) => {
    release = resolve;
  });
  const applying = approveCapturedReview(
    captured,
    () => captureReviewOwner(owner, session, game, true),
    () => writes,
  );
  pending = { messageId: "replacement-proposal" };
  release();
  await assert.rejects(applying, /review changed/);
  assert.equal(applied, undefined);
  assert.equal(captureReviewOwner(owner, session, game, true).review, pending);
});
