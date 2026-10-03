import assert from "node:assert/strict";
import { test } from "node:test";
import { reactive } from "vue";
import {
  createCommandRegistry,
  type CommandContext,
} from "../src/shell/commands/commandRegistry.ts";
import { registerDefaultCommands } from "../src/shell/commands/defaultCommands.ts";

function context(): { -readonly [K in keyof CommandContext]: CommandContext[K] } {
  return reactive({
    editorFocus: false,
    gameFocus: false,
    textInputFocus: false,
    dialogOpen: false,
    debugging: false,
  });
}
function key(name: string, extra: Partial<KeyboardEvent> = {}) {
  let prevented = false;
  const event = {
    key: name,
    code: "",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    repeat: false,
    defaultPrevented: false,
    preventDefault() {
      prevented = true;
    },
    ...extra,
  } as KeyboardEvent;
  return { event, prevented: () => prevented };
}

test("dispatch respects reactive contexts, input ownership, platform, repeats and disposal", () => {
  const ctx = context();
  const registry = createCommandRegistry(() => ctx, true);
  let calls = 0;
  const off = registry.register({
    id: "open",
    title: "Open",
    keys: [{ key: "Mod+P" }],
    when: (c) => !c.dialogOpen,
    run: () => {
      calls++;
    },
  });
  const chord = key("p", { metaKey: true });
  assert.equal(registry.dispatch(chord.event), true);
  assert.equal(chord.prevented(), true);
  assert.equal(calls, 1);
  assert.equal(registry.dispatch(key("p", { ctrlKey: true }).event), false);
  assert.equal(registry.dispatch(key("p", { metaKey: true, shiftKey: true }).event), false);
  ctx.textInputFocus = true;
  assert.equal(registry.dispatch(chord.event), false);
  ctx.textInputFocus = false;
  ctx.gameFocus = true;
  assert.equal(registry.dispatch(chord.event), false);
  ctx.gameFocus = false;
  ctx.dialogOpen = true;
  assert.equal(registry.execute("open"), false);
  ctx.dialogOpen = false;
  assert.equal(registry.dispatch(key("p", { metaKey: true, repeat: true }).event), true);
  assert.equal(calls, 1);
  assert.equal(registry.dispatch(key("p", { metaKey: true, isComposing: true }).event), false);
  assert.equal(registry.dispatch(key("p", { metaKey: true, defaultPrevented: true }).event), false);
  off();
  off();
  assert.equal(registry.commands.value.length, 0);
  assert.equal(registry.dispatch(chord.event), false);
});

test("explicit input/game bindings work; disabled commands never consume keys; duplicate ids fail", () => {
  const ctx = context();
  ctx.textInputFocus = true;
  ctx.gameFocus = true;
  const registry = createCommandRegistry(() => ctx, false);
  registry.register({
    id: "palette",
    title: "Commands",
    keys: [{ key: "Mod+Shift+P", textInput: true, game: true }],
    run() {},
  });
  assert.equal(registry.dispatch(key("P", { ctrlKey: true, shiftKey: true }).event), true);
  registry.register({
    id: "step",
    title: "Step",
    keys: [{ key: "F10", game: true, textInput: true }],
    when: () => true,
  });
  assert.equal(registry.enabled("step"), false);
  assert.equal(registry.dispatch(key("F10").event), false);
  assert.throws(() => registry.register({ id: "palette", title: "Duplicate" }));
});

test("defaults preserve text undo and dialogs, and dispose all bindings", () => {
  const ctx = context();
  const registry = createCommandRegistry(() => ctx, false);
  const calls: string[] = [];
  const off = registerDefaultCommands(registry, {
    quickOpen() {
      calls.push("open");
    },
    palette() {
      calls.push("palette");
    },
    undo() {
      calls.push("undo");
    },
    focusGame() {
      calls.push("game");
    },
  });
  assert.equal(registry.dispatch(key("p", { ctrlKey: true }).event), true);
  assert.equal(registry.dispatch(key("P", { ctrlKey: true, shiftKey: true }).event), true);
  assert.equal(registry.dispatch(key("z", { ctrlKey: true }).event), true);
  ctx.editorFocus = true;
  ctx.textInputFocus = true;
  assert.equal(registry.dispatch(key("z", { ctrlKey: true }).event), true);
  ctx.editorFocus = false;
  assert.equal(registry.dispatch(key("z", { ctrlKey: true }).event), false);
  assert.equal(registry.dispatch(key("`", { ctrlKey: true }).event), true);
  ctx.dialogOpen = true;
  assert.equal(registry.dispatch(key("p", { ctrlKey: true }).event), false);
  assert.equal(registry.enabled("debug.stepOver"), false);
  assert.deepEqual(calls, ["open", "palette", "undo", "undo", "game"]);
  off();
  assert.equal(registry.commands.value.length, 0);
});

test("debug bindings can run from game and editor zones when the host supplies actions", () => {
  const ctx = context();
  const registry = createCommandRegistry(() => ctx, true);
  const calls: string[] = [];
  registerDefaultCommands(registry, {
    run() {
      calls.push("run");
    },
    stepOver() {
      calls.push("step");
    },
    breakpoint() {
      calls.push("breakpoint");
    },
  });
  ctx.gameFocus = true;
  assert.equal(registry.dispatch(key("F5").event), true);
  ctx.debugging = true;
  assert.equal(registry.dispatch(key("F10").event), true);
  ctx.gameFocus = false;
  ctx.editorFocus = true;
  ctx.textInputFocus = true;
  assert.equal(registry.dispatch(key("F9").event), true);
  assert.deepEqual(calls, ["run", "step", "breakpoint"]);
});

test("the global dispatcher mounts once, stops handled keys and releases its listener", () => {
  const registry = createCommandRegistry(context, false);
  let calls = 0;
  let listener: ((event: KeyboardEvent) => void) | undefined;
  let removals = 0;
  const target = {
    addEventListener(type: string, handler: (event: KeyboardEvent) => void, capture: boolean) {
      assert.equal(type, "keydown");
      assert.equal(capture, true);
      listener = handler;
    },
    removeEventListener(type: string, handler: (event: KeyboardEvent) => void, capture: boolean) {
      assert.equal(type, "keydown");
      assert.equal(capture, true);
      assert.equal(handler, listener);
      listener = undefined;
      removals++;
    },
  } as unknown as Pick<Window, "addEventListener" | "removeEventListener">;
  registry.register({
    id: "open",
    title: "Open",
    keys: [{ key: "Mod+P" }],
    run() {
      calls++;
    },
  });
  const off = registry.mount(target);
  assert.throws(() => registry.mount(target), /already mounted/);
  let stopped = false;
  listener?.(
    key("p", {
      ctrlKey: true,
      stopImmediatePropagation() {
        stopped = true;
      },
    }).event,
  );
  assert.equal(calls, 1);
  assert.equal(stopped, true);
  off();
  off();
  assert.equal(removals, 1);
  assert.equal(listener, undefined);
  const again = registry.mount(target);
  again();
  assert.equal(removals, 2);
});

test("workspace Undo and Redo serve editor text and canvas zones while other inputs retain native undo", () => {
  const ctx = context();
  const registry = createCommandRegistry(() => ctx, false);
  const calls: string[] = [];
  registerDefaultCommands(registry, {
    undo() {
      calls.push("undo");
    },
    redo() {
      calls.push("redo");
    },
  });
  ctx.editorFocus = true;
  assert.equal(registry.dispatch(key("z", { ctrlKey: true }).event), true);
  assert.equal(registry.dispatch(key("Z", { ctrlKey: true, shiftKey: true }).event), true);
  ctx.textInputFocus = true;
  assert.equal(registry.dispatch(key("z", { ctrlKey: true }).event), true);
  assert.equal(registry.dispatch(key("Z", { ctrlKey: true, shiftKey: true }).event), true);
  ctx.editorFocus = false;
  ctx.textInputFocus = false;
  ctx.gameFocus = true;
  assert.equal(registry.dispatch(key("z", { ctrlKey: true }).event), true);
  ctx.textInputFocus = true;
  assert.equal(registry.dispatch(key("z", { ctrlKey: true }).event), false);
  assert.deepEqual(calls, ["undo", "redo", "undo", "redo", "undo"]);
});

test("Focus chords consume the prefix, require an eligible second key and cancel on context changes", () => {
  const ctx = context();
  const registry = createCommandRegistry(() => ctx, true);
  let calls = 0;
  registry.register({
    id: "focus",
    title: "Focus",
    keys: [{ key: "Mod+K Z", textInput: true }],
    when: (c) => !c.dialogOpen,
    run() {
      calls++;
    },
  });
  assert.equal(registry.dispatch(key("k", { metaKey: true }).event), true);
  assert.equal(calls, 0);
  assert.equal(registry.dispatch(key("z").event), true);
  assert.equal(calls, 1);
  registry.dispatch(key("k", { metaKey: true }).event);
  assert.equal(registry.dispatch(key("x").event), false);
  assert.equal(registry.dispatch(key("z").event), false);
  registry.dispatch(key("k", { metaKey: true }).event);
  ctx.dialogOpen = true;
  assert.equal(registry.dispatch(key("z").event), false);
  assert.equal(calls, 1);
});

test("the agent owns approval keys while its composer has focus", () => {
  const ctx = { ...context(), agentFocus: true };
  const registry = createCommandRegistry(() => ctx, true);
  let played = 0;
  registerDefaultCommands(registry, { play: () => played++ });
  assert.equal(registry.dispatch(key("Enter", { metaKey: true }).event), false);
  assert.equal(played, 0);
});
