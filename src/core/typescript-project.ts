import fs from "node:fs";
import path from "node:path";

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
  const candidates = [
    ...ancestorTypeRoots(rootPath),
    ...runtimeTypeRoots(runtimePath)
  ];
  return uniquePaths(candidates.filter(hasNodeTypePackage));
}

export function resolveInferredTypeScriptProjectOptions(
  rootPath: string,
  runtimePath = process.execPath
): InferredTypeScriptProjectOptions | undefined {
  const typeRoots = resolveTypeRoots(rootPath, runtimePath);
  if (typeRoots.length === 0) return undefined;

  const types = uniqueStrings(typeRoots.flatMap(listTypePackages));
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

function resolveTypeRoots(rootPath: string, runtimePath: string): string[] {
  return uniquePaths([
    ...ancestorTypeRoots(rootPath),
    ...runtimeTypeRoots(runtimePath)
  ].filter((candidate) => hasTypePackages(candidate)));
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
  const runtimeDirectory = path.dirname(path.resolve(runtimePath));
  return [
    path.join(runtimeDirectory, "node_modules", "@types"),
    path.join(runtimeDirectory, "..", "node_modules", "@types"),
    path.join(runtimeDirectory, "..", "..", "node_modules", "@types")
  ];
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
