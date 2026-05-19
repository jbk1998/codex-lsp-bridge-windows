import { JsonRpcLspClient } from "./json-rpc-lsp-client.js";
import { LspSemanticProvider } from "./lsp-semantic-provider.js";
import type { SemanticProvider } from "./types.js";
import { createLanguageServerConfig, detectLanguageFromFile, type SupportedLanguage } from "../adapters/language-config.js";

export class LspManager {
  private readonly providers = new Map<SupportedLanguage, SemanticProvider>();

  constructor(private readonly rootPath: string) {}

  forLanguage(language: SupportedLanguage): SemanticProvider {
    const existing = this.providers.get(language);
    if (existing) return existing;

    const config = createLanguageServerConfig(language, this.rootPath);
    const provider = new LspSemanticProvider({
      rootPath: this.rootPath,
      languageId: config.languageId,
      server: config.server,
      workspaceSeedFiles: config.workspaceSeedFiles,
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
