import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDiagnosticsTimeout } from "../src/core/diagnostics-timeout.js";

describe("diagnostics timeout policy", () => {
  let rootPath = "";

  afterEach(async () => {
    if (rootPath) await fs.rm(rootPath, { recursive: true, force: true });
  });

  it("keeps numeric policies fixed", async () => {
    rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lsp-timeout-"));

    expect(resolveDiagnosticsTimeout(rootPath, 22000)).toEqual({
      timeoutMs: 22000,
      policy: "fixed",
      reasons: ["configured 22000ms"]
    });
  });

  it("increases auto timeout for monorepos and TypeScript project references", async () => {
    rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lsp-timeout-"));
    await fs.writeFile(path.join(rootPath, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    await fs.writeFile(
      path.join(rootPath, "tsconfig.json"),
      JSON.stringify({
        references: [
          { path: "packages/a" },
          { path: "packages/b" },
          { path: "packages/c" }
        ]
      })
    );

    expect(resolveDiagnosticsTimeout(rootPath, "auto")).toMatchObject({
      timeoutMs: 28000,
      policy: "auto",
      reasons: expect.arrayContaining([
        "base 15000ms",
        "monorepo marker +10000ms",
        "tsconfig references 3 +3000ms"
      ])
    });
  });
});
