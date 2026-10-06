/**
 * A Studio's side of a lesson: the session its request carries (when the Help
 * guide opened it from a lesson), the check each finished edit runs
 * (lessonCheck.ts), and the save notice that reports the verdict. Studio's
 * harness has no Create centre, and so no lesson.
 */
import { computed, shallowRef } from "vue";
import { useOptionalCreateCenter } from "../shell/useCreateWorkspace.ts";
import type { StudioNotice } from "../studio/useStudioNotice.ts";
import {
  checkLessonKeep,
  type LessonSession,
  type LessonKeep,
  type LessonOutcome,
} from "./lessonCheck.ts";
import { useLessonBadges } from "./lessonStorage.ts";

export function useStudioLesson(request?: () => LessonSession | null | undefined) {
  const center = useOptionalCreateCenter();
  const badges = useLessonBadges();
  const session = computed(() =>
    request ? (request() ?? null) : (center?.studio.value?.lesson ?? null),
  );
  /** The last checked edit's verdict; null when it had none. */
  const outcome = shallowRef<LessonOutcome | null>(null);

  /** Check the current draft after an edit or when a lesson opens, with what it kept. */
  function check(keep: LessonKeep): void {
    const current = session.value;
    outcome.value = current ? checkLessonKeep(current, keep, badges.award) : null;
  }

  /** The Keep's notice for `subject` ("PIC 1"), with the lesson's verdict when there is one. */
  function keptNotice(subject: string): StudioNotice {
    const verdict = outcome.value;
    if (!verdict) return { tone: "ok", text: `Kept ${subject}. The game shows the edit now.` };
    return { tone: verdict.ok ? "ok" : "warn", text: `Kept ${subject}. ${verdict.message}` };
  }

  return { session, outcome, check, keptNotice };
}
