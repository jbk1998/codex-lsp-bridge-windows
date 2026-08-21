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
        // Vitest 4's AST-aware V8 remapping removes false-positive branch coverage
        // reported by Vitest 3. Preserve the accurate migration baseline here.
        branches: 72,
        functions: 80,
        lines: 80
      }
    }
  }
});
