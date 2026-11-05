#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { LspManager } from "../dist/core/lsp-manager.js";
import { filePathToUri } from "../dist/utils/uri.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
if (!args.root) throw new Error("Provide --root with the workspace root to compare");
const rootPath = fs.realpathSync(path.resolve(args.root));
const nativeExecutablePath = process.env.CODEX_LSP_TYPESCRIPT_NATIVE_EXECUTABLE;
if (!nativeExecutablePath || !path.isAbsolute(nativeExecutablePath) || !fs.existsSync(nativeExecutablePath)) {
  throw new Error("Set CODEX_LSP_TYPESCRIPT_NATIVE_EXECUTABLE to an existing absolute TypeScript 7 tsc executable path");
}
if (args.files.length === 0) {
  throw new Error("Provide at least one TypeScript/JavaScript source file with --file (repeat the option for multiple files)");
}

const toolVersions = {
  classicLanguageServer: readPackageVersion(path.join(packageRoot, "node_modules", "typescript-language-server", "package.json")),
  classicCompiler: readPackageVersion(path.join(packageRoot, "node_modules", "typescript", "package.json")),
  nativeCompiler: readNativeVersion(nativeExecutablePath)
};
let correctnessFailed = false;

for (const inputFile of args.files) {
  const filePath = fs.realpathSync(path.resolve(rootPath, inputFile));
  if (!isPathInside(filePath, rootPath)) throw new Error(`File is outside --root: ${inputFile}`);
  if (!/\.(?:ts|tsx|js|jsx|mjs|cjs)$/i.test(filePath)) throw new Error(`Unsupported TypeScript/JavaScript file: ${inputFile}`);

  const classic = await measureBackend("classic", rootPath, filePath);
  const native = await measureBackend("native", rootPath, filePath, nativeExecutablePath);
  const classicSignature = diagnosticSignature(classic.cold.items, rootPath);
  const classicWarmSignature = diagnosticSignature(classic.warm.items, rootPath);
  const nativeSignature = diagnosticSignature(native.cold.items, rootPath);
  const nativeWarmSignature = diagnosticSignature(native.warm.items, rootPath);
  const coldSignaturesMatch = JSON.stringify(classicSignature) === JSON.stringify(nativeSignature);
  const warmSignaturesMatch = JSON.stringify(classicWarmSignature) === JSON.stringify(nativeWarmSignature);
  const sourceRevisionsStable =
    sameDefinedRevision(classic.cold.sourceRevision, classic.warm.sourceRevision) &&
    sameDefinedRevision(native.cold.sourceRevision, native.warm.sourceRevision);
  const equivalent =
    classic.cold.status === "ok" &&
    native.cold.status === "ok" &&
    !classic.cold.timedOut &&
    !native.cold.timedOut &&
    !classic.cold.stale &&
    !native.cold.stale &&
    coldSignaturesMatch &&
    JSON.stringify(classicSignature) === JSON.stringify(classicWarmSignature) &&
    JSON.stringify(nativeSignature) === JSON.stringify(nativeWarmSignature) &&
    warmSignaturesMatch &&
    classic.warm.status === "ok" &&
    native.warm.status === "ok" &&
    !classic.warm.timedOut &&
    !native.warm.timedOut &&
    !classic.warm.stale &&
    !native.warm.stale &&
    sourceRevisionsStable &&
    classic.disposal.clean &&
    native.disposal.clean;
  if (!equivalent) correctnessFailed = true;

  console.log(
    JSON.stringify({
      fixture: path.relative(rootPath, filePath).split(path.sep).join("/"),
      tools: toolVersions,
      classic: compactRun(classic),
      native: compactRun(native),
      coldSignaturesMatch,
      warmSignaturesMatch,
      sourceRevisionsStable,
      equivalent
    })
  );
}

if (correctnessFailed) process.exitCode = 1;

async function measureBackend(backend, root, file, executablePath) {
  const languageServer = backend === "classic" ? { backend: "classic" } : { backend: "native", executablePath };
  const manager = new LspManager(root, { languageServers: { typescript: languageServer } });
  try {
    const provider = manager.forFile(file);
    const uri = filePathToUri(file);
    const coldStart = performance.now();
    const cold = await provider.diagnostics(uri, { timeoutMs: 30000 });
    const coldMs = Math.round((performance.now() - coldStart) * 100) / 100;
    const warmStart = performance.now();
    const warm = await provider.diagnostics(uri, { timeoutMs: 30000 });
    const warmMs = Math.round((performance.now() - warmStart) * 100) / 100;
    const disposal = await manager.dispose();
    return {
      cold: { ...cold, ms: coldMs },
      warm: { ...warm, ms: warmMs },
      disposal: { clean: disposal?.clean === true, reasonCode: disposal?.reasonCode ?? "no-process-result" }
    };
  } catch (error) {
    await manager.dispose();
    throw error;
  }
}

function compactRun(run) {
  const compactReport = ({ status, timedOut, stale, sourceRevision, items, ms }) => ({
    status,
    timedOut,
    stale,
    sourceRevision,
    ms,
    count: items.length,
    signatures: items.map((item) => ({
      code: item.code,
      line: item.line,
      character: item.character,
      severity: item.severity,
      message: item.message
    }))
  });
  return {
    cold: compactReport(run.cold),
    warm: compactReport(run.warm),
    disposal: run.disposal
  };
}

function diagnosticSignature(items, root) {
  return items
    .map((item) => ({
      file: path.relative(root, item.file).split(path.sep).join("/"),
      code: item.code ?? null,
      line: item.line,
      character: item.character,
      severity: item.severity,
      message: item.message
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function sameDefinedRevision(first, second) {
  return first !== undefined && second !== undefined && first === second;
}

function readPackageVersion(packagePath) {
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  return packageJson.version ?? "unknown";
}

function readNativeVersion(executablePath) {
  const result = spawnSync(executablePath, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 10000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Could not read native TypeScript version: ${result.stderr || result.status}`);
  return (result.stdout || result.stderr).trim();
}

function parseArgs(values) {
  const parsed = { root: undefined, files: [] };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--root" && values[index + 1]) parsed.root = values[++index];
    else if (value === "--file" && values[index + 1]) parsed.files.push(values[++index]);
    else throw new Error(`Unknown or incomplete argument: ${value}`);
  }
  return parsed;
}

function isPathInside(targetPath, rootPath) {
  const relativePath = path.relative(rootPath, targetPath);
  return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath));
}
