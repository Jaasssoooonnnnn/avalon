import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@avalon/shared": resolve(here, "packages/shared/src/index.ts"),
    },
  },
  test: {
    include: [
      "tests/**/*.test.ts",
      "apps/server/src/**/*.test.ts",
      "packages/**/*.test.ts",
    ],
    environment: "node",
    testTimeout: 20000,
  },
});
