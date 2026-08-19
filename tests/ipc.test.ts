import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDiagnosticsIpcMetadata, diagnosticsIpcMetadataPath } from "../src/transport/ipc.js";

const packageRoot = process.cwd();

describe("deferred diagnostics IPC boundary", () => {
  it("keeps the historical IPC helper outside the active MCP transport", () => {
    const mcpSource = fs.readFileSync(path.join(packageRoot, "src", "transport", "mcp.ts"), "utf8");
    const indexSource = fs.readFileSync(path.join(packageRoot, "src", "index.ts"), "utf8");

    expect(mcpSource).not.toContain("startDiagnosticsIpcServer");
    expect(mcpSource).not.toContain("./ipc.js");
    expect(indexSource).not.toContain("startDiagnosticsIpcServer");
  });

  it("retains only inert, run-scoped metadata helpers for the future boundary", () => {
    const root = path.join(packageRoot, "fixtures", "future-ipc-root");
    const metadata = createDiagnosticsIpcMetadata(root);

    expect(metadata.protocolVersion).toBe(1);
    expect(metadata.rootHash).toHaveLength(32);
    expect(metadata.endpoint).toContain("codex-lsp-bridge-");
    expect(metadata.secret).toHaveLength(64);
    expect(metadata.pid).toBe(process.pid);
    expect(diagnosticsIpcMetadataPath(root)).toContain("codex-lsp-bridge-ipc-");
    expect(fs.existsSync(diagnosticsIpcMetadataPath(root))).toBe(false);
  });
});
