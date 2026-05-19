import { JsonRpcLspClient } from "./json-rpc-lsp-client.js";
import { LspSemanticProvider } from "./lsp-semantic-provider.js";
import type { SemanticProvider } from "./types.js";
import {
  createLanguageServerConfig,
  detectLanguageFromFile,
  type LanguageServerOverride,
  type SupportedLanguage
} from "../adapters/language-config.js";

export interface LspManagerOptions {
  diagnosticsTimeoutMs?: number;
  languageServers?: Partial<Record<SupportedLanguage, LanguageServerOverride>>;
}

export class LspManager {
  private readonly providers = new Map<SupportedLanguage, SemanticProvider>();

  constructor(
    private readonly rootPath: string,
    private readonly options: LspManagerOptions = {}
  ) {}

  forLanguage(language: SupportedLanguage): SemanticProvider {
    const existing = this.providers.get(language);
    if (existing) return existing;

    const config = createLanguageServerConfig(language, this.rootPath, this.options.languageServers?.[language]);
    const provider = new LspSemanticProvider({
      rootPath: this.rootPath,
      languageId: config.languageId,
      server: config.server,
      workspaceSeedFiles: config.workspaceSeedFiles,
      workspaceSeedExtensions: config.extensions,
      diagnosticsTimeoutMs: this.options.diagnosticsTimeoutMs,
      clientFactory: (server) => new JsonRpcLspClient(server)
    });
    this.providers.set(language, provider);
    return provider;
  }

  forFile(filePath: string): SemanticProvider {
    return this.forLanguage(detectLanguageFromFile(filePath));
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.providers.values()].map((provider) => provider.dispose()));
    this.providers.clear();
  }
}
