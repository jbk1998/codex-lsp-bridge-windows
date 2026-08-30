import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectTouchedFiles,
  diagnosticsCachePath,
  diagnosticsIpcMetadataPath,
  findWorkspaceRoot,
  groupFilesByLanguage,
  hashRoot,
  resolveTouchedFiles,
  runPostToolUseDiagnostics
} from "../scripts/codex-lsp-post-tool-use-core.mjs";

describe("deferred post-tool-use diagnostics helper", () => {
  let rootPath = "";
  let outsidePath = "";

  afterEach(async () => {
    if (rootPath) await fs.rm(diagnosticsCachePath(rootPath), { force: true });
    if (rootPath) await fs.rm(rootPath, { recursive: true, force: true });
    if (outsidePath) await fs.rm(outsidePath, { recursive: true, force: true });
    rootPath = "";
    outsidePath = "";
  });

  it("collects touched source files from nested hook payloads", () => {
    const files = collectTouchedFiles({
      tool_input: {
        file_path: "src/index.ts",
        nested: [{ target_file: "src/ignored.txt" }, { path: "tests/example.test.ts" }]
      }
    });

    expect([...files]).toEqual(["src/index.ts", "tests/example.test.ts"]);
  });

  it("resolves the workspace root from a subdirectory", async () => {
    rootPath = await makeWorkspace();
    const subdir = path.join(rootPath, "src", "nested");
    await fs.mkdir(subdir, { recursive: true });

    expect(findWorkspaceRoot(subdir, {}, await import("node:fs"))).toBe(rootPath);
  });

  it("filters outside-root and unsupported touched files", async () => {
    rootPath = await makeWorkspace();
    outsidePath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lsp-outside-"));
    await fs.mkdir(path.join(rootPath, "src"), { recursive: true });
    await fs.writeFile(path.join(rootPath, "src", "index.ts"), "export {}\n");
    await fs.writeFile(path.join(rootPath, "src", "runner.mjs"), "export {}\n");
    await fs.writeFile(path.join(rootPath, "src", "config.cjs"), "module.exports = {}\n");
    await fs.writeFile(path.join(rootPath, "src", "notes.md"), "# notes\n");
    await fs.writeFile(path.join(outsidePath, "outside.ts"), "export {}\n");

    const files = resolveTouchedFiles(
      {
        file_path: "src/index.ts",
        module: "src/runner.mjs",
        commonjs: "src/config.cjs",
        other: path.join(outsidePath, "outside.ts"),
        notes: "src/notes.md"
      },
      { repoRoot: rootPath, maxFiles: 5 }
    );

    expect(files).toEqual([
      path.join(rootPath, "src", "index.ts"),
      path.join(rootPath, "src", "runner.mjs"),
      path.join(rootPath, "src", "config.cjs")
    ]);
  });

  it("caps touched files before diagnostics", async () => {
    rootPath = await makeWorkspace();
    await fs.mkdir(path.join(rootPath, "src"), { recursive: true });
    await fs.writeFile(path.join(rootPath, "src", "a.ts"), "export {}\n");
    await fs.writeFile(path.join(rootPath, "src", "b.ts"), "export {}\n");

    const files = resolveTouchedFiles(
      {
        files: ["src/a.ts", "src/b.ts"]
      },
      { repoRoot: rootPath, maxFiles: 1 }
    );

    expect(files).toEqual([path.join(rootPath, "src", "a.ts")]);
  });

  it("groups touched files by bridge language", () => {
    expect([...groupFilesByLanguage(["a.ts", "b.js", "cli.mjs", "config.cjs", "main.py", "lib.rs", "main.go"])]).toEqual([
      ["typescript", ["a.ts", "b.js", "cli.mjs", "config.cjs"]],
      ["python", ["main.py"]],
      ["rust", ["lib.rs"]],
      ["go", ["main.go"]]
    ]);
  });

  it("reports skipped diagnostics when language servers are missing and verbose pending is enabled", async () => {
    rootPath = await makeWorkspace();
    await fs.mkdir(path.join(rootPath, "src"), { recursive: true });
    await fs.writeFile(path.join(rootPath, "src", "index.ts"), "export {}\n");

    const result = await runPostToolUseDiagnostics({
      input: JSON.stringify({ file_path: "src/index.ts" }),
      cwd: rootPath,
      env: { CODEX_LSP_HOOK_VERBOSE_PENDING: "1", PATH: "" },
      bridgeCli: "dist/index.js",
      spawnSyncImpl: () => {
        throw new Error("spawn should not run when server is missing");
      }
    });

    expect(result).toEqual({
      exitCode: 0,
      stdout: "[codex-lsp-bridge] skipped diagnostics; missing language server(s): 1 file(s) need typescript-language-server.\n"
    });
  });

  it("characterizes clean output from the helper's batched subprocess path", async () => {
    rootPath = await makeWorkspace();
    const binPath = path.join(rootPath, "fake-bin");
    await fs.mkdir(path.join(rootPath, "src"), { recursive: true });
    await fs.mkdir(binPath);
    await fs.writeFile(path.join(rootPath, "src", "index.ts"), "export {}\n");
    await fs.writeFile(path.join(rootPath, "src", "other.ts"), "export {}\n");
    await makeExecutable(path.join(binPath, "typescript-language-server"));
    await makeExecutable(path.join(binPath, "typescript-language-server.cmd"));

    const calls = [];
    const result = await runPostToolUseDiagnostics({
      input: JSON.stringify({ files: ["src/index.ts", "src/other.ts"] }),
      cwd: rootPath,
      env: { PATH: binPath },
      bridgeCli: "dist/index.js",
      processExecPath: "node",
      spawnSyncImpl: (command, args, options) => {
        calls.push({ command, args, options });
        return {
          status: 0,
          stdout: JSON.stringify({ status: "ok", timedOut: false, stale: false, total: 0, bySeverity: {}, items: [] }),
          stderr: ""
        };
      }
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual([
      "dist/index.js",
      "diagnostics",
      "--file",
      path.join(rootPath, "src", "index.ts"),
      "--file",
      path.join(rootPath, "src", "other.ts"),
      "--language",
      "typescript",
      "--root",
      rootPath
    ]);
    expect(result).toEqual({
      exitCode: 0,
      stdout: "[codex-lsp-bridge] LSP diagnostics clean for 2 touched supported source file(s); not a full project type-check.\n"
    });
  });

  it("characterizes deferred IPC diagnostics before subprocess fallback", async () => {
    rootPath = await makeWorkspace();
    await fs.mkdir(path.join(rootPath, "src"), { recursive: true });
    await fs.writeFile(path.join(rootPath, "src", "index.ts"), "export {}\n");
    await writeIpcMetadata(rootPath);

    let ipcRequest;
    const result = await runPostToolUseDiagnostics({
      input: JSON.stringify({ file_path: "src/index.ts" }),
      cwd: rootPath,
      env: {},
      bridgeCli: "dist/index.js",
      spawnSyncImpl: () => {
        throw new Error("subprocess fallback should not run when IPC succeeds");
      },
      sendIpcRequestImpl: async (endpoint, request, timeoutMs) => {
        ipcRequest = { endpoint, request, timeoutMs };
        return {
          ok: true,
          result: { status: "ok", timedOut: false, stale: false, total: 0, bySeverity: {}, items: [] }
        };
      }
    });

    expect(ipcRequest.endpoint).toBe("ipc-endpoint");
    expect(ipcRequest.request.files).toEqual([path.join(rootPath, "src", "index.ts")]);
    expect(ipcRequest.timeoutMs).toBe(200);
    expect(result.stdout).toBe(
      "[codex-lsp-bridge] LSP diagnostics clean for 1 touched supported source file(s); not a full project type-check.\n"
    );
  });

  it("characterizes helper fallback when deferred IPC is unavailable", async () => {
    rootPath = await makeWorkspace();
    const binPath = path.join(rootPath, "fake-bin");
    await fs.mkdir(path.join(rootPath, "src"), { recursive: true });
    await fs.mkdir(binPath);
    await fs.writeFile(path.join(rootPath, "src", "index.ts"), "export {}\n");
    await makeExecutable(path.join(binPath, "typescript-language-server"));
    await makeExecutable(path.join(binPath, "typescript-language-server.cmd"));
    await writeIpcMetadata(rootPath);

    const calls = [];
    const result = await runPostToolUseDiagnostics({
      input: JSON.stringify({ file_path: "src/index.ts" }),
      cwd: rootPath,
      env: { PATH: binPath },
      bridgeCli: "dist/index.js",
      processExecPath: "node",
      sendIpcRequestImpl: async () => undefined,
      spawnSyncImpl: (command, args, options) => {
        calls.push({ command, args });
        return {
          status: 0,
          stdout: JSON.stringify({ status: "ok", timedOut: false, stale: false, total: 0, bySeverity: {}, items: [] }),
          stderr: ""
        };
      }
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].args).toContain("diagnostics");
    expect(result.stdout).toBe(
      "[codex-lsp-bridge] LSP diagnostics clean for 1 touched supported source file(s); not a full project type-check.\n"
    );
  });

  it("fails closed when IPC rejects the trust boundary", async () => {
    rootPath = await makeWorkspace();
    await fs.mkdir(path.join(rootPath, "src"), { recursive: true });
    await fs.writeFile(path.join(rootPath, "src", "index.ts"), "export {}\n");
    await writeIpcMetadata(rootPath);

    const result = await runPostToolUseDiagnostics({
      input: JSON.stringify({ file_path: "src/index.ts" }),
      cwd: rootPath,
      env: {},
      bridgeCli: "dist/index.js",
      spawnSyncImpl: () => {
        throw new Error("subprocess fallback should not run when IPC rejects the trust boundary");
      },
      sendIpcRequestImpl: async () => ({ ok: false, error: { kind: "security", message: "IPC security: secret mismatch" } })
    });

    expect(result).toEqual({
      exitCode: 1,
      stdout: "[codex-lsp-bridge] IPC diagnostics rejected: IPC security: secret mismatch\n"
    });
  });

  it("reuses cached diagnostics for an unchanged exact file state", async () => {
    rootPath = await makeWorkspace();
    const binPath = path.join(rootPath, "fake-bin");
    await fs.mkdir(path.join(rootPath, "src"), { recursive: true });
    await fs.mkdir(binPath);
    await fs.writeFile(path.join(rootPath, "src", "index.ts"), "export {}\n");
    await makeExecutable(path.join(binPath, "typescript-language-server"));
    await makeExecutable(path.join(binPath, "typescript-language-server.cmd"));

    let calls = 0;
    const run = () =>
      runPostToolUseDiagnostics({
        input: JSON.stringify({ file_path: "src/index.ts" }),
        cwd: rootPath,
        env: { PATH: binPath, CODEX_LSP_HOOK_DISABLE_IPC: "1" },
        bridgeCli: "dist/index.js",
        processExecPath: "node",
        spawnSyncImpl: () => {
          calls += 1;
          return {
            status: 0,
            stdout: JSON.stringify({ status: "ok", timedOut: false, stale: false, total: 0, bySeverity: {}, items: [] }),
            stderr: ""
          };
        }
      });

    await run();
    const second = await run();

    expect(calls).toBe(1);
    expect(second.stdout).toBe(
      "[codex-lsp-bridge] LSP diagnostics clean for 1 touched supported source file(s); not a full project type-check.\n"
    );
  });

  it("invalidates cached diagnostics when file content changes", async () => {
    rootPath = await makeWorkspace();
    const binPath = path.join(rootPath, "fake-bin");
    await fs.mkdir(path.join(rootPath, "src"), { recursive: true });
    await fs.mkdir(binPath);
    await fs.writeFile(path.join(rootPath, "src", "index.ts"), "export const a = 1;\n");
    await makeExecutable(path.join(binPath, "typescript-language-server"));
    await makeExecutable(path.join(binPath, "typescript-language-server.cmd"));

    let calls = 0;
    const run = () =>
      runPostToolUseDiagnostics({
        input: JSON.stringify({ file_path: "src/index.ts" }),
        cwd: rootPath,
        env: { PATH: binPath, CODEX_LSP_HOOK_DISABLE_IPC: "1" },
        bridgeCli: "dist/index.js",
        processExecPath: "node",
        spawnSyncImpl: () => {
          calls += 1;
          return {
            status: 0,
            stdout: JSON.stringify({ status: "ok", timedOut: false, stale: false, total: 0, bySeverity: {}, items: [] }),
            stderr: ""
          };
        }
      });

    await run();
    await fs.writeFile(path.join(rootPath, "src", "index.ts"), "export const a = 2;\n");
    await run();

    expect(calls).toBe(2);
  });

  it("invalidates cached diagnostics when project config changes", async () => {
    rootPath = await makeWorkspace();
    const binPath = path.join(rootPath, "fake-bin");
    await fs.mkdir(path.join(rootPath, "src"), { recursive: true });
    await fs.mkdir(binPath);
    await fs.writeFile(path.join(rootPath, "src", "index.ts"), "export {}\n");
    await fs.writeFile(path.join(rootPath, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
    await makeExecutable(path.join(binPath, "typescript-language-server"));
    await makeExecutable(path.join(binPath, "typescript-language-server.cmd"));

    let calls = 0;
    const run = () =>
      runPostToolUseDiagnostics({
        input: JSON.stringify({ file_path: "src/index.ts" }),
        cwd: rootPath,
        env: { PATH: binPath, CODEX_LSP_HOOK_DISABLE_IPC: "1" },
        bridgeCli: "dist/index.js",
        processExecPath: "node",
        spawnSyncImpl: () => {
          calls += 1;
          return {
            status: 0,
            stdout: JSON.stringify({ status: "ok", timedOut: false, stale: false, total: 0, bySeverity: {}, items: [] }),
            stderr: ""
          };
        }
      });

    await run();
    await fs.writeFile(path.join(rootPath, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: false } }));
    await run();

    expect(calls).toBe(2);
  });

  it("fails open when the diagnostics cache cannot be read", async () => {
    rootPath = await makeWorkspace();
    const binPath = path.join(rootPath, "fake-bin");
    await fs.mkdir(path.join(rootPath, "src"), { recursive: true });
    await fs.mkdir(binPath);
    await fs.writeFile(path.join(rootPath, "src", "index.ts"), "export {}\n");
    await fs.writeFile(diagnosticsCachePath(rootPath), "{bad json");
    await makeExecutable(path.join(binPath, "typescript-language-server"));
    await makeExecutable(path.join(binPath, "typescript-language-server.cmd"));

    let calls = 0;
    const result = await runPostToolUseDiagnostics({
      input: JSON.stringify({ file_path: "src/index.ts" }),
      cwd: rootPath,
      env: { PATH: binPath, CODEX_LSP_HOOK_DISABLE_IPC: "1" },
      bridgeCli: "dist/index.js",
      processExecPath: "node",
      spawnSyncImpl: () => {
        calls += 1;
        return {
          status: 0,
          stdout: JSON.stringify({ status: "ok", timedOut: false, stale: false, total: 0, bySeverity: {}, items: [] }),
          stderr: ""
        };
      }
    });

    expect(calls).toBe(1);
    expect(result.stdout).toBe(
      "[codex-lsp-bridge] LSP diagnostics clean for 1 touched supported source file(s); not a full project type-check.\n"
    );
  });
});

async function makeWorkspace() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lsp-hook-root-"));
  await fs.writeFile(path.join(directory, "package.json"), "{}\n");
  return directory;
}

async function makeExecutable(filePath) {
  await fs.writeFile(filePath, "echo ok\n");
  await fs.chmod(filePath, 0o755);
}

async function writeIpcMetadata(root) {
  await fs.writeFile(
    diagnosticsIpcMetadataPath(root),
    JSON.stringify({
      protocolVersion: 1,
      root,
      rootHash: hashRoot(root),
      endpoint: "ipc-endpoint",
      secret: "secret",
      pid: process.pid
    }),
    "utf8"
  );
}
