import { constants as fsConstants, existsSync, realpathSync, statSync } from "node:fs";
import fs from "node:fs/promises";
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
  "jsconfig.json",
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

export interface WorkspaceFileIdentity {
  dev: number;
  ino: number;
}

export function resolveRequestedRootSync(fallbackRoot: string, params: Record<string, unknown>): string {
  if (typeof params.root === "string") return resolveExplicitWorkspaceRootSync(params.root);

  const resolvedFallbackRoot = canonicalizeWorkspaceRootSync(fallbackRoot);
  const target = readAbsoluteWorkspaceTarget(params);
  if (!target) return resolvedFallbackRoot;

  return (
    findWorkspaceRootSync(target.startDirectory) ??
    (isDirectorySync(target.startDirectory) ? canonicalizeWorkspaceRootSync(target.startDirectory) : resolvedFallbackRoot)
  );
}

export function resolveExplicitWorkspaceRootSync(root: string): string {
  const resolvedRoot = canonicalizeWorkspaceRootSync(root);
  if (!isDirectorySync(resolvedRoot)) {
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

/**
 * Read a workspace file through a descriptor whose target is revalidated
 * immediately before and after the read.
 *
 * Path containment checks alone are vulnerable to a replacement between the
 * check and a later path-based read. Opening the expected canonical path and
 * comparing the descriptor identity with the still-canonical path prevents a
 * substituted file (including a symlink/junction escape) from reaching an
 * LSP notification.
 */
export async function readVerifiedWorkspaceFileUtf8(
  rootPath: string,
  expectedRootPath: string,
  expectedTargetPath: string,
  expectedTargetIdentity?: WorkspaceFileIdentity
): Promise<string> {
  const canonicalRootPath = normalizePathIdentity(expectedRootPath);
  const canonicalTargetPath = normalizePathIdentity(expectedTargetPath);
  assertCanonicalTargetInsideRoot(canonicalTargetPath, canonicalRootPath, expectedTargetPath);

  const initialTargetStats = await revalidateWorkspaceFilePath(rootPath, canonicalRootPath, canonicalTargetPath);
  if (expectedTargetIdentity && !sameFileIdentity(initialTargetStats, expectedTargetIdentity)) {
    throw new Error(`Workspace file changed while reading: ${canonicalTargetPath}`);
  }
  const readFlags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  let fileHandle: fs.FileHandle | undefined;

  try {
    try {
      fileHandle = await fs.open(expectedTargetPath, readFlags);
    } catch (error) {
      // A final-component symlink can be rejected by O_NOFOLLOW before the
      // asynchronous revalidation below gets a chance to report the boundary
      // violation. Re-run validation to preserve the fail-closed path error.
      await revalidateWorkspaceFilePath(rootPath, canonicalRootPath, canonicalTargetPath);
      throw error;
    }

    await assertOpenedWorkspaceFile(
      fileHandle,
      rootPath,
      canonicalRootPath,
      canonicalTargetPath,
      initialTargetStats,
      expectedTargetIdentity
    );
    const text = await fileHandle.readFile("utf8");
    await assertOpenedWorkspaceFile(
      fileHandle,
      rootPath,
      canonicalRootPath,
      canonicalTargetPath,
      initialTargetStats,
      expectedTargetIdentity
    );
    return text;
  } finally {
    await fileHandle?.close();
  }
}

export function workspaceRootIdentitySync(rootPath: string): string {
  return normalizePathIdentity(realPathForIdentitySync(rootPath));
}

/**
 * Returns a stable identity for the current directory instance, not just its
 * canonical path. Mutable metadata timestamps are deliberately excluded so
 * ordinary activity inside a workspace cannot look like delete/recreate.
 */
export function workspaceRootInstanceIdentitySync(rootPath: string): string {
  const canonicalRoot = workspaceRootIdentitySync(rootPath);
  try {
    const stats = statSync(canonicalRoot);
    const stableFileId = `${stats.dev}:${stats.ino}`;
    const creationEvidence = Number.isFinite(stats.birthtimeMs) ? stats.birthtimeMs : 0;
    return `${canonicalRoot}\u0000${stableFileId}:${creationEvidence}`;
  } catch {
    return `${canonicalRoot}\u0000missing`;
  }
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

function isDirectorySync(directory: string): boolean {
  try {
    return statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

function readAbsoluteWorkspaceTarget(params: Record<string, unknown>): { path: string; startDirectory: string } | undefined {
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

function normalizePathIdentity(targetPath: string): string {
  const normalized = normalizePathForAccess(targetPath);
  if (process.platform !== "win32") return normalized;

  // Windows can return an ordinary drive path from fs.realpath() and an
  // extended-length path from realpathSync.native(). They identify the same
  // directory, but path.relative() treats the extended-length namespace as a
  // different root. Normalize the aliases only for identity/containment
  // comparisons; callers still use the original path for filesystem access.
  let comparable = normalized.replaceAll("/", "\\\\");
  if (comparable.startsWith("\\\\?\\UNC\\")) {
    comparable = `\\\\${comparable.slice("\\\\?\\UNC\\".length)}`;
  } else if (comparable.startsWith("\\\\?\\")) {
    comparable = comparable.slice("\\\\?\\".length);
  }
  return path.win32.normalize(comparable).toLowerCase();
}

function assertCanonicalTargetInsideRoot(canonicalTargetPath: string, canonicalRootPath: string, displayTargetPath: string): void {
  if (!isCanonicalPathInsideRoot(canonicalTargetPath, canonicalRootPath)) {
    throw new Error(`File is outside workspace root: ${displayTargetPath}`);
  }
}

async function revalidateWorkspaceFilePath(
  rootPath: string,
  canonicalRootPath: string,
  canonicalTargetPath: string
): Promise<import("node:fs").Stats> {
  const currentRootPath = normalizePathIdentity(await fs.realpath(rootPath));
  if (currentRootPath !== canonicalRootPath) {
    throw new Error(`Workspace root changed while reading: ${rootPath}`);
  }

  const currentTargetPath = normalizePathIdentity(await fs.realpath(canonicalTargetPath));
  assertCanonicalTargetInsideRoot(currentTargetPath, canonicalRootPath, canonicalTargetPath);
  if (currentTargetPath !== canonicalTargetPath) {
    throw new Error(`Workspace file changed while reading: ${canonicalTargetPath}`);
  }

  const targetStats = await fs.stat(canonicalTargetPath);
  if (!targetStats.isFile()) {
    throw new Error(`Workspace target is not a file: ${canonicalTargetPath}`);
  }
  if (!hasStableFileIdentity(targetStats)) {
    throw new Error(`Unable to verify workspace file identity: ${canonicalTargetPath}`);
  }
  return targetStats;
}

async function assertOpenedWorkspaceFile(
  fileHandle: fs.FileHandle,
  rootPath: string,
  canonicalRootPath: string,
  canonicalTargetPath: string,
  initialTargetStats: import("node:fs").Stats,
  expectedTargetIdentity?: WorkspaceFileIdentity
): Promise<void> {
  const currentTargetStats = await revalidateWorkspaceFilePath(rootPath, canonicalRootPath, canonicalTargetPath);
  const openedTargetStats = await fileHandle.stat();
  if (
    !sameFileIdentity(openedTargetStats, initialTargetStats) ||
    !sameFileIdentity(openedTargetStats, currentTargetStats) ||
    (expectedTargetIdentity !== undefined && !sameFileIdentity(openedTargetStats, expectedTargetIdentity))
  ) {
    throw new Error(`Workspace file changed while reading: ${canonicalTargetPath}`);
  }
}

function hasStableFileIdentity(stats: import("node:fs").Stats): boolean {
  return Number.isFinite(stats.dev) && Number.isFinite(stats.ino) && stats.dev !== 0 && stats.ino !== 0;
}

function sameFileIdentity(
  left: import("node:fs").Stats | WorkspaceFileIdentity,
  right: import("node:fs").Stats | WorkspaceFileIdentity
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isCanonicalPathInsideRoot(targetPath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
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
