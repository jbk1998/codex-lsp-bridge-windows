import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRootMarkers = [
  ".git",
  ".lsp-root",
  "AGENTS.md",
  "CLAUDE.md",
  "SKILL.md",
  "package.json",
  "tsconfig.json",
  "deno.json",
  "deno.jsonc",
  "Cargo.toml",
  "pyproject.toml",
  "pyrightconfig.json",
  "setup.py",
  "setup.cfg",
  "requirements.txt",
  "go.mod",
  "go.work"
] as const;

export function resolveRequestedRootSync(fallbackRoot: string, params: Record<string, unknown>): string {
  if (typeof params.root === "string") return resolveExplicitWorkspaceRootSync(params.root);

  const resolvedFallbackRoot = path.resolve(fallbackRoot);
  const target = readAbsoluteWorkspaceTarget(params);
  if (!target || isInsideRoot(target.path, resolvedFallbackRoot)) return resolvedFallbackRoot;

  return findWorkspaceRootSync(target.startDirectory) ?? resolvedFallbackRoot;
}

export function resolveExplicitWorkspaceRootSync(root: string): string {
  const resolvedRoot = path.resolve(root);
  if (!isWorkspaceRootSync(resolvedRoot)) {
    throw new Error(`Workspace root is not recognized: ${resolvedRoot}`);
  }
  return resolvedRoot;
}

export function findWorkspaceRootSync(startDirectory: string): string | undefined {
  let current = path.resolve(startDirectory);

  while (true) {
    if (isWorkspaceRootSync(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function shouldSelectWorkspaceService(params: Record<string, unknown>): boolean {
  return typeof params.root === "string" || readAbsoluteWorkspaceTarget(params) !== undefined;
}

function isWorkspaceRootSync(directory: string): boolean {
  return workspaceRootMarkers.some((marker) => existsSync(path.join(directory, marker)));
}

function readAbsoluteWorkspaceTarget(
  params: Record<string, unknown>
): { path: string; startDirectory: string } | undefined {
  if (typeof params.file === "string" && path.isAbsolute(params.file)) {
    const filePath = path.resolve(params.file);
    return { path: filePath, startDirectory: path.dirname(filePath) };
  }
  if (typeof params.dir === "string" && path.isAbsolute(params.dir)) {
    const directory = path.resolve(params.dir);
    return { path: directory, startDirectory: directory };
  }
  if (typeof params.uri === "string") {
    try {
      const filePath = fileURLToPath(params.uri);
      return { path: filePath, startDirectory: path.dirname(filePath) };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function isInsideRoot(targetPath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
