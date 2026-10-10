/** Narrow types for the Monaco internals used by the pinned Monaco adapter. */
declare module "monaco-editor/platform/actions/common/actions.js" {
  export class MenuId {
    constructor(id: string);
  }
  export const MenuRegistry: {
    appendMenuItem(
      menu: MenuId,
      item: {
        command: { id: string; title: string };
        group: string;
        order: number;
        when: unknown;
      },
    ): { dispose(): void };
  };
}

declare module "monaco-editor/platform/contextkey/common/contextkey.js" {
  export const ContextKeyExpr: { equals(key: string, value: string): unknown };
}

declare module "monaco-editor/editor/contrib/codeAction/browser/codeActionModel.js" {
  export type CodeActionsState =
    | { readonly type: 0 }
    | {
        readonly type: 1;
        readonly trigger: { readonly type: 1 | 2 };
        readonly actions: Promise<unknown>;
        cancel(): void;
      };
  export class CodeActionModel {
    _state: CodeActionsState;
    setState(state: CodeActionsState, skipNotify?: boolean): void;
  }
}
