import { JsonRpcLspClient } from "./json-rpc-lsp-client.js";
import { LspSemanticProvider } from "./lsp-semantic-provider.js";
import {
  aggregateTerminationResults,
  createDisposalDeadline,
  type DisposalDeadline,
  type ProcessTerminationResult
} from "./process-ownership.js";
import type { SemanticProvider } from "./types.js";
import {
  createLanguageServerConfig,
  detectLanguageFromFile,
  type LanguageServerOverride,
  type SupportedLanguage
} from "../adapters/language-config.js";
import { resolveInferredTypeScriptProjectOptions } from "./typescript-project.js";
import { canonicalizeWorkspaceRootSync } from "./workspace-root.js";

export interface LspManagerOptions {
  diagnosticsTimeoutMs?: number;
  languageServers?: Partial<Record<SupportedLanguage, LanguageServerOverride>>;
}

export class LspManager {
  private readonly providers = new Map<SupportedLanguage, SemanticProvider>();
  private disposePromise: Promise<ProcessTerminationResult | void> | undefined;
  private disposed = false;

  constructor(
    rootPath: string,
    private readonly options: LspManagerOptions = {}
  ) {
    this.rootPath = canonicalizeWorkspaceRootSync(rootPath);
  }

  private readonly rootPath: string;

  forLanguage(language: SupportedLanguage): SemanticProvider {
    if (this.disposed) throw new Error("LSP manager is disposed");
    const existing = this.providers.get(language);
    if (existing) return existing;

    const config = createLanguageServerConfig(language, this.rootPath, this.options.languageServers?.[language]);
    const inferredProjectOptions =
      language === "typescript" ? resolveInferredTypeScriptProjectOptions(this.rootPath)?.compilerOptions : undefined;
    const provider = new LspSemanticProvider({
      rootPath: this.rootPath,
      languageId: config.languageId,
      server: config.server,
      workspaceSeedFiles: config.workspaceSeedFiles,
      workspaceSeedExtensions: config.extensions,
      diagnosticsTimeoutMs: this.options.diagnosticsTimeoutMs,
      inferredProjectCompilerOptions: inferredProjectOptions,
      clientFactory: (server) => new JsonRpcLspClient(server)
    });
    this.providers.set(language, provider);
    return provider;
  }

  forFile(filePath: string): SemanticProvider {
    return this.forLanguage(detectLanguageFromFile(filePath));
  }

  async dispose(deadline?: DisposalDeadline): Promise<ProcessTerminationResult | void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    const sharedDeadline = deadline ?? createDisposalDeadline();
    this.disposePromise = Promise.allSettled(
      [...this.providers.values()].map((provider) => Promise.resolve().then(() => provider.dispose(sharedDeadline)))
    ).then((settled) => {
      this.providers.clear();
      const results = settled.map((entry) => (entry.status === "fulfilled" ? entry.value : undefined));
      const rejectedCount = settled.filter((entry) => entry.status === "rejected").length;
      return aggregateTerminationResults(results, rejectedCount);
    });
    return this.disposePromise;
  }
}
