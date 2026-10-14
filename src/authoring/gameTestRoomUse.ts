/** Rooms a test starts in or expects to enter, for optional room-deletion cleanup. */
import type { GameTest } from "../agent/gameTestFormat.ts";
import { decodeBase64 } from "../agent/gameTestSteps.ts";
import { decodeRecordedReplay } from "../agent/recordedReplay.ts";
import { decodeHostImage, decodeSave } from "../runtime/persistence.ts";
import type { AgiProfile } from "../runtime/profile.ts";

export function gameTestUsesRoom(test: GameTest, room: number, profile: AgiProfile): boolean {
  if (
    test.room === room ||
    test.expect?.["room"] === room ||
    test.steps.some((step) => {
      const until = step["until"];
      return until !== null && typeof until === "object" && "room" in until && until.room === room;
    })
  )
    return true;
  if (!test.setup) return false;
  const host = decodeHostImage(decodeBase64(test.setup.image, "test setup"));
  const state = decodeSave(host.image, profile);
  if (state.vars[0] === room || host.continuation?.frames.some((frame) => frame.logic === room))
    return true;
  if (test.setup.replay) {
    const replay = decodeRecordedReplay(test.setup.replay);
    if (replay.state.continuation?.frames.some((frame) => frame.logic === room)) return true;
  }
  return false;
}
