import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text"],
      exclude: [
        "dist/**",
        "scripts/**",
        "vitest.config.ts",
        "src/index.ts",
        "src/core/json-rpc-lsp-client.ts",
        "src/core/types.ts"
      ],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80
      }
    }
  }
});
