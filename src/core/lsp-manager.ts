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
import { canonicalizeWorkspaceRootSync, workspaceRootInstanceIdentitySync } from "./workspace-root.js";

export interface LspManagerOptions {
  diagnosticsTimeoutMs?: number;
  languageServers?: Partial<Record<SupportedLanguage, LanguageServerOverride>>;
  providerFactory?: (language: SupportedLanguage) => SemanticProvider;
}

export class LspManager {
  private readonly providers = new Map<SupportedLanguage, SemanticProvider>();
  private readonly retiredProviders = new Set<SemanticProvider>();
  private suspendPromise: Promise<ProcessTerminationResult | void> | undefined;
  private disposePromise: Promise<ProcessTerminationResult | void> | undefined;
  private disposed = false;

  constructor(
    rootPath: string,
    private readonly options: LspManagerOptions = {}
  ) {
    this.rootPath = canonicalizeWorkspaceRootSync(rootPath);
    this.rootInstanceIdentity = workspaceRootInstanceIdentitySync(this.rootPath);
  }

  private readonly rootPath: string;
  private readonly rootInstanceIdentity: string;

  forLanguage(language: SupportedLanguage): SemanticProvider {
    if (this.disposed) throw new Error("LSP manager is disposed");
    if (workspaceRootInstanceIdentitySync(this.rootPath) !== this.rootInstanceIdentity) {
      throw new Error(`Workspace root instance changed: ${this.rootPath} (root_replaced)`);
    }
    const existing = this.providers.get(language);
    if (existing) return existing;

    const injectedProvider = this.options.providerFactory?.(language);
    if (injectedProvider) {
      this.providers.set(language, injectedProvider);
      return injectedProvider;
    }

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
      rootInstanceIdentity: this.rootInstanceIdentity,
      clientFactory: (server) => new JsonRpcLspClient(server)
    });
    this.providers.set(language, provider);
    return provider;
  }

  forFile(filePath: string): SemanticProvider {
    return this.forLanguage(detectLanguageFromFile(filePath));
  }

  async suspend(deadline?: DisposalDeadline): Promise<ProcessTerminationResult | void> {
    if (this.disposePromise) return this.disposePromise;
    if (this.suspendPromise) return this.suspendPromise;

    const sharedDeadline = deadline ?? createDisposalDeadline();
    const providers = [...this.providers.values()];
    this.providers.clear();
    for (const provider of providers) this.retiredProviders.add(provider);
    const suspension = Promise.allSettled(providers.map((provider) => Promise.resolve().then(() => provider.dispose(sharedDeadline)))).then(
      (settled) => {
        settled.forEach((entry, index) => {
          if (entry.status === "fulfilled" && (!entry.value || entry.value.clean)) {
            this.retiredProviders.delete(providers[index]);
          }
        });
        const results = settled.map((entry) => (entry.status === "fulfilled" ? entry.value : undefined));
        const rejectedCount = settled.filter((entry) => entry.status === "rejected").length;
        return aggregateTerminationResults(results, rejectedCount);
      }
    );
    this.suspendPromise = suspension.finally(() => {
      this.suspendPromise = undefined;
    });
    return this.suspendPromise;
  }

  async dispose(deadline?: DisposalDeadline): Promise<ProcessTerminationResult | void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    const sharedDeadline = deadline ?? createDisposalDeadline();
    const suspension = this.suspendPromise;
    const disposal = (async () => {
      if (suspension) await suspension;
      const providers = [...new Set([...this.providers.values(), ...this.retiredProviders])];
      this.providers.clear();
      for (const provider of providers) this.retiredProviders.add(provider);
      const settled = await Promise.allSettled(providers.map((provider) => Promise.resolve().then(() => provider.dispose(sharedDeadline))));
      settled.forEach((entry, index) => {
        if (entry.status === "fulfilled" && (!entry.value || entry.value.clean)) {
          this.retiredProviders.delete(providers[index]);
        }
      });
      const results = settled.map((entry) => (entry.status === "fulfilled" ? entry.value : undefined));
      const rejectedCount = settled.filter((entry) => entry.status === "rejected").length;
      return aggregateTerminationResults(results, rejectedCount);
    })();
    this.disposePromise = disposal;
    void disposal.then(
      (result) => {
        if (result && !result.clean && this.disposePromise === disposal) this.disposePromise = undefined;
      },
      () => {
        if (this.disposePromise === disposal) this.disposePromise = undefined;
      }
    );
    return disposal;
  }
}
