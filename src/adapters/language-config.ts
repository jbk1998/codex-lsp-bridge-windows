import path from "node:path";
import fs from "node:fs";
import type { ServerProcessConfig } from "../core/json-rpc-lsp-client.js";

export type SupportedLanguage = "typescript" | "rust" | "python" | "go";

export interface LanguageServerConfig {
  language: SupportedLanguage;
  backend?: TypeScriptBackend;
  languageId: string;
  server: ServerProcessConfig;
  extensions: string[];
  workspaceSeedFiles: string[];
  installHint: string;
  supportLevel: "primary" | "experimental";
}

export type TypeScriptBackend = "classic" | "native";

export interface LanguageServerOverride {
  backend?: TypeScriptBackend;
  executablePath?: string;
  command?: string;
  args?: string[];
}

const serverByLanguage: Record<
  SupportedLanguage,
  {
    languageId: string;
    command: string;
    args: string[];
    extensions: string[];
    workspaceSeedFiles: string[];
    installHint: string;
    supportLevel: "primary" | "experimental";
  }
> = {
  typescript: {
    languageId: "typescript",
    command: "typescript-language-server",
    args: ["--stdio"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
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
    installHint: "npm install -g typescript-language-server typescript@5.9.3",
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
  const backend = language === "typescript" ? (override.backend ?? "classic") : undefined;
  if (override.executablePath !== undefined && (language !== "typescript" || backend !== "native")) {
    throw new Error('"executablePath" is supported only with the native TypeScript backend');
  }
  if (backend === "native" && (!override.executablePath || !path.isAbsolute(override.executablePath))) {
    throw new Error('TypeScript native backend requires an absolute trusted "executablePath" in global languageServers.typescript config');
  }
  if (backend === "native" && override.command !== undefined) {
    throw new Error('TypeScript native backend uses "executablePath"; remove the ambiguous "command" override');
  }
  const command = override.executablePath ?? override.command ?? config.command;
  const resolvedCommand = resolveServerCommand(rootPath, command);
  if (backend === "native" && isWindowsShellShim(resolvedCommand)) {
    throw new Error("TypeScript native backend requires a direct executable, not a Windows shell shim");
  }

  return {
    language,
    ...(backend ? { backend } : {}),
    languageId: config.languageId,
    extensions: [...config.extensions],
    workspaceSeedFiles: [...config.workspaceSeedFiles],
    installHint:
      backend === "native"
        ? "Install TypeScript 7's platform package and set languageServers.typescript.executablePath to its direct lib/tsc binary"
        : config.installHint,
    supportLevel: config.supportLevel,
    server: {
      command: resolvedCommand,
      args: [...(override.args ?? (backend === "native" ? ["--lsp", "--stdio"] : config.args))],
      cwd: path.resolve(rootPath)
    }
  };
}

function isWindowsShellShim(command: string): boolean {
  const extension = path.extname(command).toLowerCase();
  return extension === ".cmd" || extension === ".bat";
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

export function listLanguageServerConfigs(
  rootPath: string,
  overrides: Partial<Record<SupportedLanguage, LanguageServerOverride>> = {}
): LanguageServerConfig[] {
  return supportedLanguages().map((language) => createLanguageServerConfig(language, rootPath, overrides[language]));
}

export function supportedLanguages(): SupportedLanguage[] {
  return Object.keys(serverByLanguage) as SupportedLanguage[];
}

export function supportedExtensionsForLanguage(language: SupportedLanguage): string[] {
  return [...serverByLanguage[language].extensions];
}

export function detectLanguageFromFile(filePath: string): SupportedLanguage {
  const extension = path.extname(filePath);
  const match = supportedLanguages().find((language) => serverByLanguage[language].extensions.includes(extension));
  if (match) return match;
  throw new Error(`Unsupported file extension for LSP language detection: ${filePath}`);
}
