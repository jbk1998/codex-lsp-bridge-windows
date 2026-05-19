import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listLanguageServerConfigs } from "../adapters/language-config.js";

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
    hookConfigured: boolean;
    instructionsConfigured: boolean;
  };
  build: {
    distExists: boolean;
    stale: boolean;
  };
  recommendations: string[];
}

export function runDoctor(rootPath: string): DoctorResult {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
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
  const codex = {
    mcpConfigured: readText(path.join(codexHome, "config.toml")).includes("[mcp_servers.codex-lsp-bridge]"),
    hookConfigured: readText(path.join(codexHome, "hooks.json")).includes("codex-lsp-bridge:post-tool-diagnostics"),
    instructionsConfigured: readText(path.join(codexHome, "AGENTS.md")).includes("BEGIN codex-lsp-bridge")
  };
  const build = inspectBuildFreshness(packageRoot);
  return {
    languages,
    codex,
    build,
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
  if (!codex.mcpConfigured || !codex.hookConfigured || !codex.instructionsConfigured) {
    recommendations.push("Run codex-lsp-bridge install and restart Codex.");
  }
  if (!build.distExists || build.stale) {
    recommendations.push("Run npm run build before using the local package.");
  }
  return recommendations;
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
