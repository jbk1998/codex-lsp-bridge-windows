import path from "node:path";
import type { ServerProcessConfig } from "../core/json-rpc-lsp-client.js";

export type SupportedLanguage = "typescript" | "rust" | "python";

export interface LanguageServerConfig {
  language: SupportedLanguage;
  languageId: string;
  server: ServerProcessConfig;
  workspaceSeedFiles: string[];
}

const serverByLanguage: Record<
  SupportedLanguage,
  { languageId: string; command: string; args: string[]; workspaceSeedFiles: string[] }
> = {
  typescript: {
    languageId: "typescript",
    command: "typescript-language-server",
    args: ["--stdio"],
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
    workspaceSeedFiles: ["src/main.rs", "src/lib.rs"]
  },
  python: {
    languageId: "python",
    command: "pyright-langserver",
    args: ["--stdio"],
    workspaceSeedFiles: ["main.py", "src/main.py", "app.py", "src/app.py"]
  }
};

export function createLanguageServerConfig(language: SupportedLanguage, rootPath: string): LanguageServerConfig {
  const config = serverByLanguage[language];
  return {
    language,
    languageId: config.languageId,
    workspaceSeedFiles: [...config.workspaceSeedFiles],
    server: {
      command: config.command,
      args: [...config.args],
      cwd: path.resolve(rootPath)
    }
  };
}

export function detectLanguageFromFile(filePath: string): SupportedLanguage {
  if (/\.(ts|tsx|js|jsx)$/.test(filePath)) return "typescript";
  if (/\.rs$/.test(filePath)) return "rust";
  if (/\.py$/.test(filePath)) return "python";
  throw new Error(`Unsupported file extension for LSP language detection: ${filePath}`);
}
