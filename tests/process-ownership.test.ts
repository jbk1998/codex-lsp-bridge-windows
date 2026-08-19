import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { createProcessOwnership } from "../src/core/process-ownership.js";

class FakeChild extends EventEmitter {
  pid = 1234;
  exitCode: number | null = null;
  signalCode = null;
  killCalls = 0;
  shouldRejectKill = false;

  kill(): boolean {
    this.killCalls += 1;
    if (this.shouldRejectKill) throw new Error("permission denied");
    return true;
  }

  exit(code = 0): void {
    this.exitCode = code;
    this.emit("exit", code, null);
  }
}

describe("process ownership", () => {
  it("terminates a verified direct child only after observing exit", async () => {
    const child = new FakeChild();
    const ownership = createProcessOwnership(child, { verify: () => true });
    const resultPromise = ownership.terminate(Date.now() + 100);
    child.exit();

    await expect(resultPromise).resolves.toEqual({ clean: true, reasonCode: "owned_child_exit" });
    expect(child.killCalls).toBe(1);
  });

  it("refuses PID reuse or an unverified identity", async () => {
    const child = new FakeChild();
    const ownership = createProcessOwnership(child, { verify: () => false });

    await expect(ownership.terminate(Date.now() + 100)).resolves.toEqual({
      clean: false,
      reasonCode: "identity_mismatch"
    });
    expect(child.killCalls).toBe(0);
  });

  it("keeps wrapper descendants non-clean unless ownership is verified", async () => {
    const child = new FakeChild();
    const ownership = createProcessOwnership(child, { wrapper: true, verify: () => true });
    const resultPromise = ownership.terminate(Date.now() + 100);
    child.exit();

    await expect(resultPromise).resolves.toEqual({ clean: false, reasonCode: "descendant_unverified" });
  });

  it("reports a bounded timeout without broad tree termination", async () => {
    const child = new FakeChild();
    const ownership = createProcessOwnership(child, { verify: () => true });

    await expect(ownership.terminate(Date.now() + 5)).resolves.toEqual({
      clean: false,
      reasonCode: "exit_unconfirmed"
    });
    expect(child.killCalls).toBe(1);
  });

  it("reports permission failure without retrying through a process tree", async () => {
    const child = new FakeChild();
    child.shouldRejectKill = true;
    const ownership = createProcessOwnership(child, { verify: () => true });

    await expect(ownership.terminate(Date.now() + 100)).resolves.toEqual({
      clean: false,
      reasonCode: "permission_denied"
    });
    expect(child.killCalls).toBe(1);
  });
});
