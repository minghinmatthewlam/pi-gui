import tsParser from "@typescript-eslint/parser";
import tseslint from "typescript-eslint";
import { fileURLToPath } from "node:url";

const typedRules = {
  "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: false }],
  "@typescript-eslint/no-misused-promises": "error",
  "@typescript-eslint/no-unsafe-argument": "error",
  "@typescript-eslint/no-unsafe-assignment": "error",
  "@typescript-eslint/no-unsafe-call": "error",
  "@typescript-eslint/no-unsafe-member-access": "error",
  "@typescript-eslint/no-unsafe-return": "error",
};
const typedProject = (files, project) => ({
  files,
  plugins: { "@typescript-eslint": tseslint.plugin },
  languageOptions: {
    parser: tsParser,
    parserOptions: { project, tsconfigRootDir: fileURLToPath(new URL(".", import.meta.url)) },
  },
  rules: typedRules,
});
export default [
  {
    ignores: [
      "**/node_modules/**",
      "examples/desktop-extensions/*/dist/**",
      // Generated output lives at repository/workspace roots, never anywhere
      // named "release" or "build" inside product source.
      ...["", "apps/*/", "packages/*/", "video/"].flatMap((root) =>
        [
          "dist",
          "dist-electron",
          "out",
          "build",
          "release",
          "release-*",
          ".next",
          ".cache",
          ".artifacts",
          "test-results",
          "playwright-report",
        ].map((directory) => `${root}${directory}/**`),
      ),
      "**/*.d.{ts,mts,cts}",
      ".pnpm-store/**",
      ".cursor/**",
      ".worktrees/**",
      ".claude/worktrees/**",
      ".codex/worktrees/**",
    ],
  },
  {
    files: [
      "apps/**/*.{js,mjs,cjs,ts,tsx,mts,cts}",
      "packages/**/*.{js,mjs,cjs,ts,tsx,mts,cts}",
      "examples/desktop-extensions/**/*.{js,mjs,cjs,ts,tsx,mts,cts}",
      "video/**/*.{js,mjs,cjs,ts,tsx,mts,cts}",
      "scripts/**/*.{js,mjs,cjs,ts,tsx,mts,cts}",
      ".github/scripts/**/*.{js,mjs,cjs,ts,tsx,mts,cts}",
      "*.{js,mjs,cjs,ts,mts,cts}",
    ],
    plugins: { "@typescript-eslint": tseslint.plugin },
    languageOptions: { parser: tsParser },
    linterOptions: { noInlineConfig: true },
    rules: {
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          "ts-nocheck": true,
          "ts-ignore": true,
          "ts-expect-error": "allow-with-description",
          minimumDescriptionLength: 10,
        },
      ],
      "constructor-super": "error",
      "getter-return": "error",
      "no-async-promise-executor": "error",
      "no-constant-binary-expression": "error",
      "no-debugger": "error",
      "no-dupe-args": "error",
      "no-dupe-keys": "error",
      "no-duplicate-case": "error",
      "no-unreachable": "error",
      "no-unsafe-finally": "error",
      "valid-typeof": "error",
    },
  },
  {
    // App.tsx composes the screen. Put new behavior in a feature hook or component
    // (commands: app/use-desktop-commands.ts) and lower this limit when App.tsx shrinks.
    files: ["apps/desktop/src/app/App.tsx"],
    rules: { "max-lines": ["error", { max: 1394 }] },
  },
  typedProject(["apps/desktop/src/**/*.{ts,tsx,mts,cts}"], "apps/desktop/tsconfig.json"),
  typedProject(
    ["apps/desktop/electron/**/*.{ts,tsx,mts,cts}"],
    "apps/desktop/tsconfig.electron.json",
  ),
  typedProject(
    [
      "apps/desktop/tests/**/*.{ts,tsx,mts,cts}",
      "apps/desktop/*.{ts,mts,cts}",
      "apps/desktop/scripts/**/*.{ts,tsx,mts,cts}",
    ],
    "apps/desktop/tsconfig.lint.json",
  ),
  ...["catalogs", "pi-sdk-driver", "session-driver", "extension-ui"].map((name) =>
    typedProject([`packages/${name}/**/*.{ts,tsx,mts,cts}`], `packages/${name}/tsconfig.lint.json`),
  ),
  ...["pr-review", "test-runs"].map((name) =>
    typedProject(
      [`examples/desktop-extensions/${name}/**/*.{ts,tsx,mts,cts}`],
      `examples/desktop-extensions/${name}/tsconfig.lint.json`,
    ),
  ),
  typedProject(["apps/website/**/*.{ts,tsx,mts,cts}"], "apps/website/tsconfig.json"),
  typedProject(["video/**/*.{ts,tsx,mts,cts}"], "video/tsconfig.lint.json"),
];
