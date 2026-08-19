import { existsSync, realpathSync } from "node:fs";
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

  const resolvedFallbackRoot = canonicalizeWorkspaceRootSync(fallbackRoot);
  const target = readAbsoluteWorkspaceTarget(params);
  if (!target || isInsideRoot(target.path, resolvedFallbackRoot)) return resolvedFallbackRoot;

  return findWorkspaceRootSync(target.startDirectory) ?? resolvedFallbackRoot;
}

export function resolveExplicitWorkspaceRootSync(root: string): string {
  const resolvedRoot = canonicalizeWorkspaceRootSync(root);
  if (!isWorkspaceRootSync(resolvedRoot)) {
    throw new Error(`Workspace root is not recognized: ${resolvedRoot}`);
  }
  return resolvedRoot;
}

export function findWorkspaceRootSync(startDirectory: string): string | undefined {
  let current = path.resolve(startDirectory);

  while (true) {
    if (isWorkspaceRootSync(current)) return canonicalizeWorkspaceRootSync(current);
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function canonicalizeWorkspaceRootSync(rootPath: string): string {
  const resolvedRoot = path.resolve(rootPath);
  try {
    return normalizePathForAccess(realpathSync(resolvedRoot));
  } catch {
    return normalizePathForAccess(resolvedRoot);
  }
}

export function canonicalizeTargetPathSync(targetPath: string): string {
  const resolvedTarget = path.resolve(targetPath);
  try {
    return normalizePathForAccess(realpathSync(resolvedTarget));
  } catch {
    return normalizePathForAccess(resolvedTarget);
  }
}

export function resolvePathInsideWorkspaceRootSync(rootPath: string, targetPath: string): string {
  const resolvedRoot = canonicalizeWorkspaceRootSync(rootPath);
  const normalizedTargetPath = normalizeInputPathSeparators(targetPath);
  const resolvedTarget = path.isAbsolute(normalizedTargetPath)
    ? path.resolve(normalizedTargetPath)
    : path.resolve(resolvedRoot, normalizedTargetPath);
  const canonicalTarget = canonicalizeTargetPathSync(resolvedTarget);
  if (!isPathInsideWorkspaceRootSync(canonicalTarget, resolvedRoot)) {
    throw new Error(`Path is outside workspace root: ${resolvedTarget}`);
  }
  return canonicalTarget;
}

export function workspaceRootIdentitySync(rootPath: string): string {
  return normalizePathIdentity(realPathForIdentitySync(rootPath));
}

export function isPathInsideWorkspaceRootSync(targetPath: string, rootPath: string): boolean {
  const target = normalizePathIdentity(realPathForIdentitySync(targetPath));
  const root = workspaceRootIdentitySync(rootPath);
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
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
  const relative = path.relative(workspaceRootIdentitySync(rootPath), normalizePathIdentity(realPathForIdentitySync(targetPath)));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function normalizePathIdentity(targetPath: string): string {
  const normalized = normalizePathForAccess(targetPath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function normalizePathForAccess(targetPath: string): string {
  const normalized = path.normalize(targetPath);
  /* c8 ignore next -- Darwin's /private/var namespace alias is not reachable on other CI hosts. */
  if (process.platform === "darwin" && normalized.startsWith("/private/var/")) {
    return normalized.slice("/private".length);
  }
  return normalized;
}

function normalizeInputPathSeparators(targetPath: string): string {
  return process.platform === "win32" ? targetPath : targetPath.replaceAll("\\", "/");
}

function realPathForIdentitySync(targetPath: string): string {
  let current = path.resolve(targetPath);
  const missingSegments: string[] = [];
  try {
    while (true) {
      try {
        const resolvedCurrent = realpathSync.native(current);
        return path.join(resolvedCurrent, ...missingSegments.reverse());
      } catch {
        const parent = path.dirname(current);
        if (parent === current) return path.resolve(targetPath);
        missingSegments.push(path.basename(current));
        current = parent;
      }
    }
  } catch {
    return path.resolve(targetPath);
  }
}
