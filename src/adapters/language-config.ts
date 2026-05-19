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
}

export interface LanguageServerOverride {
  command?: string;
  args?: string[];
}

const serverByLanguage: Record<
  SupportedLanguage,
  { languageId: string; command: string; args: string[]; extensions: string[]; workspaceSeedFiles: string[] }
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
    ]
  },
  rust: {
    languageId: "rust",
    command: "rust-analyzer",
    args: [],
    extensions: [".rs"],
    workspaceSeedFiles: ["src/main.rs", "src/lib.rs"]
  },
  python: {
    languageId: "python",
    command: "pyright-langserver",
    args: ["--stdio"],
    extensions: [".py"],
    workspaceSeedFiles: ["main.py", "src/main.py", "app.py", "src/app.py"]
  },
  go: {
    languageId: "go",
    command: "gopls",
    args: [],
    extensions: [".go"],
    workspaceSeedFiles: ["main.go", "cmd/main.go"]
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
    server: {
      command: resolveServerCommand(rootPath, command),
      args: [...(override.args ?? config.args)],
      cwd: path.resolve(rootPath)
    }
  };
}

function resolveServerCommand(rootPath: string, command: string): string {
  const localCommand = path.join(rootPath, "node_modules", ".bin", command);
  if (fs.existsSync(localCommand)) return localCommand;
  if (process.platform === "win32" && fs.existsSync(`${localCommand}.cmd`)) return `${localCommand}.cmd`;
  return command;
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
