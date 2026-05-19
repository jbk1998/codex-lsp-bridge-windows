import fs from "node:fs";
import path from "node:path";

export type DiagnosticsTimeoutPolicy = number | "auto";

export interface ResolvedDiagnosticsTimeout {
  timeoutMs: number;
  policy: "fixed" | "auto";
  reasons: string[];
}

const defaultDiagnosticsTimeoutMs = 15000;
const maxAutoDiagnosticsTimeoutMs = 60000;
const maxReferenceBonusMs = 20000;
const maxSourceFilesToSample = 501;
const skippedDirectories = new Set([".git", ".next", ".turbo", "build", "coverage", "dist", "node_modules"]);

export function readDiagnosticsTimeoutPolicy(value: unknown, fallback: DiagnosticsTimeoutPolicy): DiagnosticsTimeoutPolicy {
  if (value === "auto") return "auto";
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  return fallback;
}

export function resolveDiagnosticsTimeout(rootPath: string, policy: DiagnosticsTimeoutPolicy = defaultDiagnosticsTimeoutMs): ResolvedDiagnosticsTimeout {
  if (policy !== "auto") {
    return {
      timeoutMs: policy,
      policy: "fixed",
      reasons: [`configured ${policy}ms`]
    };
  }

  const hints = inspectWorkspaceHints(rootPath);
  let timeoutMs = defaultDiagnosticsTimeoutMs;
  const reasons = [`base ${defaultDiagnosticsTimeoutMs}ms`];

  if (hints.hasMonorepoMarker) {
    timeoutMs += 10000;
    reasons.push("monorepo marker +10000ms");
  }
  if (hints.projectReferences > 0) {
    const bonus = Math.min(hints.projectReferences * 1000, maxReferenceBonusMs);
    timeoutMs += bonus;
    reasons.push(`tsconfig references ${hints.projectReferences} +${bonus}ms`);
  }
  if (hints.sampledSourceFiles >= maxSourceFilesToSample) {
    timeoutMs += 10000;
    reasons.push(`source files sampled ${maxSourceFilesToSample - 1}+ +10000ms`);
  }

  return {
    timeoutMs: Math.min(timeoutMs, maxAutoDiagnosticsTimeoutMs),
    policy: "auto",
    reasons
  };
}

function inspectWorkspaceHints(rootPath: string): { hasMonorepoMarker: boolean; projectReferences: number; sampledSourceFiles: number } {
  return {
    hasMonorepoMarker: hasMonorepoMarker(rootPath),
    projectReferences: countTsconfigReferences(path.join(rootPath, "tsconfig.json")),
    sampledSourceFiles: countSourceFiles(rootPath)
  };
}

function hasMonorepoMarker(rootPath: string): boolean {
  if (fileExists(path.join(rootPath, "pnpm-workspace.yaml"))) return true;
  if (fileExists(path.join(rootPath, "turbo.json"))) return true;
  if (fileExists(path.join(rootPath, "nx.json"))) return true;

  const packageJson = readJson(path.join(rootPath, "package.json"));
  const workspaces = packageJson?.workspaces;
  return Array.isArray(workspaces) || (typeof workspaces === "object" && workspaces !== null);
}

function countTsconfigReferences(filePath: string): number {
  const tsconfig = readJson(filePath);
  return Array.isArray(tsconfig?.references) ? tsconfig.references.length : 0;
}

function countSourceFiles(rootPath: string): number {
  const queue = [rootPath];
  let count = 0;
  while (queue.length > 0 && count < maxSourceFilesToSample) {
    const directory = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!skippedDirectories.has(entry.name)) queue.push(entryPath);
        continue;
      }
      if (entry.isFile() && isSourceFile(entry.name)) {
        count += 1;
        if (count >= maxSourceFilesToSample) return count;
      }
    }
  }
  return count;
}

function isSourceFile(fileName: string): boolean {
  return [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"].includes(path.extname(fileName));
}

function readJson(filePath: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function fileExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}
