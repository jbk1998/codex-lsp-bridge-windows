import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  NativeNodeRuntimeError,
  createNativeNodeLaunchRecord,
  revalidateNativeNodeRuntime,
  validateNativeNodeLaunchRecord,
  validateNativeNodePath,
  validateNativeNodeRuntime
} from "../src/core/native-node-runtime.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("native node runtime descriptor", () => {
  it("accepts the current absolute executable and creates a launch record", () => {
    const validation = validateNativeNodeRuntime();
    const record = createNativeNodeLaunchRecord(path.join(process.cwd(), "dist", "index.js"), ["mcp"]);

    expect(validation.executablePath).toBe(path.resolve(process.execPath));
    expect(record).toEqual(
      expect.objectContaining({
        version: 1,
        runtime: "native-node",
        command: validation.executablePath,
        args: [path.join(process.cwd(), "dist", "index.js"), "mcp"]
      })
    );
    expect(validateNativeNodeLaunchRecord(record).command).toBe(validation.executablePath);
  });

  it.each([
    ["node", "relative"],
    [path.join(os.tmpdir(), "node.cmd"), "shim"],
    [path.join(os.tmpdir(), "node_repl.exe"), "code-mode runtime"]
  ])("rejects %s as an unsafe %s runtime", (runtimePath, reason) => {
    expect(() => validateNativeNodePath(runtimePath)).toThrowError(NativeNodeRuntimeError);
    expect(() => validateNativeNodePath(runtimePath)).toThrow(`native runtime rejected: ${reason}`);
  });

  it("detects a replacement between validation and spawn", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-native-node-"));
    temporaryDirectories.push(directory);
    const runtimePath = path.join(directory, path.basename(process.execPath));
    fs.copyFileSync(process.execPath, runtimePath);

    const validation = validateNativeNodeRuntime(runtimePath);
    fs.appendFileSync(runtimePath, "replacement");

    expect(() => revalidateNativeNodeRuntime(validation)).toThrowError(
      expect.objectContaining({ code: "runtime_identity_changed" })
    );
  });

  it("rejects unsafe structured launch arguments", () => {
    expect(() =>
      validateNativeNodeLaunchRecord({
        version: 1,
        runtime: "native-node",
        command: process.execPath,
        args: ["dist/index.js", "mcp\n"]
      })
    ).toThrowError(expect.objectContaining({ code: "unsafe_launch_argument" }));
  });
});
