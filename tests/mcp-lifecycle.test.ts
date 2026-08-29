import { PassThrough, Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
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

  it("reports drain and disposal exhaustion as separate lifecycle reasons", async () => {
    let releaseActive: (() => void) | undefined;
    let releaseDisposal: (() => void) | undefined;
    const coordinator = new McpLifecycleCoordinator({
      createDeadline: () => createDisposalDeadline(Date.now(), 10, 1, 1),
      dispose: () =>
        new Promise<void>((resolve) => {
          releaseDisposal = resolve;
        })
    });
    const active = coordinator.dispatch(
      () =>
        new Promise<void>((resolve) => {
          releaseActive = resolve;
        })
    );

    await expect(coordinator.close()).resolves.toMatchObject({
      state: "non_clean",
      clean: false,
      reasonCode: "active_requests_timeout",
      reasonCodes: ["active_requests_timeout", "disposal_timeout"],
      cleanupPending: true,
      activeRequestCount: 1
    });

    releaseActive?.();
    releaseDisposal?.();
    await active;
    await new Promise((resolve) => setImmediate(resolve));
  });

  it("reports timed-out disposal as tracked cleanup instead of losing the in-flight promise", async () => {
    let release: (() => void) | undefined;
    const coordinator = new McpLifecycleCoordinator({
      createDeadline: () => createDisposalDeadline(Date.now(), 10, 1, 1),
      dispose: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    });

    await expect(coordinator.close()).resolves.toMatchObject({
      state: "non_clean",
      clean: false,
      reasonCode: "disposal_timeout",
      cleanupPending: true
    });
    release?.();
    await new Promise((resolve) => setImmediate(resolve));
    expect(coordinator.state).toBe("non_clean");
  });
});

describe("MCP stdio lifecycle", () => {
  it("resets the idle timeout when a message arrives", async () => {
    vi.useFakeTimers();
    const input = new PassThrough();
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    let disposeCalls = 0;

    try {
      const runPromise = runStdioMcp(new CommandService(new TestProvider()), {
        input,
        output,
        errorOutput,
        idleTimeoutMs: 1000,
        dispose: async () => {
          disposeCalls += 1;
        }
      });

      await vi.advanceTimersByTimeAsync(750);
      input.write(`${JSON.stringify({ id: 1, method: "initialize" })}\n`);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(999);
      expect(disposeCalls).toBe(0);

      await vi.advanceTimersByTimeAsync(1);
      await expect(runPromise).resolves.toMatchObject({ state: "clean", clean: true });
      expect(disposeCalls).toBe(1);
    } finally {
      input.destroy();
      output.destroy();
      errorOutput.destroy();
      vi.useRealTimers();
    }
  });

  it("closes an idle connection when no suspension callback is provided", async () => {
    vi.useFakeTimers();
    const input = new PassThrough();
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    const errors: Buffer[] = [];
    errorOutput.on("data", (chunk) => errors.push(Buffer.from(chunk)));
    let disposeCalls = 0;

    try {
      const runPromise = runStdioMcp(new CommandService(new TestProvider()), {
        input,
        output,
        errorOutput,
        idleTimeoutMs: 1000,
        dispose: async () => {
          disposeCalls += 1;
        }
      });

      await vi.advanceTimersByTimeAsync(999);
      expect(disposeCalls).toBe(0);
      await vi.advanceTimersByTimeAsync(1);

      await expect(runPromise).resolves.toMatchObject({ state: "clean", clean: true });
      expect(disposeCalls).toBe(1);
      expect(Buffer.concat(errors).toString("utf8")).toContain("idle");
    } finally {
      input.destroy();
      output.destroy();
      errorOutput.destroy();
      vi.useRealTimers();
    }
  });

  it("suspends idle LSP resources without closing the MCP connection", async () => {
    vi.useFakeTimers();
    const input = new PassThrough();
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    const errors: Buffer[] = [];
    errorOutput.on("data", (chunk) => errors.push(Buffer.from(chunk)));
    let suspendCalls = 0;
    let disposeCalls = 0;

    try {
      const runPromise = runStdioMcp(new CommandService(new TestProvider()), {
        input,
        output,
        errorOutput,
        idleTimeoutMs: 1000,
        suspend: async () => {
          suspendCalls += 1;
        },
        dispose: async () => {
          disposeCalls += 1;
        }
      });

      await vi.advanceTimersByTimeAsync(1000);
      expect(suspendCalls).toBe(1);
      expect(disposeCalls).toBe(0);

      input.write(`${JSON.stringify({ id: 9, method: "initialize" })}\n`);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(999);
      expect(suspendCalls).toBe(1);
      expect(disposeCalls).toBe(0);

      await vi.advanceTimersByTimeAsync(1);
      expect(suspendCalls).toBe(2);
      expect(disposeCalls).toBe(0);

      input.end();
      await expect(runPromise).resolves.toMatchObject({ state: "clean", clean: true });
      expect(disposeCalls).toBe(1);
      expect(Buffer.concat(errors).toString("utf8")).toContain("suspended LSP resources");
    } finally {
      input.destroy();
      output.destroy();
      errorOutput.destroy();
      vi.useRealTimers();
    }
  });

  it("waits for an active request before suspending idle LSP resources", async () => {
    vi.useFakeTimers();
    const provider = new BlockingProvider();
    const input = new PassThrough();
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    const lifecycle = new McpLifecycleCoordinator({
      createDeadline: () => createDisposalDeadline(Date.now(), 500, 10, 10),
      dispose: async () => undefined
    });
    let suspendCalls = 0;

    try {
      const runPromise = runStdioMcp(new CommandService(provider), {
        input,
        output,
        errorOutput,
        lifecycle,
        idleTimeoutMs: 1000,
        suspend: async () => {
          suspendCalls += 1;
        }
      });
      input.write(`${JSON.stringify({ id: 10, method: "tools/call", params: { name: "lsp_diagnostics", arguments: {} } })}\n`);
      await Promise.resolve();
      expect(lifecycle.activeRequestCount).toBe(1);

      await vi.advanceTimersByTimeAsync(1000);
      expect(suspendCalls).toBe(0);
      expect(lifecycle.state).toBe("open");

      provider.release();
      await vi.advanceTimersByTimeAsync(0);
      expect(suspendCalls).toBe(1);
      expect(lifecycle.state).toBe("open");

      input.end();
      await expect(runPromise).resolves.toMatchObject({ state: "clean", clean: true });
    } finally {
      input.destroy();
      output.destroy();
      errorOutput.destroy();
      vi.useRealTimers();
    }
  });

  it("does not start a pending idle suspension after EOF begins shutdown", async () => {
    vi.useFakeTimers();
    const provider = new BlockingProvider();
    const input = new PassThrough();
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    let suspendCalls = 0;

    try {
      const runPromise = runStdioMcp(new CommandService(provider), {
        input,
        output,
        errorOutput,
        idleTimeoutMs: 1000,
        suspend: async () => {
          suspendCalls += 1;
        },
        dispose: async () => undefined
      });
      input.write(`${JSON.stringify({ id: 12, method: "tools/call", params: { name: "lsp_diagnostics", arguments: {} } })}\n`);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1000);

      const inputEnded = new Promise<void>((resolve) => input.once("end", resolve));
      input.end();
      await inputEnded;
      provider.release();
      await vi.advanceTimersByTimeAsync(0);

      await expect(runPromise).resolves.toMatchObject({ state: "clean", clean: true });
      expect(suspendCalls).toBe(0);
    } finally {
      input.destroy();
      output.destroy();
      errorOutput.destroy();
      vi.useRealTimers();
    }
  });

  it("enters bounded shutdown without waiting for a hanging idle suspension", async () => {
    vi.useFakeTimers();
    const input = new PassThrough();
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    let markSuspensionStarted: (() => void) | undefined;
    const suspensionStarted = new Promise<void>((resolve) => {
      markSuspensionStarted = resolve;
    });

    try {
      const runPromise = runStdioMcp(new CommandService(new TestProvider()), {
        input,
        output,
        errorOutput,
        idleTimeoutMs: 1000,
        suspend: async () => {
          markSuspensionStarted?.();
          await new Promise<void>(() => undefined);
        },
        dispose: async () => undefined
      });

      await vi.advanceTimersByTimeAsync(1000);
      await suspensionStarted;
      input.end();
      await vi.advanceTimersByTimeAsync(0);

      await expect(runPromise).resolves.toMatchObject({
        state: "non_clean",
        clean: false,
        reasonCode: "disposal_timeout",
        cleanupPending: true
      });
    } finally {
      input.destroy();
      output.destroy();
      errorOutput.destroy();
      vi.useRealTimers();
    }
  });

  it("preserves a non-clean idle suspension in the final lifecycle result", async () => {
    vi.useFakeTimers();
    const input = new PassThrough();
    const output = new PassThrough();
    const errorOutput = new PassThrough();

    try {
      const runPromise = runStdioMcp(new CommandService(new TestProvider()), {
        input,
        output,
        errorOutput,
        idleTimeoutMs: 1000,
        suspend: async () => ({ clean: false, reasonCode: "exit_unconfirmed" }),
        dispose: async () => undefined
      });

      await vi.advanceTimersByTimeAsync(1000);
      input.end();
      await vi.advanceTimersByTimeAsync(0);

      await expect(runPromise).resolves.toMatchObject({
        state: "non_clean",
        clean: false,
        reasonCode: "exit_unconfirmed"
      });
    } finally {
      input.destroy();
      output.destroy();
      errorOutput.destroy();
      vi.useRealTimers();
    }
  });

  it("waits for an in-flight suspension before dispatching the next request", async () => {
    vi.useFakeTimers();
    const input = new PassThrough();
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    const chunks: Buffer[] = [];
    output.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    let markSuspensionStarted: (() => void) | undefined;
    let releaseSuspension: (() => void) | undefined;
    const suspensionStarted = new Promise<void>((resolve) => {
      markSuspensionStarted = resolve;
    });

    try {
      const runPromise = runStdioMcp(new CommandService(new TestProvider()), {
        input,
        output,
        errorOutput,
        idleTimeoutMs: 1000,
        suspend: async () => {
          markSuspensionStarted?.();
          await new Promise<void>((resolve) => {
            releaseSuspension = resolve;
          });
        },
        dispose: async () => undefined
      });

      await vi.advanceTimersByTimeAsync(1000);
      await suspensionStarted;

      input.write(`${JSON.stringify({ id: 11, method: "initialize" })}\n`);
      await vi.advanceTimersByTimeAsync(0);
      expect(chunks).toHaveLength(0);

      releaseSuspension?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(Buffer.concat(chunks).toString("utf8")).toContain('"id":11');

      input.end();
      await expect(runPromise).resolves.toMatchObject({ state: "clean", clean: true });
    } finally {
      input.destroy();
      output.destroy();
      errorOutput.destroy();
      vi.useRealTimers();
    }
  });

  it("does not close an idle connection while a request is active", async () => {
    vi.useFakeTimers();
    const provider = new BlockingProvider();
    const input = new PassThrough();
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    const lifecycle = new McpLifecycleCoordinator({
      createDeadline: () => createDisposalDeadline(Date.now(), 500, 10, 10),
      dispose: async () => undefined
    });

    try {
      const runPromise = runStdioMcp(new CommandService(provider), {
        input,
        output,
        errorOutput,
        lifecycle,
        idleTimeoutMs: 1000
      });
      input.write(`${JSON.stringify({ id: 8, method: "tools/call", params: { name: "lsp_diagnostics", arguments: {} } })}\n`);
      await Promise.resolve();
      expect(lifecycle.activeRequestCount).toBe(1);

      await vi.advanceTimersByTimeAsync(1000);
      expect(lifecycle.state).toBe("open");
      expect(lifecycle.activeRequestCount).toBe(1);

      provider.release();
      await expect(runPromise).resolves.toMatchObject({ state: "clean", clean: true });
    } finally {
      input.destroy();
      output.destroy();
      errorOutput.destroy();
      vi.useRealTimers();
    }
  });

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
