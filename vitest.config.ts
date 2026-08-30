import { defineConfig } from "vitest/config";

const processOwnershipThresholds =
  process.platform === "win32"
    ? { statements: 50, branches: 50, functions: 70, lines: 55 }
    : { statements: 55, branches: 55, functions: 75, lines: 60 };

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text"],
      exclude: ["dist/**", "scripts/**", "vitest.config.ts", "src/index.ts", "src/core/types.ts"],
      thresholds: {
        statements: 80,
        // Vitest 4's AST-aware V8 remapping removes false-positive branch coverage
        // reported by Vitest 3. Preserve the accurate migration baseline here.
        branches: 72,
        functions: 80,
        lines: 80,
        // The implementation contains mutually exclusive Linux and Windows
        // process-inspection branches. Keep strong per-file floors based on
        // what each runner can execute instead of making one OS cover the
        // other's native path.
        "src/core/process-ownership.ts": processOwnershipThresholds,
        "src/core/native-node-runtime.ts": {
          statements: 62,
          branches: 59,
          functions: 90,
          lines: 65
        },
        "src/core/manager-registry.ts": {
          statements: 80,
          branches: 75,
          functions: 70,
          lines: 85
        }
      }
    }
  }
});
