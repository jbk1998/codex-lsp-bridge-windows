import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findWorkspaceRootSync,
  isPathInsideWorkspaceRootSync,
  resolvePathInsideWorkspaceRootSync,
  resolveExplicitWorkspaceRootSync,
  resolveRequestedRootSync,
  shouldSelectWorkspaceService,
  workspaceRootIdentitySync
} from "../src/core/workspace-root.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((temporaryRoot) => fs.rm(temporaryRoot, { recursive: true, force: true })));
});

async function makeTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(directory);
  return directory;
}

describe("workspace root resolution", () => {
  it("recognizes a skill package as an explicit workspace root", async () => {
    const skillRoot = await makeTemporaryDirectory("codex-lsp-skill-");
    await fs.writeFile(path.join(skillRoot, "SKILL.md"), "# Test skill\n");

    expect(resolveExplicitWorkspaceRootSync(skillRoot)).toBe(path.resolve(skillRoot));
  });

  it("auto-detects a skill root from an absolute file outside the startup workspace", async () => {
    const startupRoot = await makeTemporaryDirectory("codex-lsp-startup-");
    const skillRoot = await makeTemporaryDirectory("codex-lsp-skill-");
    const scriptDirectory = path.join(skillRoot, "scripts");
    const scriptPath = path.join(scriptDirectory, "verify.py");
    await fs.writeFile(path.join(startupRoot, "package.json"), "{}\n");
    await fs.writeFile(path.join(skillRoot, "SKILL.md"), "# Test skill\n");
    await fs.mkdir(scriptDirectory);
    await fs.writeFile(scriptPath, "print('ok')\n");

    expect(resolveRequestedRootSync(startupRoot, { file: scriptPath })).toBe(path.resolve(skillRoot));
    expect(findWorkspaceRootSync(scriptDirectory)).toBe(path.resolve(skillRoot));
    expect(shouldSelectWorkspaceService({ file: scriptPath })).toBe(true);
  });

  it("auto-detects a standalone skill root for an ESM module", async () => {
    const skillRoot = await makeTemporaryDirectory("codex-lsp-skill-mjs-");
    const scriptDirectory = path.join(skillRoot, "scripts");
    const scriptPath = path.join(scriptDirectory, "module.mjs");
    await fs.writeFile(path.join(skillRoot, "SKILL.md"), "# Test skill\n");
    await fs.mkdir(scriptDirectory);
    await fs.writeFile(scriptPath, "export const ready = true;\n");

    expect(resolveRequestedRootSync(process.cwd(), { file: scriptPath })).toBe(path.resolve(skillRoot));
    expect(shouldSelectWorkspaceService({ file: scriptPath })).toBe(true);
  });

  it.each(["pyproject.toml", "pyrightconfig.json", "go.mod", ".lsp-root"])(
    "recognizes %s as a workspace marker",
    async (marker) => {
      const projectRoot = await makeTemporaryDirectory("codex-lsp-project-");
      await fs.writeFile(path.join(projectRoot, marker), "\n");

      expect(resolveExplicitWorkspaceRootSync(projectRoot)).toBe(path.resolve(projectRoot));
    }
  );

  it("keeps relative targets in the startup workspace", async () => {
    const startupRoot = await makeTemporaryDirectory("codex-lsp-startup-");
    await fs.writeFile(path.join(startupRoot, "package.json"), "{}\n");

    expect(resolveRequestedRootSync(startupRoot, { file: "src/index.ts" })).toBe(path.resolve(startupRoot));
    expect(shouldSelectWorkspaceService({ file: "src/index.ts" })).toBe(false);
  });

  it("keeps dot-prefixed child paths inside the startup workspace", async () => {
    const startupRoot = await makeTemporaryDirectory("codex-lsp-startup-");
    const childPath = path.join(startupRoot, "..cache", "index.ts");
    await fs.writeFile(path.join(startupRoot, "package.json"), "{}\n");

    expect(resolveRequestedRootSync(startupRoot, { file: childPath })).toBe(path.resolve(startupRoot));
  });

  it("fails closed for an explicit markerless root", async () => {
    const markerlessRoot = await makeTemporaryDirectory("codex-lsp-markerless-");

    expect(() => resolveExplicitWorkspaceRootSync(markerlessRoot)).toThrow("Workspace root is not recognized");
  });

  it("coalesces a directory junction alias while preserving the root boundary", async () => {
    const root = await makeTemporaryDirectory("codex-lsp-canonical-root-");
    const aliasParent = await makeTemporaryDirectory("codex-lsp-canonical-alias-");
    const alias = path.join(aliasParent, "alias");
    await fs.writeFile(path.join(root, "package.json"), "{}\n");

    try {
      await fs.symlink(root, alias, "junction");
    } catch (error) {
      const errorCode = error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
      if (process.platform === "win32" && errorCode === "EPERM") return;
      throw error;
    }

    expect(workspaceRootIdentitySync(root)).toBe(workspaceRootIdentitySync(alias));
    expect(isPathInsideWorkspaceRootSync(path.join(alias, "src", "index.ts"), root)).toBe(true);
    expect(isPathInsideWorkspaceRootSync(path.join(aliasParent, "outside.ts"), root)).toBe(false);
  });

  it("rejects a target that enters an outside directory through a junction", async () => {
    const root = await makeTemporaryDirectory("codex-lsp-root-boundary-");
    const outside = await makeTemporaryDirectory("codex-lsp-root-outside-");
    const linkedDirectory = path.join(root, "linked");
    await fs.writeFile(path.join(root, "package.json"), "{}\n");
    await fs.writeFile(path.join(outside, "escape.ts"), "export const escaped = true;\n");

    try {
      await fs.symlink(outside, linkedDirectory, "junction");
    } catch (error) {
      const errorCode = error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
      if (process.platform === "win32" && errorCode === "EPERM") return;
      throw error;
    }

    expect(() => resolvePathInsideWorkspaceRootSync(root, path.join("linked", "escape.ts"))).toThrow(
      "outside workspace root"
    );
  });
});
