import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const packageRoot = process.cwd();

describe("active PostToolUse wrapper characterization", () => {
  it("keeps the historical wrapper per-file and outside the default hook baseline", () => {
    const wrapper = fs.readFileSync(path.join(packageRoot, "scripts", "codex-lsp-post-tool-use.mjs"), "utf8");
    const hooks = JSON.parse(fs.readFileSync(path.join(packageRoot, "hooks", "hooks.json"), "utf8"));

    expect(wrapper).toContain("for (const file of files)");
    expect(wrapper).toContain('spawnBridge([bridgeCli, "diagnostics", "--file", file');
    expect(wrapper).not.toContain("tryIpcDiagnostics");
    expect(hooks).toEqual({ hooks: {} });
  });

  it("does not characterize the helper's batching or IPC path as current automatic behavior", () => {
    const helper = fs.readFileSync(path.join(packageRoot, "scripts", "codex-lsp-post-tool-use-core.mjs"), "utf8");
    expect(helper).toContain("groupFilesByLanguage");
    expect(helper).toContain("tryIpcDiagnostics");
    expect(fs.readFileSync(path.join(packageRoot, "hooks", "hooks.json"), "utf8")).not.toContain("post-tool-diagnostics");
  });
});
