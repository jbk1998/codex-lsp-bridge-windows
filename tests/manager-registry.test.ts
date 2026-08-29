import { describe, expect, it } from "vitest";
import { ManagerRegistry, type ManagedManager } from "../src/core/manager-registry.js";
import type { DisposalDeadline, ProcessTerminationResult } from "../src/core/process-ownership.js";

class TestManager implements ManagedManager {
  disposeCalls = 0;
  suspendCalls = 0;

  constructor(private readonly disposalResults: Array<ProcessTerminationResult | void>) {}

  suspend(_deadline?: DisposalDeadline): Promise<ProcessTerminationResult | void> {
    this.suspendCalls += 1;
    return Promise.resolve();
  }

  dispose(_deadline?: DisposalDeadline): Promise<ProcessTerminationResult | void> {
    const result = this.disposalResults[Math.min(this.disposeCalls, this.disposalResults.length - 1)];
    this.disposeCalls += 1;
    return Promise.resolve(result);
  }
}

const testDeadline: DisposalDeadline = {
  deadlineAt: Date.now() + 1000,
  shutdownRequestMs: 10,
  childExitGraceMs: 10
};

describe("ManagerRegistry", () => {
  it("retires a replaced root and removes it after clean cleanup", async () => {
    const first = new TestManager([{ clean: true, reasonCode: "already_exited" }]);
    const second = new TestManager([{ clean: true, reasonCode: "already_exited" }]);
    const registry = new ManagerRegistry<TestManager>({ createDisposalDeadline: () => testDeadline });

    expect(registry.getOrCreate("root", "instance-1", () => first)).toMatchObject({
      manager: first,
      created: true,
      replaced: false
    });
    expect(registry.getOrCreate("root", "instance-1", () => second)).toMatchObject({
      manager: first,
      created: false,
      replaced: false
    });

    const replacement = registry.getOrCreate("root", "instance-2", () => second);
    expect(replacement).toMatchObject({ manager: second, created: true, replaced: true });
    expect(first.disposeCalls).toBe(0);
    await flushAsyncWork();
    expect(first.disposeCalls).toBe(1);
    expect(registry.retiredCount).toBe(0);
    expect(registry.allManagers()).toEqual([second]);
  });

  it("keeps failed retirement visible and retries it during final disposal", async () => {
    const first = new TestManager([
      { clean: false, reasonCode: "exit_unconfirmed" },
      { clean: true, reasonCode: "owned_child_exit" }
    ]);
    const second = new TestManager([{ clean: true, reasonCode: "already_exited" }]);
    const registry = new ManagerRegistry<TestManager>({ createDisposalDeadline: () => testDeadline });

    registry.getOrCreate("root", "instance-1", () => first);
    registry.getOrCreate("root", "instance-2", () => second);
    await flushAsyncWork();
    expect(registry.retiredCount).toBe(1);
    expect(registry.allManagers()).toEqual([second, first]);

    await expect(registry.disposeAll(testDeadline)).resolves.toMatchObject({ clean: true });
    expect(first.disposeCalls).toBe(2);
    expect(second.disposeCalls).toBe(1);
    expect(registry.retiredCount).toBe(0);
  });
});

function flushAsyncWork(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
