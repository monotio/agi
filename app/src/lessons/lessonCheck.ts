/**
 * A lesson challenge's check after a successful Keep. Studio opened from a
 * lesson carries a session: the lesson and the resource as the studio first
 * opened on it. Each Keep of that resource runs the challenge's verify() on
 * those bytes and the ones just kept. A pass awards the badge; a miss or a
 * check that throws says so and awards nothing. The Keep itself is never
 * blocked: it has already happened when this runs.
 */
import type { AgiProfile } from "../../../src/runtime/profile.ts";
import type { LessonVerifyInput, StudioLesson } from "./types.ts";

export interface LessonSession {
  readonly lesson: StudioLesson;
  /** The resource's bytes when the studio opened from the lesson. */
  readonly before: Uint8Array;
  /** The trusted annotated picture source it opened on, if any. */
  readonly beforeSource?: string | undefined;
}

/** What a Keep just saved: the resource, and its annotated source for pictures. */
export interface LessonKeep {
  readonly kind: "picture" | "view";
  readonly num: number;
  readonly after: Uint8Array;
  readonly afterSource?: string | undefined;
  readonly profile: AgiProfile;
}

export interface LessonOutcome {
  readonly ok: boolean;
  /** One sentence for the studio's notice and the card. */
  readonly message: string;
}

const KIND: Record<LessonSession["lesson"]["open"]["studio"], LessonKeep["kind"]> = {
  room: "picture",
  sprite: "view",
};

/** The challenge's verdict on a Keep, or null when the Keep is not the lesson's resource. */
export function checkLessonKeep(
  session: LessonSession,
  keep: LessonKeep,
  award: (id: string) => void,
): LessonOutcome | null {
  const { lesson } = session;
  const challenge = lesson.challenge;
  const target = lesson.open;
  const num = target.studio === "room" ? target.picture : target.view;
  if (!challenge || KIND[target.studio] !== keep.kind || num !== keep.num) return null;
  const input: LessonVerifyInput = {
    kind: keep.kind,
    num: keep.num,
    before: session.before,
    after: keep.after,
    ...(session.beforeSource !== undefined ? { beforeSource: session.beforeSource } : {}),
    ...(keep.afterSource !== undefined ? { afterSource: keep.afterSource } : {}),
    profile: keep.profile,
  };
  let verdict: ReturnType<typeof challenge.verify>;
  try {
    verdict = challenge.verify(input);
  } catch {
    return { ok: false, message: "The lesson could not check this change. Your edit is kept." };
  }
  if (!verdict.ok)
    return { ok: false, message: verdict.hint ?? `Not quite yet: ${challenge.prompt}` };
  award(lesson.id);
  return { ok: true, message: `Challenge complete: ${lesson.title}.` };
}
