import { onScopeDispose, ref } from "vue";

/** The current time, refreshed every half minute, for "12 min ago" labels. */
export function useNow() {
  const now = ref(Date.now());
  const timer = setInterval(() => (now.value = Date.now()), 30_000);
  onScopeDispose(() => clearInterval(timer));
  return now;
}
