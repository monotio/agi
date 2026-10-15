import type { AgentTestReview } from "../../../src/authoring/projectTestsMerge.ts";

/** Apply is bound to the review owner captured before editor writes finish. */
export interface ReviewOwner {
  owner: {
    approve(
      keys?: undefined,
      approval?: { shownTests?: AgentTestReview["touched"] },
    ): Promise<unknown>;
  };
  session: unknown;
  game: unknown;
  review: unknown;
  writable: boolean;
}
export function captureReviewOwner(
  owner: ReviewOwner["owner"] & { pending(): unknown },
  session: unknown,
  game: unknown,
  writable: boolean,
): ReviewOwner {
  return { owner, session, game, review: owner.pending(), writable };
}
/** `shownTests` is the Tests comparison on screen at the click, captured before the writes finish. */
export async function approveCapturedReview(
  captured: ReviewOwner,
  current: () => ReviewOwner | undefined,
  flush: () => Promise<void>,
  shownTests?: AgentTestReview["touched"],
): Promise<void> {
  await flush();
  const active = current();
  if (!active?.writable) throw new Error("Return to Create to apply these changes.");
  if (
    active.owner !== captured.owner ||
    active.session !== captured.session ||
    active.game !== captured.game ||
    active.review !== captured.review
  )
    throw new Error("The game or review changed. Reopen the proposal to apply it.");
  await captured.owner.approve(undefined, shownTests ? { shownTests } : {});
}
