import path from "node:path";
import fs from "node:fs";
import type { ServerProcessConfig } from "../core/json-rpc-lsp-client.js";

export type SupportedLanguage = "typescript" | "rust" | "python" | "go";

export interface LanguageServerConfig {
  language: SupportedLanguage;
  languageId: string;
  server: ServerProcessConfig;
  extensions: string[];
  workspaceSeedFiles: string[];
  installHint: string;
  supportLevel: "primary" | "experimental";
}

export interface LanguageServerOverride {
  command?: string;
  args?: string[];
}

const serverByLanguage: Record<
  SupportedLanguage,
  { languageId: string; command: string; args: string[]; extensions: string[]; workspaceSeedFiles: string[]; installHint: string; supportLevel: "primary" | "experimental" }
> = {
  typescript: {
    languageId: "typescript",
    command: "typescript-language-server",
    args: ["--stdio"],
    extensions: [".ts", ".tsx", ".js", ".jsx"],
    workspaceSeedFiles: [
      "src/index.ts",
      "src/index.tsx",
      "src/main.ts",
      "src/main.tsx",
      "src/app.ts",
      "src/app.tsx",
      "src/proxy.ts",
      "src/instrumentation.ts",
      "app/page.tsx",
      "pages/index.tsx"
    ],
    installHint: "npm install -g typescript-language-server typescript",
    supportLevel: "primary"
  },
  rust: {
    languageId: "rust",
    command: "rust-analyzer",
    args: [],
    extensions: [".rs"],
    workspaceSeedFiles: ["src/main.rs", "src/lib.rs"],
    installHint: "rustup component add rust-analyzer",
    supportLevel: "experimental"
  },
  python: {
    languageId: "python",
    command: "pyright-langserver",
    args: ["--stdio"],
    extensions: [".py"],
    workspaceSeedFiles: ["main.py", "src/main.py", "app.py", "src/app.py"],
    installHint: "npm install -g pyright",
    supportLevel: "experimental"
  },
  go: {
    languageId: "go",
    command: "gopls",
    args: [],
    extensions: [".go"],
    workspaceSeedFiles: ["main.go", "cmd/main.go"],
    installHint: "go install golang.org/x/tools/gopls@latest",
    supportLevel: "experimental"
  }
};

export function createLanguageServerConfig(
  language: SupportedLanguage,
  rootPath: string,
  override: LanguageServerOverride = {}
): LanguageServerConfig {
  const config = serverByLanguage[language];
  const command = override.command ?? config.command;
  return {
    language,
    languageId: config.languageId,
    extensions: [...config.extensions],
    workspaceSeedFiles: [...config.workspaceSeedFiles],
    installHint: config.installHint,
    supportLevel: config.supportLevel,
    server: {
      command: resolveServerCommand(rootPath, command),
      args: [...(override.args ?? config.args)],
      cwd: path.resolve(rootPath)
    }
  };
}

export function resolveServerCommand(
  rootPath: string,
  command: string,
  options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {}
): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const localCommand = path.join(rootPath, "node_modules", ".bin", command);
  if (platform === "win32") {
    for (const extension of windowsExecutableExtensions(env)) {
      const candidate = `${localCommand}${extension}`;
      if (fs.existsSync(candidate)) return candidate;
    }
    const pathCommand = findCommandOnPath(command, env);
    if (pathCommand) return pathCommand;
  }
  if (fs.existsSync(localCommand)) return localCommand;
  return command;
}

function findCommandOnPath(command: string, env: NodeJS.ProcessEnv): string | undefined {
  if (path.isAbsolute(command) || command.includes(path.sep) || command.includes(path.posix.sep)) return undefined;

  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const extension of windowsExecutableExtensions(env)) {
      const candidate = path.join(directory, `${command}${extension}`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function windowsExecutableExtensions(env: NodeJS.ProcessEnv): string[] {
  const configured = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  return [...configured.map((extension) => extension.toLowerCase()), ""];
}

export function listLanguageServerConfigs(rootPath: string): LanguageServerConfig[] {
  return supportedLanguages().map((language) => createLanguageServerConfig(language, rootPath));
}

export function supportedLanguages(): SupportedLanguage[] {
  return Object.keys(serverByLanguage) as SupportedLanguage[];
}

export function detectLanguageFromFile(filePath: string): SupportedLanguage {
  const extension = path.extname(filePath);
  const match = supportedLanguages().find((language) => serverByLanguage[language].extensions.includes(extension));
  if (match) return match;
  throw new Error(`Unsupported file extension for LSP language detection: ${filePath}`);
}
