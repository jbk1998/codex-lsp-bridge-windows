#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WorkspaceCommandService } from "./core/command-service.js";
import { loadConfig } from "./core/config.js";
import { resolveDiagnosticsTimeout } from "./core/diagnostics-timeout.js";
import { runDoctor } from "./core/doctor.js";
import { LspManager } from "./core/lsp-manager.js";
import { filePathToUri } from "./utils/uri.js";
import { runStdioMcp } from "./transport/mcp.js";
import type { SupportedLanguage } from "./adapters/language-config.js";

const defaultDirectoryDiagnosticsOptions = {
  maxFiles: 50,
  timeoutBudgetMs: 15000,
  concurrency: 2
};
const sourceFileListCacheTtlMs = 5000;

interface SourceFileListCacheEntry {
  createdAt: number;
  files: string[];
  truncated: boolean;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    printUsage("stdout");
    return;
  }
  if (args[0] === "install") {
    runPackageScript("install-codex.mjs", args.slice(1));
    return;
  }
  if (args[0] === "uninstall") {
    runPackageScript("uninstall-codex.mjs", args.slice(1));
    return;
  }
  if (args[0] === "post-tool-diagnostics") {
    runPackageScript("codex-lsp-post-tool-use.mjs", args.slice(1));
    return;
  }

  const root = path.resolve(readOption(args, "--root") ?? process.cwd());
  const config = loadConfig(root);
  const managers = new Map<string, LspManager>();
  const sourceFileListCache = new Map<string, SourceFileListCacheEntry>();
  const serviceForRoot = (serviceRoot: string, languageOverride?: SupportedLanguage) => {
    const resolvedRoot = path.resolve(serviceRoot);
    const rootConfig = loadConfig(resolvedRoot);
    let scopedManager = managers.get(resolvedRoot);
    if (!scopedManager) {
      const diagnosticsTimeout = resolveDiagnosticsTimeout(resolvedRoot, rootConfig.diagnosticsTimeoutMs);
      scopedManager = new LspManager(resolvedRoot, {
        diagnosticsTimeoutMs: diagnosticsTimeout.timeoutMs,
        languageServers: rootConfig.languageServers
      });
      managers.set(resolvedRoot, scopedManager);
    }
    return new WorkspaceCommandService(scopedManager, languageOverride ?? rootConfig.defaultLanguage);
  };

  try {
    if (args[0] === "doctor") {
      console.log(JSON.stringify(runDoctor(root), null, 2));
      return;
    }

    const language = readLanguage(args, config.defaultLanguage);
    const service = serviceForRoot(root, language);

    if (args[0] === "mcp") {
      await runStdioMcp(service, {
        status: () => runDoctor(root),
        serviceForParams: (params) => serviceForRoot(resolveRequestedRootSync(root, params), language),
        directoryDiagnostics: async ({ dir, severity, root: requestedRoot, maxFiles, timeoutBudgetMs, concurrency }) => {
          const effectiveRoot = requestedRoot ? resolveExplicitWorkspaceRootSync(requestedRoot) : root;
          return collectDirectoryDiagnostics(effectiveRoot, dir, language, severity, serviceForRoot, {
            maxFiles: readPositiveIntegerValue(maxFiles, defaultDirectoryDiagnosticsOptions.maxFiles),
            timeoutBudgetMs: readPositiveIntegerValue(timeoutBudgetMs, defaultDirectoryDiagnosticsOptions.timeoutBudgetMs),
            concurrency: readPositiveIntegerValue(concurrency, defaultDirectoryDiagnosticsOptions.concurrency)
          }, sourceFileListCache);
        }
      });
      return;
    }

    const command = args[0];
    const value = args.find((arg) => !arg.startsWith("--") && arg !== command);

    if (command === "diagnostics") {
      const file = readOption(args, "--file");
      const dir = readOption(args, "--dir");
      const severity = readOption(args, "--severity");
      if (dir) {
        if (readOption(args, "--timeout-ms") !== undefined) {
          throw new Error("--timeout-ms is only valid for file diagnostics; use --timeout-budget-ms for directory diagnostics");
        }
        console.log(JSON.stringify(await collectDirectoryDiagnostics(root, dir, language, severity, serviceForRoot, readDirectoryDiagnosticsOptions(args), sourceFileListCache), null, 2));
        return;
      }
      if (readOption(args, "--timeout-budget-ms") !== undefined) {
        throw new Error("--timeout-budget-ms is only valid for directory diagnostics; use --timeout-ms for file diagnostics");
      }
      console.log(JSON.stringify(await service.diagnostics(file ? filePathToUri(file) : undefined, {
        timeoutMs: readOptionalPositiveIntegerOption(args, "--timeout-ms")
      }), null, 2));
      return;
    }
    if (command === "definition") {
      const position = readPosition(args);
      if (position) {
        console.log(JSON.stringify(await service.definitionAt(position), null, 2));
        return;
      }
      console.log(JSON.stringify(await service.definition(requireValue(command, value)), null, 2));
      return;
    }
    if (command === "references") {
      const position = readPosition(args);
      if (position) {
        console.log(JSON.stringify(await service.referencesAt(position), null, 2));
        return;
      }
      console.log(JSON.stringify(await service.references(requireValue(command, value)), null, 2));
      return;
    }
    if (command === "symbols") {
      console.log(JSON.stringify(await service.symbols(requireValue(command, value)), null, 2));
      return;
    }
    if (command === "hover") {
      const position = readPosition(args);
      if (position) {
        console.log(JSON.stringify(await service.hoverAt(position), null, 2));
        return;
      }
      console.log(JSON.stringify(await service.hover(requireValue(command, value)), null, 2));
      return;
    }

    printUsage("stderr");
    process.exitCode = 1;
  } finally {
    await Promise.all([...managers.values()].map((manager) => manager.dispose()));
  }
}

function readLanguage(args: string[], fallback: SupportedLanguage): SupportedLanguage {
  const value = readOption(args, "--language");
  if (!value) return fallback;
  if (value === "typescript" || value === "rust" || value === "python" || value === "go") return value;
  throw new Error(`Unsupported language: ${value}`);
}

function readOption(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  if (index === -1) return undefined;
  return args[index + 1];
}

function readPosition(args: string[]): { file: string; line: number; character: number } | undefined {
  const file = readOption(args, "--file");
  const line = readNumberOption(args, "--line");
  const character = readNumberOption(args, "--character");
  if (!file && line === undefined && character === undefined) return undefined;
  if (!file || line === undefined || character === undefined) {
    throw new Error("--file, --line, and --character must be provided together");
  }
  return { file, line, character };
}

function readNumberOption(args: string[], option: string): number | undefined {
  const value = readOption(args, option);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${option} must be an integer`);
  return parsed;
}

function requireValue(command: string, value: string | undefined): string {
  if (!value) throw new Error(`${command} requires a symbol or query`);
  return value;
}

function printUsage(stream: "stdout" | "stderr"): void {
  const usage = `Usage:
  codex-lsp-bridge install [--dry-run]
  codex-lsp-bridge install [--auto-update] [--package package-spec] [--with-rust-analyzer] [--dry-run]
  codex-lsp-bridge uninstall [--dry-run]
  codex-lsp-bridge post-tool-diagnostics
  codex-lsp-bridge doctor [--root path]
  codex-lsp-bridge diagnostics [--file path] [--timeout-ms n] [--language typescript|rust|python|go] [--root path]
  codex-lsp-bridge diagnostics --dir path [--severity error|warning|information|hint] [--max-files n] [--timeout-budget-ms n] [--concurrency n] [--root path]
  codex-lsp-bridge definition <symbol> [--language typescript|rust|python|go] [--root path]
  codex-lsp-bridge definition --file path --line n --character n [--language typescript|rust|python|go] [--root path]
  codex-lsp-bridge references <symbol> [--language typescript|rust|python|go] [--root path]
  codex-lsp-bridge references --file path --line n --character n [--language typescript|rust|python|go] [--root path]
  codex-lsp-bridge symbols <query> [--language typescript|rust|python|go] [--root path]
  codex-lsp-bridge hover <symbol> [--language typescript|rust|python|go] [--root path]
  codex-lsp-bridge hover --file path --line n --character n [--language typescript|rust|python|go] [--root path]
  codex-lsp-bridge mcp [--root path] [--language typescript|rust|python|go]`;
  if (stream === "stdout") {
    console.log(usage);
    return;
  }
  console.error(usage);
}

function readDirectoryDiagnosticsOptions(args: string[]): DirectoryDiagnosticsOptions {
  return {
    maxFiles: readPositiveIntegerOption(args, "--max-files", defaultDirectoryDiagnosticsOptions.maxFiles),
    timeoutBudgetMs: readPositiveIntegerOption(args, "--timeout-budget-ms", defaultDirectoryDiagnosticsOptions.timeoutBudgetMs),
    concurrency: readPositiveIntegerOption(args, "--concurrency", defaultDirectoryDiagnosticsOptions.concurrency)
  };
}

function readPositiveIntegerOption(args: string[], option: string, fallback: number): number {
  return readPositiveIntegerValue(readNumberOption(args, option), fallback);
}

function readOptionalPositiveIntegerOption(args: string[], option: string): number | undefined {
  const value = readNumberOption(args, option);
  if (value === undefined) return undefined;
  if (value <= 0) throw new Error(`${option} must be a positive integer`);
  return value;
}

function readPositiveIntegerValue(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value !== undefined && value > 0 ? value : fallback;
}

interface DirectoryDiagnosticsOptions {
  maxFiles: number;
  timeoutBudgetMs: number;
  concurrency: number;
}

async function collectSourceFiles(directory: string, maxFiles: number): Promise<{ files: string[]; truncated: boolean }> {
  const skipped = new Set([".git", ".next", ".turbo", "build", "coverage", "dist", "node_modules"]);
  const files: string[] = [];
  let truncated = false;

  async function visit(currentDirectory: string): Promise<void> {
    if (truncated) return;
    const entries = await fs.readdir(currentDirectory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (truncated) return;
      const entryPath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory() && !skipped.has(entry.name)) {
        await visit(entryPath);
        continue;
      }
      if (entry.isFile() && /\.(ts|tsx|js|jsx|rs|py|go)$/.test(entry.name)) {
        if (files.length >= maxFiles) {
          truncated = true;
          return;
        }
        files.push(entryPath);
      }
    }
  }

  await visit(directory);
  return { files, truncated };
}

async function collectDirectoryDiagnostics(
  root: string,
  dir: string,
  language: SupportedLanguage,
  severity: string | undefined,
  serviceForRoot: (serviceRoot: string, languageOverride?: SupportedLanguage) => WorkspaceCommandService,
  options: DirectoryDiagnosticsOptions,
  sourceFileListCache: Map<string, SourceFileListCacheEntry>
) {
  const scopedService = serviceForRoot(root, language);
  const startedAt = Date.now();
  const sourceFiles = await readCachedSourceFiles(resolveDirectoryInsideRoot(root, dir), options.maxFiles, sourceFileListCache);
  const summaries = [];
  let budgetTimedOut = false;

  for (let index = 0; index < sourceFiles.files.length; index += options.concurrency) {
    if (Date.now() - startedAt >= options.timeoutBudgetMs) {
      budgetTimedOut = true;
      break;
    }
    const batch = sourceFiles.files.slice(index, index + options.concurrency);
    summaries.push(...(await Promise.all(batch.map((diagnosticFile) => scopedService.diagnostics(filePathToUri(diagnosticFile))))));
  }
  const summary = filterDiagnosticSummary(mergeDiagnosticSummaries(summaries), severity);
  return {
    ...summary,
    status: budgetTimedOut ? "timed_out" : summary.status,
    timedOut: budgetTimedOut || summary.timedOut,
    directory: {
      scannedFiles: summaries.length,
      matchedFiles: sourceFiles.files.length,
      maxFiles: options.maxFiles,
      truncated: sourceFiles.truncated,
      sourceFileListCache: sourceFiles.cached ? "hit" : "miss",
      timeoutBudgetMs: options.timeoutBudgetMs,
      budgetTimedOut,
      concurrency: options.concurrency
    }
  };
}

async function readCachedSourceFiles(
  directory: string,
  maxFiles: number,
  cache: Map<string, SourceFileListCacheEntry>
): Promise<{ files: string[]; truncated: boolean; cached: boolean }> {
  const cacheKey = `${directory}\0${maxFiles}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt <= sourceFileListCacheTtlMs) {
    return { files: cached.files, truncated: cached.truncated, cached: true };
  }

  const collected = await collectSourceFiles(directory, maxFiles);
  cache.set(cacheKey, {
    createdAt: Date.now(),
    files: collected.files,
    truncated: collected.truncated
  });
  return { ...collected, cached: false };
}

function mergeDiagnosticSummaries(summaries: Array<Awaited<ReturnType<WorkspaceCommandService["diagnostics"]>>>) {
  const items = summaries.flatMap((summary) => summary.items);
  const status = summaries.some((summary) => summary.status === "timed_out") ? "timed_out" : "ok";
  const unavailableReason = summaries.find((summary) => summary.status === "unavailable")?.unavailableReason;
  const bySeverity = {
    error: items.filter((item) => item.severity === "error").length,
    warning: items.filter((item) => item.severity === "warning").length,
    information: items.filter((item) => item.severity === "information").length,
    hint: items.filter((item) => item.severity === "hint").length
  };
  return {
    status: status === "timed_out" ? "timed_out" : unavailableReason ? "unavailable" : "ok",
    timedOut: summaries.some((summary) => summary.timedOut),
    stale: summaries.some((summary) => summary.stale),
    ...(unavailableReason ? { unavailableReason } : {}),
    total: items.length,
    bySeverity,
    items,
    summary: items.slice(0, 10).map((item, index) => `${index + 1}. ${item.severity.toUpperCase()} ${item.file}:${item.line}:${item.character} ${item.message}`)
  };
}

function filterDiagnosticSummary<T extends { items: Array<{ severity: string }>; total: number; bySeverity: Record<string, number>; summary: string[] }>(
  summary: T,
  severity: string | undefined
): T {
  if (!severity) return summary;
  const items = summary.items.filter((item) => item.severity === severity);
  return {
    ...summary,
    total: items.length,
    bySeverity: {
      error: items.filter((item) => item.severity === "error").length,
      warning: items.filter((item) => item.severity === "warning").length,
      information: items.filter((item) => item.severity === "information").length,
      hint: items.filter((item) => item.severity === "hint").length
    },
    items,
    summary: items.slice(0, 10).map((item, index) => `${index + 1}. ${item.severity.toUpperCase()}`)
  };
}

function resolveDirectoryInsideRoot(root: string, dir: string): string {
  const directory = path.resolve(root, dir);
  const relative = path.relative(root, directory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Directory is outside workspace root: ${directory}`);
  }
  return directory;
}

function resolveRequestedRootSync(fallbackRoot: string, params: Record<string, unknown>): string {
  if (typeof params.root === "string") return resolveExplicitWorkspaceRootSync(params.root);
  return fallbackRoot;
}

function resolveExplicitWorkspaceRootSync(root: string): string {
  const resolvedRoot = path.resolve(root);
  if (!isWorkspaceRootSync(resolvedRoot)) {
    throw new Error(`Workspace root is not recognized: ${resolvedRoot}`);
  }
  return resolvedRoot;
}

function isWorkspaceRootSync(directory: string): boolean {
  return (
    existsSync(path.join(directory, ".git")) ||
    existsSync(path.join(directory, "package.json")) ||
    existsSync(path.join(directory, "tsconfig.json")) ||
    existsSync(path.join(directory, "Cargo.toml"))
  );
}

function runPackageScript(scriptName: string, args: string[]): void {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const scriptPath = path.join(packageRoot, "scripts", scriptName);
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    stdio: "inherit"
  });
  process.exitCode = result.status ?? 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
