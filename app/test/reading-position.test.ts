import assert from "node:assert/strict";
import { test } from "node:test";
import { shallowRef } from "vue";
import { useReadingPosition } from "../src/shell/useReadingPosition.ts";

function feed(): { scrollHeight: number; clientHeight: number; scrollTop: number } {
  let scrollTop = 0;
  return {
    scrollHeight: 1000,
    clientHeight: 300,
    get scrollTop() {
      return scrollTop;
    },
    set scrollTop(value: number) {
      scrollTop = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight));
    },
  };
}

test("new preview content preserves a reader's scroll before the scroll event arrives", () => {
  const node = feed();
  const position = useReadingPosition(shallowRef(node as HTMLElement));
  position.jumpToLatest();
  // A reveal or wheel scroll moves first; its scroll event can follow a resize callback.
  node.scrollTop = 200;
  node.scrollHeight = 1200;
  position.followLatest();
  assert.equal(node.scrollTop, 200);
  assert.equal(position.following.value, false);
  position.jumpToLatest();
  assert.equal(position.following.value, true);
  assert.equal(node.scrollTop, 900);
});

test("new preview content follows while the reader remains at the latest message", () => {
  const node = feed();
  const position = useReadingPosition(shallowRef(node as HTMLElement));
  position.jumpToLatest();
  node.scrollHeight = 1200;
  position.followLatest();
  assert.equal(node.scrollTop, 900);
  assert.equal(position.following.value, true);
});
