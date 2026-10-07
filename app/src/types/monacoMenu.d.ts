/** Narrow types for the menu registry used by the pinned Monaco adapter. */
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
