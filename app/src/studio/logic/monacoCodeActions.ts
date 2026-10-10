import {
  CodeActionModel,
  type CodeActionsState,
} from "monaco-editor/editor/contrib/codeAction/browser/codeActionModel.js";

const TRIGGERED = 1;
const INVOKE = 1;
const AUTO = 2;

/**
 * Monaco 0.57 holds back an automatic code-action state that arrives while an
 * explicit Quick Fix state is current, then applies it 500 ms later without
 * checking what happened since (codeActionModel.js, `isManualToAutoTransition`).
 * Applying a state cancels the current request, so a Quick Fix opened within
 * those 500 ms lost its answer and its menu never appeared. Here an automatic
 * state waits until a pending explicit request has answered, and is dropped
 * when a newer state replaced that request in the meantime.
 */
const answered = new WeakSet<CodeActionsState>();
const setState = CodeActionModel.prototype.setState;
CodeActionModel.prototype.setState = function (next, skipNotify) {
  const current = this._state;
  if (
    next.type === TRIGGERED &&
    next.trigger.type === AUTO &&
    current.type === TRIGGERED &&
    current.trigger.type === INVOKE &&
    !answered.has(current)
  ) {
    const apply = () => {
      if (this._state === current) setState.call(this, next, skipNotify);
      else next.cancel();
    };
    void current.actions.then(apply, apply);
    return;
  }
  if (next.type === TRIGGERED && next.trigger.type === INVOKE) {
    const settle = () => answered.add(next);
    void next.actions.then(settle, settle);
  }
  setState.call(this, next, skipNotify);
};
