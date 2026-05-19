#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CommandService } from "./core/command-service.js";
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

  const root = readOption(args, "--root") ?? process.cwd();
  const manager = new LspManager(root);

  try {
    if (args[0] === "mcp") {
      const service = new CommandService(manager.forLanguage(readLanguage(args)));
      await runStdioMcp(service);
      return;
    }

    const language = readLanguage(args);
    const service = new CommandService(manager.forLanguage(language));
    const command = args[0];
    const value = args.find((arg) => !arg.startsWith("--") && arg !== command);

    if (command === "diagnostics") {
      const file = readOption(args, "--file");
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

function readLanguage(args: string[]): SupportedLanguage {
  const value = readOption(args, "--language");
  if (!value) return "typescript";
  if (value === "typescript" || value === "rust" || value === "python") return value;
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
  codex-lsp-bridge diagnostics [--file path] [--language typescript|rust|python] [--root path]
  codex-lsp-bridge definition <symbol> [--language typescript|rust|python] [--root path]
  codex-lsp-bridge definition --file path --line n --character n [--language typescript|rust|python] [--root path]
  codex-lsp-bridge references <symbol> [--language typescript|rust|python] [--root path]
  codex-lsp-bridge references --file path --line n --character n [--language typescript|rust|python] [--root path]
  codex-lsp-bridge symbols <query> [--language typescript|rust|python] [--root path]
  codex-lsp-bridge hover <symbol> [--language typescript|rust|python] [--root path]
  codex-lsp-bridge hover --file path --line n --character n [--language typescript|rust|python] [--root path]
  codex-lsp-bridge mcp [--root path] [--language typescript|rust|python]`);
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
