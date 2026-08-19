import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
const measurement = await import("../scripts/measure-bridge-lifecycle.mjs");

const { MeasurementHarnessError, launchMaterializedBridge, measurementReceiptKeys, runMeasurement, validateReceipt } = measurement;

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
            pid: 4101,
            identityObserved: true,
            identity: "bridge-identity-1",
            cpuMs: 8,
            memoryBytes: 4096,
            descendants: [{ pid: 4102, identity: "child-identity-1", identityObserved: true }]
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

  it("routes the materialized diagnostics workload to the read-only diagnostics tool", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lsp-measure-routing-"));
    const root = path.join(tempRoot, "workspace");
    const sourcePath = path.join(root, "src", "index.ts");
    const bridgeScript = path.join(tempRoot, "fake-mcp.mjs");
    const requestLog = path.join(tempRoot, "requests.jsonl");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(sourcePath, "export const measurementFixture = 1;\n");
    await fs.writeFile(
      bridgeScript,
      `import fs from "node:fs";\nimport readline from "node:readline";\nconst log = ${JSON.stringify(requestLog)};\nconst rl = readline.createInterface({ input: process.stdin });\nrl.on("line", (line) => { const request = JSON.parse(line); fs.appendFileSync(log, JSON.stringify(request) + "\\n"); if (request.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }) + "\\n"); });\nrl.on("close", () => process.exit(0));\n`
    );
    try {
      const bridge = await launchMaterializedBridge(
        { version: 1, runtime: "native-node", command: process.execPath, args: [bridgeScript] },
        { root, operationClass: "diagnostics", diagnosticsTarget: sourcePath, timeoutMs: 2000, clock: { now: () => 1 } }
      );
      await bridge.run();
      bridge.close();
      await expect(bridge.waitForExit(2000)).resolves.toBe(true);
      const requests = (await fs.readFile(requestLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(requests.map((request) => request.method)).toEqual(["initialize", "notifications/initialized", "tools/call"]);
      expect(requests[2].params).toMatchObject({ name: "lsp_diagnostics", arguments: { file: sourcePath, root } });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects unvalidated launch records and does not force-close after identity uncertainty", async () => {
    await expect(runMeasurement({
      root: process.cwd(),
      tempRoot: os.tmpdir(),
      controlState: "positive",
      controlObserved: true,
      controlSimultaneous: true,
      launchRecord: { version: 1, runtime: "native-node", command: "node.cmd", args: ["bridge.mjs"] },
      launcher: async () => ({ pid: 4201 })
    })).rejects.toMatchObject({ code: "launch_record_invalid" });

    const forceClose = vi.fn(() => true);
    const receipt = await runMeasurement({
      root: process.cwd(),
      tempRoot: os.tmpdir(),
      controlState: "positive",
      controlObserved: true,
      controlSimultaneous: true,
      launchRecord: { version: 1, runtime: "native-node", command: process.execPath, args: ["bridge.mjs"] },
      launcher: async () => ({
        pid: 4201,
        run: async () => ({}),
        close: async () => undefined,
        waitForExit: async () => false,
        forceClose
      }),
      processInspector: {
        snapshot: async (_pid, context) => ({
          pid: 4201,
          identityObserved: context.phase !== "force_close",
          identity: context.phase === "force_close" ? null : "identity-at-launch",
          cpuMs: 1,
          memoryBytes: 1
        })
      }
    });
    expect(forceClose).not.toHaveBeenCalled();
    expect(receipt.reasonCodes).toContain("cleanup_uncertain");
    expect(receipt.outcome).toBe("INCONCLUSIVE");

    const reusedForceClose = vi.fn(() => true);
    const reusedReceipt = await runMeasurement({
      root: process.cwd(),
      tempRoot: os.tmpdir(),
      controlState: "positive",
      controlObserved: true,
      controlSimultaneous: true,
      launchRecord: { version: 1, runtime: "native-node", command: process.execPath, args: ["bridge.mjs"] },
      launcher: async () => ({
        pid: 4202,
        run: async () => ({}),
        close: async () => undefined,
        waitForExit: async () => false,
        forceClose: reusedForceClose
      }),
      processInspector: {
        snapshot: async (_pid, context) => ({
          pid: 4202,
          identityObserved: true,
          identity: context.phase === "launch" ? "identity-at-launch" : "identity-after-reuse",
          cpuMs: 1,
          memoryBytes: 1
        })
      }
    });
    expect(reusedForceClose).not.toHaveBeenCalled();
    expect(reusedReceipt.reasonCodes).toContain("pid_reuse_uncertain");
    expect(reusedReceipt.reasonCodes).toContain("cleanup_uncertain");
    expect(reusedReceipt.outcome).toBe("INCONCLUSIVE");
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
