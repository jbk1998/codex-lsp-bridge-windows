import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MeasurementHarnessError,
  measurementReceiptKeys,
  runMeasurement,
  validateReceipt
} from "../scripts/measure-bridge-lifecycle.mjs";

describe("repository-local lifecycle measurement harness", () => {
  it("emits one allowlisted receipt for a controlled positive run", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lsp-measure-test-"));
    const root = path.join(tempRoot, "workspace-with-source-like-text-and-secret");
    await fs.mkdir(root);
    const launcherCalls = [];
    let clockValue = 100;
    try {
      const receipt = await runMeasurement({
        root,
        tempRoot,
        language: "typescript",
        operationClass: "explicit_mcp",
        controlState: "positive",
        controlObserved: true,
        controlSimultaneous: true,
        r21Outcome: "RETAIN_BASELINE",
        launchRecord: { version: 1, runtime: "native-node", command: process.execPath, args: ["bridge-entrypoint.mjs", "mcp"] },
        randomBytesImpl: (size) => Buffer.alloc(size, 7),
        clock: { now: () => (clockValue += 1) },
        launcher: async (_record, context) => {
          launcherCalls.push(context);
          return {
            pid: 4101,
            ownershipToken: "bridge-identity-1",
            ownedChildPid: 4102,
            ownedChildIdentityProven: true,
            run: async () => ({
              connectionDurationMs: 20,
              childLifetimeMs: 12,
              initializationDurationMs: 4,
              requestLatencyMs: 3,
              restartCount: 0,
              recoveryFailures: 0
            }),
            close: async () => undefined,
            waitForExit: async () => true
          };
        },
        processInspector: {
          snapshot: async () => ({
            ownershipProven: true,
            identity: "bridge-identity-1",
            cpuMs: 8,
            memoryBytes: 4096
          })
        }
      });

      expect(validateReceipt(receipt)).toBe(receipt);
      expect(Object.keys(receipt)).toEqual(measurementReceiptKeys);
      expect(receipt).toMatchObject({
        schemaVersion: 1,
        language: "typescript",
        operationClass: "explicit_mcp",
        bridgePid: 4101,
        ownedChildPid: 4102,
        controlState: "positive",
        reasonCodes: [],
        outcome: "RETAIN_BASELINE"
      });
      expect(receipt.runId).toMatch(/^[0-9a-f]{32}$/);
      expect(receipt.rootFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(receipt)).not.toContain(root);
      expect(JSON.stringify(receipt)).not.toMatch(/source-like|secret|password|bridge-entrypoint/gi);
      expect(launcherCalls).toHaveLength(1);
      expect(await fs.readdir(tempRoot)).toEqual(["workspace-with-source-like-text-and-secret"]);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("records negative and incomplete controls as INCONCLUSIVE without launching a bridge", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lsp-measure-control-"));
    try {
      const negative = await runMeasurement({
        root: tempRoot,
        tempRoot,
        controlState: "negative",
        launcher: async () => {
          throw new Error("negative control must not launch bridge");
        }
      });
      expect(negative.outcome).toBe("INCONCLUSIVE");
      expect(negative.reasonCodes).toContain("negative_control_no_bridge_workload");

      const missingControl = await runMeasurement({
        root: tempRoot,
        tempRoot,
        controlState: "positive",
        launcher: async () => {
          throw new Error("missing control must not launch bridge");
        }
      });
      expect(missingControl.outcome).toBe("INCONCLUSIVE");
      expect(missingControl.reasonCodes).toContain("missing_control");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("distinguishes execution failure from a completed inconclusive receipt", async () => {
    await expect(
      runMeasurement({
        root: process.cwd(),
        tempRoot: os.tmpdir(),
        controlState: "positive",
        controlObserved: true,
        controlSimultaneous: true,
        launchRecord: { version: 1, runtime: "native-node", command: process.execPath, args: ["bridge-entrypoint.mjs", "mcp"] },
        launcher: async () => {
          throw new Error("command arguments and child output must not escape");
        }
      })
    ).rejects.toMatchObject({ constructor: MeasurementHarnessError, code: "execution_failed" });
  });

  it("prints no receipt for CLI startup errors", () => {
    const result = spawnSync(process.execPath, [path.resolve("scripts/measure-bridge-lifecycle.mjs"), "--invalid"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("HARNESS_ERROR");
  });
});
