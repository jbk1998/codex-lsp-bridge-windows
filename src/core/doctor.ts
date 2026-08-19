import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listLanguageServerConfigs } from "../adapters/language-config.js";
import { loadConfig } from "./config.js";
import { resolveDiagnosticsTimeout, type ResolvedDiagnosticsTimeout } from "./diagnostics-timeout.js";
import { NativeNodeRuntimeError, validateNativeNodeLaunchRecord, validateNativeNodeRuntime } from "./native-node-runtime.js";

type DoctorLanguageResult = {
  language: string;
  command: string;
  status: "ok" | "missing";
  supportLevel: "primary" | "experimental";
  installHint: string;
  path?: string;
  seedFile?: string;
};

export interface DoctorResult {
  languages: DoctorLanguageResult[];
  codex: {
    mcpConfigured: boolean;
    explicitMcpReady: boolean;
    hookConfigured: boolean;
    hookState: "absent" | "disabled" | "enabled" | "invalid";
    instructionsConfigured: boolean;
    launcher: {
      status: "ready" | "unavailable";
      code?: string;
    };
  };
  build: {
    distExists: boolean;
    stale: boolean;
  };
  diagnostics: ResolvedDiagnosticsTimeout;
  recommendations: string[];
}

export function runDoctor(rootPath: string): DoctorResult {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const config = loadConfig(rootPath);
  const diagnostics = resolveDiagnosticsTimeout(rootPath, config.diagnosticsTimeoutMs);
  const languages: DoctorLanguageResult[] = listLanguageServerConfigs(rootPath).map((config) => {
    const executablePath = findExecutable(config.server.command);
    return {
      language: config.language,
      command: config.server.command,
      status: (executablePath ? "ok" : "missing") as DoctorLanguageResult["status"],
      supportLevel: config.supportLevel,
      installHint: config.installHint,
      seedFile: findSeedFile(rootPath, config.workspaceSeedFiles, config.extensions),
      ...(executablePath ? { path: executablePath } : {})
    };
  });
  const mcpConfig = readText(path.join(codexHome, "config.toml"));
  const hookConfig = readText(path.join(codexHome, "hooks.json"));
  const hookState = inspectHookState(hookConfig);
  const launcher = inspectCurrentLauncher();
  const mcpConfigured = mcpConfig.includes("[mcp_servers.codex-lsp-bridge]");
  const explicitMcpReady = inspectExplicitMcpConfig(mcpConfig);
  const codex = {
    mcpConfigured,
    explicitMcpReady,
    hookConfigured: hookState !== "absent",
    hookState,
    instructionsConfigured: readText(path.join(codexHome, "AGENTS.md")).includes("BEGIN codex-lsp-bridge"),
    launcher
  };
  const build = inspectBuildFreshness(packageRoot);
  return {
    languages,
    codex,
    build,
    diagnostics,
    recommendations: buildRecommendations(languages, codex, build)
  };
}

function buildRecommendations(
  languages: DoctorResult["languages"],
  codex: DoctorResult["codex"],
  build: DoctorResult["build"]
): string[] {
  const recommendations: string[] = [];
  for (const language of languages) {
    if (language.status === "missing") {
      recommendations.push(`Install ${language.language} language server: ${language.installHint}`);
    }
  }
  if (!codex.explicitMcpReady || !codex.instructionsConfigured) {
    recommendations.push("Run codex-lsp-bridge install and restart Codex.");
  }
  if (codex.hookState === "enabled") {
    recommendations.push("The managed PostToolUse hook is enabled; disable it before lifecycle measurement.");
  }
  if (!build.distExists || build.stale) {
    recommendations.push("Run npm run build before using the local package.");
  }
  return recommendations;
}

function inspectCurrentLauncher(): DoctorResult["codex"]["launcher"] {
  try {
    validateNativeNodeRuntime();
    return { status: "ready" };
  } catch (error) {
    return {
      status: "unavailable",
      code: error instanceof NativeNodeRuntimeError ? error.code : "runtime_unavailable"
    };
  }
}

function inspectExplicitMcpConfig(config: string): boolean {
  const normalized = config.replace(/\r\n?/g, "\n");
  const section = normalized.match(/(?:^|\n)\[mcp_servers\.codex-lsp-bridge\]\n([\s\S]*?)(?=\n\[|$)/)?.[1] ?? "";
  const command = section.match(/^command\s*=\s*("(?:\\.|[^"\\])*")\s*$/m)?.[1];
  const args = section.match(/^args\s*=\s*\[([\s\S]*?)\]\s*$/m)?.[1];
  if (!command || args === undefined) return false;
  try {
    const value = JSON.parse(command);
    if (typeof value !== "string") return false;
    const parsedArgs = parseTomlStringArray(args);
    validateNativeNodeLaunchRecord({ version: 1, runtime: "native-node", command: value, args: parsedArgs });
    return true;
  } catch {
    return false;
  }
}

function parseTomlStringArray(content: string): string[] {
  const values: string[] = [];
  let remaining = content.trim();
  while (remaining.length > 0) {
    const match = remaining.match(/^("(?:\\.|[^"\\])*")\s*(,|$)/);
    if (!match) throw new Error("invalid TOML string array");
    const value = JSON.parse(match[1]);
    if (typeof value !== "string") throw new Error("invalid TOML string array value");
    values.push(value);
    remaining = remaining.slice(match[0].length).trim();
  }
  return values;
}

function inspectHookState(content: string): DoctorResult["codex"]["hookState"] {
  if (!content.trim()) return "absent";
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content.includes("codex-lsp-bridge:post-tool-diagnostics") ? "invalid" : "absent";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "invalid";
  const hooks = (parsed as { hooks?: { PostToolUse?: unknown } }).hooks?.PostToolUse;
  if (!Array.isArray(hooks)) return "absent";
  for (const entry of hooks) {
    if (!entry || typeof entry !== "object") continue;
    const nested = (entry as { hooks?: unknown }).hooks;
    if (!Array.isArray(nested)) continue;
    for (const hook of nested) {
      if (!hook || typeof hook !== "object") continue;
      if ((hook as { id?: unknown }).id !== "codex-lsp-bridge:post-tool-diagnostics") continue;
      if ((hook as { enabled?: unknown }).enabled === false || (entry as { enabled?: unknown }).enabled === false) {
        return "disabled";
      }
      return "enabled";
    }
  }
  return "absent";
}

function findExecutable(command: string): string | undefined {
  if (command.includes(path.sep)) {
    return isExecutable(command) ? command : undefined;
  }

  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];

  for (const directory of pathEntries) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      if (isExecutable(candidate)) return candidate;
    }
  }

  return undefined;
}

function findSeedFile(rootPath: string, seedFiles: string[], extensions: string[]): string | undefined {
  for (const seed of seedFiles) {
    const filePath = path.join(rootPath, seed);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) return filePath;
  }
  return findFirstSourceFile(rootPath, extensions);
}

function findFirstSourceFile(rootPath: string, extensions: string[]): string | undefined {
  const skipped = new Set([".git", ".next", ".turbo", "build", "coverage", "dist", "node_modules"]);
  const queue = [rootPath];
  while (queue.length > 0) {
    const directory = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isFile() && extensions.includes(path.extname(entry.name))) return entryPath;
      if (entry.isDirectory() && !skipped.has(entry.name)) queue.push(entryPath);
    }
  }
  return undefined;
}

export function inspectBuildFreshness(packageRoot: string): { distExists: boolean; stale: boolean } {
  const distIndex = path.join(packageRoot, "dist", "index.js");
  if (!fs.existsSync(distIndex)) return { distExists: false, stale: true };
  const sourceRoot = path.join(packageRoot, "src");
  if (!fs.existsSync(sourceRoot)) return { distExists: true, stale: false };
  return {
    distExists: true,
    stale: newestMtime(sourceRoot) > fs.statSync(distIndex).mtimeMs
  };
}

function newestMtime(directory: string): number {
  let newest = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(entryPath));
    else newest = Math.max(newest, fs.statSync(entryPath).mtimeMs);
  }
  return newest;
}

function readText(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
