import { PassThrough, Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { CommandService } from "../src/core/command-service.js";
import { createDisposalDeadline } from "../src/core/process-ownership.js";
import type { DiagnosticReport, HoverInfo, Location, SemanticProvider, SymbolMatch } from "../src/core/types.js";
import { McpLifecycleCoordinator } from "../src/transport/mcp-lifecycle.js";
import { mcpTools, runStdioMcp } from "../src/transport/mcp.js";

class TestProvider implements SemanticProvider {
  diagnostics(): Promise<DiagnosticReport> {
    return Promise.resolve({ status: "ok", timedOut: false, stale: false, items: [] });
  }
  definition(): Promise<Location> {
    return Promise.resolve({ file: "src/index.ts", line: 1, character: 1 });
  }
  definitionAt(): Promise<Location> {
    return Promise.resolve({ file: "src/index.ts", line: 1, character: 1 });
  }
  references(): Promise<Location[]> {
    return Promise.resolve([]);
  }
  referencesAt(): Promise<Location[]> {
    return Promise.resolve([]);
  }
  symbols(): Promise<SymbolMatch[]> {
    return Promise.resolve([]);
  }
  hover(): Promise<HoverInfo> {
    return Promise.resolve({ file: "src/index.ts", line: 1, character: 1, contents: "" });
  }
  hoverAt(): Promise<HoverInfo> {
    return Promise.resolve({ file: "src/index.ts", line: 1, character: 1, contents: "" });
  }
  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

class BlockingProvider extends TestProvider {
  private releaseDiagnostics: (() => void) | undefined;

  diagnostics(): Promise<DiagnosticReport> {
    return new Promise((resolve) => {
      this.releaseDiagnostics = () => resolve({ status: "ok", timedOut: false, stale: false, items: [] });
    });
  }

  release(): void {
    this.releaseDiagnostics?.();
  }
}

describe("MCP lifecycle coordinator", () => {
  it("drains active dispatches, rejects new work, and disposes exactly once", async () => {
    let release: (() => void) | undefined;
    let disposeCalls = 0;
    const coordinator = new McpLifecycleCoordinator({
      createDeadline: () => createDisposalDeadline(Date.now(), 500, 10, 10),
      dispose: async () => {
        disposeCalls += 1;
      }
    });
    const active = coordinator.dispatch(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );

    const closing = coordinator.close();
    expect(coordinator.state).toBe("draining");
    await expect(coordinator.dispatch(() => undefined)).rejects.toThrow("connection is closing");
    expect(disposeCalls).toBe(0);
    release?.();
    await active;

    await expect(closing).resolves.toMatchObject({ state: "clean", clean: true, activeRequestCount: 0 });
    await expect(coordinator.close()).resolves.toMatchObject({ state: "clean", clean: true });
    expect(disposeCalls).toBe(1);
  });

  it("reports an active request timeout while still invoking bounded disposal", async () => {
    let release: (() => void) | undefined;
    let seenDeadline: number | undefined;
    const coordinator = new McpLifecycleCoordinator({
      createDeadline: () => createDisposalDeadline(Date.now(), 10, 1, 1),
      dispose: async (deadline) => {
        seenDeadline = deadline.deadlineAt;
      }
    });
    const active = coordinator.dispatch(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );

    await expect(coordinator.close()).resolves.toMatchObject({
      state: "non_clean",
      clean: false,
      reasonCode: "active_requests_timeout",
      activeRequestCount: 1
    });
    expect(seenDeadline).toBeDefined();
    release?.();
    await active;
  });
});

describe("MCP stdio lifecycle", () => {
  it("keeps the approved read-only tool catalog and reports readiness without process telemetry", async () => {
    const input = Readable.from([
      `${JSON.stringify({ id: 1, method: "initialize" })}\n`,
      `${JSON.stringify({ id: 2, method: "tools/list" })}\n`,
      `${JSON.stringify({ id: 3, method: "tools/call", params: { name: "lsp_status", arguments: {} } })}\n`
    ]);
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    const chunks: Buffer[] = [];
    output.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    let disposeCalls = 0;
    const result = await runStdioMcp(new CommandService(new TestProvider()), {
      input,
      output,
      errorOutput,
      status: () => ({ explicitMcpReady: true, hookState: "absent" }),
      dispose: async () => {
        disposeCalls += 1;
      }
    });

    const responses = Buffer.concat(chunks)
      .toString("utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { id: number; result?: any });
    expect(result).toMatchObject({ state: "clean", clean: true });
    expect(disposeCalls).toBe(1);
    expect(mcpTools.map((tool) => tool.name)).toEqual([
      "lsp_diagnostics",
      "lsp_definition",
      "lsp_references",
      "lsp_symbols",
      "lsp_hover",
      "lsp_status"
    ]);
    expect(responses.find((response) => response.id === 1)?.result).toMatchObject({
      capabilities: { tools: {} },
      serverInfo: { name: "codex-lsp-bridge" }
    });
    const listedTools = responses.find((response) => response.id === 2)?.result?.tools;
    expect(listedTools).toEqual(mcpTools);
    expect(responses.find((response) => response.id === 3)?.result).toMatchObject({
      structuredContent: { explicitMcpReady: true, hookState: "absent" }
    });
    expect(JSON.stringify(responses)).not.toMatch(/pid|process|memory|cpu|measurement|receipt/i);
  });

  it("observes EOF while a request is blocked and waits for the tracked request before disposal", async () => {
    const provider = new BlockingProvider();
    const input = Readable.from([
      `${JSON.stringify({ id: 7, method: "tools/call", params: { name: "lsp_diagnostics", arguments: {} } })}\n`
    ]);
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    const lifecycle = new McpLifecycleCoordinator({
      createDeadline: () => createDisposalDeadline(Date.now(), 500, 10, 10),
      dispose: async () => undefined
    });
    const runPromise = runStdioMcp(new CommandService(provider), {
      input,
      output,
      errorOutput,
      lifecycle
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(lifecycle.state).toBe("draining");
    await expect(lifecycle.dispatch(() => undefined)).rejects.toThrow("connection is closing");
    provider.release();

    await expect(runPromise).resolves.toMatchObject({ state: "clean", clean: true });
    expect(lifecycle.activeRequestCount).toBe(0);
  });
});
