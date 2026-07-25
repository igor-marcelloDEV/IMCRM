import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Vendored minified opus-recorder encoder worker (served statically).
    "public/opus/**",
    // Separate npm projects with their own package.json/tsconfig/lint —
    // not part of the Next.js app. eslint-config-next's React-specific
    // rules (e.g. react-hooks/rules-of-hooks) false-positive on plain
    // Node code that happens to name a function `useXyz`.
    "mcp-server/**",
    "whatsapp-worker/**",
  ]),
]);

export default eslintConfig;
