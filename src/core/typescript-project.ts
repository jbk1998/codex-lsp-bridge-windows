import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const bridgeRequire = createRequire(import.meta.url);

interface TypeRootResolution {
  typeRoots: string[];
  primaryRoots: string[];
}

export interface InferredTypeScriptProjectOptions {
  typeRoots: string[];
  types: string[];
  compilerOptions: Record<string, unknown>;
}

/**
 * Find Node declaration packages that the TypeScript server can use for an
 * inferred JavaScript project. This intentionally reads the runtime layout
 * instead of hard-coding a user or install path.
 */
export function resolveNodeTypeRoots(rootPath: string, runtimePath = process.execPath): string[] {
  return resolveTypeRoots(rootPath, runtimePath).typeRoots.filter(hasNodeTypePackage);
}

export function resolveInferredTypeScriptProjectOptions(
  rootPath: string,
  runtimePath = process.execPath
): InferredTypeScriptProjectOptions | undefined {
  const resolution = resolveTypeRoots(rootPath, runtimePath);
  const typeRoots = resolution.typeRoots;
  const types = uniqueStrings(resolution.primaryRoots.flatMap(listTypePackages));
  if (typeRoots.some(hasNodeTypePackage) && !types.includes("node")) types.push("node");
  if (!types.includes("node")) return undefined;

  return {
    typeRoots,
    types,
    compilerOptions: {
      allowJs: true,
      allowNonTsExtensions: true,
      checkJs: false,
      allowSyntheticDefaultImports: true,
      resolveJsonModule: true,
      module: "preserve",
      moduleResolution: "bundler",
      target: "es2022",
      jsx: "react-jsx",
      noImplicitAny: false,
      strict: false,
      sourceMap: true,
      allowImportingTsExtensions: true,
      types,
      typeRoots
    }
  };
}

function resolveTypeRoots(rootPath: string, runtimePath: string): TypeRootResolution {
  const primaryCandidates = [...ancestorTypeRoots(rootPath), ...runtimeTypeRoots(runtimePath)];
  const primaryRoots = uniquePaths(primaryCandidates.filter((candidate) => hasTypePackages(candidate)));
  if (primaryRoots.some(hasNodeTypePackage)) return { typeRoots: primaryRoots, primaryRoots };

  return {
    typeRoots: uniquePaths([...primaryRoots, ...bridgeTypeRoots()].filter((candidate) => hasTypePackages(candidate))),
    primaryRoots
  };
}

function ancestorTypeRoots(rootPath: string): string[] {
  const roots: string[] = [];
  let current = path.resolve(rootPath);

  while (true) {
    roots.push(path.join(current, "node_modules", "@types"));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return roots;
}

function runtimeTypeRoots(runtimePath: string): string[] {
  let current = path.dirname(path.resolve(runtimePath));

  while (true) {
    const nodeModulesPath = path.join(current, "node_modules");
    if (isDirectory(nodeModulesPath)) {
      // The nearest node_modules directory is the runtime package boundary.
      const typeRoot = path.join(nodeModulesPath, "@types");
      return hasTypePackages(typeRoot) ? [typeRoot] : [];
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return [];
}

function bridgeTypeRoots(): string[] {
  // @types/node is a runtime dependency so this fallback also works in an installed package.
  try {
    const packageJsonPath = bridgeRequire.resolve("@types/node/package.json");
    return [path.dirname(path.dirname(packageJsonPath))];
  } catch {
    return [];
  }
}

function isDirectory(directory: string): boolean {
  try {
    return fs.statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

function hasNodeTypePackage(typeRoot: string): boolean {
  return hasTypePackage(typeRoot, "node");
}

function hasTypePackages(typeRoot: string): boolean {
  try {
    return fs.readdirSync(typeRoot, { withFileTypes: true }).some((entry) => {
      if (entry.name.startsWith(".")) return false;
      return (entry.isDirectory() || entry.isSymbolicLink()) && hasTypePackage(typeRoot, entry.name);
    });
  } catch {
    return false;
  }
}

function hasTypePackage(typeRoot: string, packageName: string): boolean {
  const packagePath = path.join(typeRoot, packageName);
  try {
    const stat = fs.statSync(packagePath);
    if (!stat.isDirectory()) return false;
    return fs.existsSync(path.join(packagePath, "package.json")) || fs.existsSync(path.join(packagePath, "index.d.ts"));
  } catch {
    return false;
  }
}

function listTypePackages(typeRoot: string): string[] {
  try {
    return fs
      .readdirSync(typeRoot, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith(".") && (entry.isDirectory() || entry.isSymbolicLink()))
      .map((entry) => entry.name)
      .filter((packageName) => hasTypePackage(typeRoot, packageName));
  } catch {
    return [];
  }
}

function uniquePaths(values: string[]): string[] {
  return [...new Set(values.map((value) => path.resolve(value)))];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
