// ESLint flat config. Encodes the AGENTS.md rules that a stock rule can
// express; the ast-grep layer (.ast-grep/, `npm run lint:ast`) covers the
// structural rest, and `npm run check` runs both.
import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import vue from "eslint-plugin-vue";
import globals from "globals";
import tseslint from "typescript-eslint";
import vueParser from "vue-eslint-parser";

/** TypeScript-only runtime syntax that Node strip-types mode rejects. */
const stripTypesSafeSyntax = [
  {
    selector: "TSEnumDeclaration",
    message: "No enums: use a string-literal union or a const object (AGENTS.md).",
  },
  {
    selector: "TSParameterProperty",
    message:
      "No constructor parameter properties: declare the field and assign it in the body (AGENTS.md).",
  },
  {
    selector: "TSModuleDeclaration",
    message: "No namespaces (AGENTS.md).",
  },
];

export default defineConfig([
  globalIgnores([
    "**/node_modules/",
    "**/dist/",
    "app/test-results/",
    "app/playwright-report/",
    "games/*/",
    "!games/adventure-department/",
    "evals/node_modules/",
  ]),

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    name: "monotio_agi/typescript",
    files: [
      "src/**/*.ts",
      "games/adventure-department/**/*.ts",
      "test/**/*.ts",
      "app/src/**/*.ts",
      "app/e2e/**/*.ts",
      "app/test/**/*.ts",
      "scripts/**/*.ts",
    ],
    rules: {
      "no-restricted-syntax": ["error", ...stripTypesSafeSyntax],
      // Explicit .ts specifiers are the convention (allowImportingTsExtensions).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "@typescript-eslint/no-non-null-assertion": "off",
      // Sanctioned at provider SDK boundaries; warn so it stays visible.
      "@typescript-eslint/no-explicit-any": "warn",
      "prefer-const": ["error", { destructuring: "all" }],
      eqeqeq: ["error", "always", { null: "ignore" }],
    },
  },

  {
    // Engine core: zero runtime deps, no platform APIs. Platform access goes
    // through injected adapters.
    name: "monotio_agi/engine-isolation",
    files: ["src/**/*.ts"],
    languageOptions: { globals: {} },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "node:*",
                "fs",
                "path",
                "os",
                "url",
                "crypto",
                "child_process",
                "worker_threads",
              ],
              message:
                "src/ must not import Node built-ins; inject a platform adapter (AGENTS.md).",
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        ...[
          "window",
          "document",
          "navigator",
          "localStorage",
          "sessionStorage",
          "indexedDB",
          "fetch",
          "XMLHttpRequest",
          "WebSocket",
          "Worker",
          "AudioContext",
          "requestAnimationFrame",
          "process",
          "Buffer",
          "require",
          "__dirname",
          "__filename",
        ].map((name) => ({
          name,
          message: `'${name}' is a platform global; src/ core must not touch it directly (AGENTS.md).`,
        })),
      ],
    },
  },

  {
    name: "monotio_agi/node-tests-and-scripts",
    files: [
      "test/**/*.ts",
      "scripts/**/*.ts",
      "scripts/**/*.mjs",
      "app/e2e/**/*.ts",
      "app/test/**/*.ts",
      "app/vite.config.ts",
      "app/playwright.config.ts",
    ],
    languageOptions: { globals: { ...globals.node } },
  },

  {
    // The manual proof runs (run by hand, never by the suite): Node scripts
    // that also carry browser-context callbacks for page.evaluate.
    name: "monotio_agi/manual-proof-runs",
    files: ["app/e2e/manual/**/*.mjs"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },

  {
    name: "monotio_agi/browser-app",
    files: ["app/src/**/*.ts", "app/src/**/*.vue"],
    languageOptions: { globals: { ...globals.browser, ...globals.worker } },
  },

  {
    // Ambient declaration files: `declare global` is the only way to type the
    // window hooks the engine publishes, and it is a TSModuleDeclaration.
    // Scoped to app/src/types/ so the no-namespaces rule still holds elsewhere.
    name: "monotio_agi/ambient-declarations",
    files: ["app/src/types/*.d.ts"],
    rules: {
      "no-restricted-syntax": "off",
    },
  },

  ...vue.configs["flat/recommended"],
  {
    name: "monotio_agi/vue-sfc",
    files: ["app/src/**/*.vue"],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: [".vue"],
        sourceType: "module",
      },
    },
    rules: {
      "no-restricted-syntax": ["error", ...stripTypesSafeSyntax],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-non-null-assertion": "off",
      // Formatting is Prettier's job.
      "vue/max-attributes-per-line": "off",
      "vue/singleline-html-element-content-newline": "off",
      "vue/multiline-html-element-content-newline": "off",
      "vue/html-self-closing": "off",
      "vue/html-indent": "off",
      "vue/html-closing-bracket-newline": "off",
      "vue/first-attribute-linebreak": "off",
      "vue/attributes-order": "off",
    },
  },

  {
    // Vue 3.5 idioms: one script-setup style with type-based macros, and the
    // rules that catch silent reactivity loss. The vue-* ast-grep rules cover
    // what these cannot express (withDefaults, ref<T | null>(null),
    // useTemplateRef generics).
    name: "monotio_agi/strict-vue",
    files: ["app/src/**/*.vue"],
    rules: {
      "vue/block-lang": ["error", { script: { lang: "ts" } }],
      "vue/define-macros-order": [
        "error",
        {
          order: ["defineProps", "defineEmits", "defineModel", "defineSlots"],
          defineExposeLast: true,
        },
      ],
      "vue/define-props-declaration": ["error", "type-based"],
      "vue/define-emits-declaration": ["error", "type-based"],
      "vue/enforce-style-attribute": ["error", { allow: ["scoped"] }],
      "vue/no-undef-components": "error",
      "vue/no-undef-properties": "error",
      "vue/no-unused-refs": "error",
      "vue/no-useless-v-bind": "error",
      "vue/prefer-true-attribute-shorthand": "error",
      "vue/prefer-separate-static-class": "error",
      "vue/component-api-style": ["error", ["script-setup"]],
      "vue/no-ref-object-reactivity-loss": "error",
      "vue/require-typed-ref": "error",
      "vue/prefer-use-template-ref": "error",
      "vue/no-required-prop-with-default": "error",
      "vue/valid-define-options": "error",
    },
  },

  {
    name: "monotio_agi/evals-and-config",
    files: ["evals/**/*.mjs", "*.js", "*.mjs"],
    languageOptions: { globals: { ...globals.node } },
  },
]);
