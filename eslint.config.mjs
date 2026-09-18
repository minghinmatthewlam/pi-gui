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
      "**/dist/**",
      "**/out/**",
      "**/build/**",
      "**/release*/**",
      "**/.next/**",
      "**/.cache/**",
      "**/.artifacts/**",
      "**/test-results/**",
      "**/playwright-report/**",
      "**/*.d.{ts,mts,cts}",
      ".pnpm-store/**",
      ".cursor/**",
    ],
  },
  {
    files: [
      "apps/**/*.{js,mjs,cjs,ts,tsx,mts,cts}",
      "packages/**/*.{js,mjs,cjs,ts,tsx,mts,cts}",
      "video/**/*.{js,mjs,cjs,ts,tsx,mts,cts}",
      "scripts/**/*.{js,mjs,cjs,ts,tsx,mts,cts}",
      ".github/scripts/**/*.{js,mjs,cjs,ts,tsx,mts,cts}",
      "*.{js,mjs,cjs,ts,mts,cts}",
    ],
    languageOptions: { parser: tsParser },
    linterOptions: { noInlineConfig: true },
    rules: {
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
  ...["catalogs", "pi-sdk-driver", "session-driver"].map((name) =>
    typedProject([`packages/${name}/**/*.{ts,tsx,mts,cts}`], `packages/${name}/tsconfig.lint.json`),
  ),
  typedProject(["apps/website/**/*.{ts,tsx,mts,cts}"], "apps/website/tsconfig.json"),
  typedProject(["video/**/*.{ts,tsx,mts,cts}"], "video/tsconfig.lint.json"),
];
