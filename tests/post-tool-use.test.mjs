import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectTouchedFiles,
  findWorkspaceRoot,
  groupFilesByLanguage,
  resolveTouchedFiles,
  runPostToolUseDiagnostics
} from "../scripts/codex-lsp-post-tool-use-core.mjs";

describe("post-tool-use diagnostics hook", () => {
  let rootPath = "";
  let outsidePath = "";

  afterEach(async () => {
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
    await fs.writeFile(path.join(rootPath, "src", "notes.md"), "# notes\n");
    await fs.writeFile(path.join(outsidePath, "outside.ts"), "export {}\n");

    const files = resolveTouchedFiles(
      {
        file_path: "src/index.ts",
        other: path.join(outsidePath, "outside.ts"),
        notes: "src/notes.md"
      },
      { repoRoot: rootPath, maxFiles: 5 }
    );

    expect(files).toEqual([path.join(rootPath, "src", "index.ts")]);
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
    expect([...groupFilesByLanguage(["a.ts", "b.js", "main.py", "lib.rs", "main.go"])]).toEqual([
      ["typescript", ["a.ts", "b.js"]],
      ["python", ["main.py"]],
      ["rust", ["lib.rs"]],
      ["go", ["main.go"]]
    ]);
  });

  it("reports skipped diagnostics when language servers are missing and verbose pending is enabled", async () => {
    rootPath = await makeWorkspace();
    await fs.mkdir(path.join(rootPath, "src"), { recursive: true });
    await fs.writeFile(path.join(rootPath, "src", "index.ts"), "export {}\n");

    const result = runPostToolUseDiagnostics({
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

  it("prints clean diagnostics output from the batched subprocess path", async () => {
    rootPath = await makeWorkspace();
    const binPath = path.join(rootPath, "fake-bin");
    await fs.mkdir(path.join(rootPath, "src"), { recursive: true });
    await fs.mkdir(binPath);
    await fs.writeFile(path.join(rootPath, "src", "index.ts"), "export {}\n");
    await fs.writeFile(path.join(rootPath, "src", "other.ts"), "export {}\n");
    await makeExecutable(path.join(binPath, "typescript-language-server"));
    await makeExecutable(path.join(binPath, "typescript-language-server.cmd"));

    const calls = [];
    const result = runPostToolUseDiagnostics({
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
