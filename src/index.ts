#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WorkspaceCommandService } from "./core/command-service.js";
import { loadConfig } from "./core/config.js";
import { runDoctor } from "./core/doctor.js";
import { LspManager } from "./core/lsp-manager.js";
import { filePathToUri } from "./utils/uri.js";
import { runStdioMcp } from "./transport/mcp.js";
import type { SupportedLanguage } from "./adapters/language-config.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
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
  const manager = new LspManager(root, {
    diagnosticsTimeoutMs: config.diagnosticsTimeoutMs,
    languageServers: config.languageServers
  });

  try {
    if (args[0] === "doctor") {
      console.log(JSON.stringify(runDoctor(root), null, 2));
      return;
    }

    const language = readLanguage(args, config.defaultLanguage);
    const service = new WorkspaceCommandService(manager, language);

    if (args[0] === "mcp") {
      await runStdioMcp(service, {
        status: () => runDoctor(root),
        directoryDiagnostics: async (dir, severity) =>
          filterDiagnosticSummary(
            mergeDiagnosticSummaries(
              await Promise.all(
                (await collectSourceFiles(resolveDirectoryInsideRoot(root, dir))).map((diagnosticFile) =>
                  service.diagnostics(filePathToUri(diagnosticFile))
                )
              )
            ),
            severity
          )
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
        const summaries = [];
        for (const diagnosticFile of await collectSourceFiles(resolveDirectoryInsideRoot(root, dir))) {
          summaries.push(await service.diagnostics(filePathToUri(diagnosticFile)));
        }
        console.log(JSON.stringify(filterDiagnosticSummary(mergeDiagnosticSummaries(summaries), severity), null, 2));
        return;
      }
      console.log(JSON.stringify(await service.diagnostics(file ? filePathToUri(file) : undefined), null, 2));
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

    printUsage();
    process.exitCode = 1;
  } finally {
    await manager.dispose();
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

function printUsage(): void {
  console.error(`Usage:
  codex-lsp-bridge install [--dry-run]
  codex-lsp-bridge install [--auto-update] [--package package-spec] [--dry-run]
  codex-lsp-bridge uninstall [--dry-run]
  codex-lsp-bridge post-tool-diagnostics
  codex-lsp-bridge doctor [--root path]
  codex-lsp-bridge diagnostics [--file path] [--language typescript|rust|python|go] [--root path]
  codex-lsp-bridge diagnostics --dir path [--severity error|warning|information|hint] [--root path]
  codex-lsp-bridge definition <symbol> [--language typescript|rust|python|go] [--root path]
  codex-lsp-bridge definition --file path --line n --character n [--language typescript|rust|python|go] [--root path]
  codex-lsp-bridge references <symbol> [--language typescript|rust|python|go] [--root path]
  codex-lsp-bridge references --file path --line n --character n [--language typescript|rust|python|go] [--root path]
  codex-lsp-bridge symbols <query> [--language typescript|rust|python|go] [--root path]
  codex-lsp-bridge hover <symbol> [--language typescript|rust|python|go] [--root path]
  codex-lsp-bridge hover --file path --line n --character n [--language typescript|rust|python|go] [--root path]
  codex-lsp-bridge mcp [--root path] [--language typescript|rust|python|go]`);
}

async function collectSourceFiles(directory: string): Promise<string[]> {
  const skipped = new Set([".git", ".next", ".turbo", "build", "coverage", "dist", "node_modules"]);
  const files: string[] = [];
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory() && !skipped.has(entry.name)) files.push(...(await collectSourceFiles(entryPath)));
    if (entry.isFile() && /\.(ts|tsx|js|jsx|rs|py|go)$/.test(entry.name)) files.push(entryPath);
  }
  return files;
}

function mergeDiagnosticSummaries(summaries: Array<Awaited<ReturnType<WorkspaceCommandService["diagnostics"]>>>) {
  const items = summaries.flatMap((summary) => summary.items);
  const status = summaries.some((summary) => summary.status === "timed_out") ? "timed_out" : "ok";
  const bySeverity = {
    error: items.filter((item) => item.severity === "error").length,
    warning: items.filter((item) => item.severity === "warning").length,
    information: items.filter((item) => item.severity === "information").length,
    hint: items.filter((item) => item.severity === "hint").length
  };
  return {
    status,
    timedOut: summaries.some((summary) => summary.timedOut),
    stale: summaries.some((summary) => summary.stale),
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
  if (directory !== root && !directory.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Directory is outside workspace root: ${directory}`);
  }
  return directory;
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
