/** Conversation feeds follow new text until the reader scrolls back. */
import { ref, type ShallowRef } from "vue";
export function useReadingPosition(element: Readonly<ShallowRef<HTMLElement | null>>) {
  const following = ref(true);
  let lastTop = 0;
  function readPosition(): void {
    const node = element.value;
    if (!node) return;
    const nearLatest = node.scrollHeight - node.clientHeight - node.scrollTop < 24;
    if (nearLatest) following.value = true;
    else if (node.scrollTop < lastTop) following.value = false;
    lastTop = node.scrollTop;
  }
  function jumpToLatest(): void {
    following.value = true;
    const node = element.value;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
    lastTop = node.scrollTop;
  }
  function followLatest(): void {
    // Resize callbacks can arrive before the scroll event from a reader's reveal or wheel.
    readPosition();
    if (following.value) jumpToLatest();
  }
  return { following, readPosition, jumpToLatest, followLatest };
}
