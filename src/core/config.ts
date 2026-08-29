import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readDiagnosticsTimeoutPolicy, type DiagnosticsTimeoutPolicy } from "./diagnostics-timeout.js";
import type { SupportedLanguage } from "../adapters/language-config.js";

export interface LspClientConfig {
  defaultLanguage: SupportedLanguage;
  diagnosticsTimeoutMs: DiagnosticsTimeoutPolicy;
  /**
   * Suspend idle LSP resources after this many milliseconds; zero disables it.
   * The value is read once from the MCP connection's startup root and is not
   * changed when a later request selects another workspace root.
   */
  mcpIdleTimeoutMs?: number;
  hook: {
    maxFiles: number;
    verbosePending: boolean;
  };
  languageServers: Partial<Record<SupportedLanguage, { command?: string; args?: string[] }>>;
}

const defaults: LspClientConfig = {
  defaultLanguage: "typescript",
  diagnosticsTimeoutMs: 15000,
  hook: {
    maxFiles: 5,
    verbosePending: false
  },
  languageServers: {}
};

/**
 * Idle suspension is intentionally scoped to one MCP connection. A stdio
 * connection has one timer, so requests that select another root do not create
 * competing timers or silently change the startup policy.
 */
export const mcpIdleTimeoutPolicy = "connection-startup" as const;

/**
 * Capture the startup-root value passed to the one MCP connection timer.
 * Root-specific requests must not call this again to mutate that timer.
 */
export function resolveMcpConnectionIdleTimeout(config: Pick<LspClientConfig, "mcpIdleTimeoutMs">): number | undefined {
  return config.mcpIdleTimeoutMs;
}

/** A present config file that cannot be parsed or validated blocks the operation. */
export class LspClientConfigError extends Error {
  constructor(
    readonly configPath: string,
    message: string
  ) {
    super(`Invalid LSP client config at ${configPath}: ${message}`);
    this.name = "LspClientConfigError";
  }
}

/**
 * Load global and workspace settings with a fail-closed policy. A malformed
 * file is never silently ignored: the thrown error names the source path and
 * the field or JSON repair needed before retrying.
 */
export function loadConfig(rootPath: string): LspClientConfig {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const globalConfig = readConfig(path.join(codexHome, "lsp-client.json"));
  const localConfig = readConfig(path.join(rootPath, ".codex", "lsp-client.json"));
  return mergeConfig(defaults, globalConfig, omitWorkspaceExecutableOverrides(localConfig));
}

/**
 * Workspace files are repository-controlled input. Let them tune bridge
 * behavior, but never let a checkout choose which executable and arguments the
 * bridge launches. Language-server process overrides are trusted global config
 * only.
 */
function omitWorkspaceExecutableOverrides(config: Partial<LspClientConfig>): Partial<LspClientConfig> {
  if (config.languageServers === undefined) return config;
  const { languageServers: _ignored, ...safeConfig } = config;
  return safeConfig;
}

function readConfig(filePath: string): Partial<LspClientConfig> {
  if (!fs.existsSync(filePath)) return {};
  let source: string;
  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) return {};
    throw new LspClientConfigError(filePath, `cannot be read (${errorMessage(error)}); fix the file permissions or remove the file`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    throw new LspClientConfigError(filePath, `invalid JSON (${errorMessage(error)}); fix the JSON syntax or remove the file`);
  }
  if (!isConfigObject(parsed)) {
    throw new LspClientConfigError(filePath, "the top-level value must be a JSON object; replace it with an object or remove the file");
  }
  validateConfig(parsed, filePath);
  return parsed as Partial<LspClientConfig>;
}

function validateConfig(config: Record<string, unknown>, filePath: string): void {
  if (config.defaultLanguage !== undefined && !isSupportedLanguage(config.defaultLanguage)) {
    throwInvalidField(filePath, "defaultLanguage", "one of: typescript, rust, python, go");
  }
  if (config.diagnosticsTimeoutMs !== undefined && !isValidDiagnosticsTimeout(config.diagnosticsTimeoutMs)) {
    throwInvalidField(filePath, "diagnosticsTimeoutMs", 'a positive finite number or "auto"');
  }
  if (config.mcpIdleTimeoutMs !== undefined && !isValidNonNegativeInteger(config.mcpIdleTimeoutMs)) {
    throwInvalidField(filePath, "mcpIdleTimeoutMs", "a non-negative safe integer in milliseconds (0 disables it)");
  }

  if (config.hook !== undefined) {
    if (!isConfigObject(config.hook)) {
      throwInvalidField(filePath, "hook", "a JSON object");
    }
    if (config.hook.maxFiles !== undefined && !isValidPositiveNumber(config.hook.maxFiles)) {
      throwInvalidField(filePath, "hook.maxFiles", "a positive finite number");
    }
    if (config.hook.verbosePending !== undefined && typeof config.hook.verbosePending !== "boolean") {
      throwInvalidField(filePath, "hook.verbosePending", "a boolean");
    }
  }

  if (config.languageServers !== undefined) {
    if (!isConfigObject(config.languageServers)) {
      throwInvalidField(filePath, "languageServers", "a JSON object");
    }
    for (const [language, override] of Object.entries(config.languageServers)) {
      if (!isSupportedLanguage(language)) {
        throwInvalidField(filePath, `languageServers.${language}`, "a supported language key");
      }
      if (!isConfigObject(override)) {
        throwInvalidField(filePath, `languageServers.${language}`, "a JSON object");
      }
      if (override.command !== undefined && (typeof override.command !== "string" || override.command.trim().length === 0)) {
        throwInvalidField(filePath, `languageServers.${language}.command`, "a non-empty string");
      }
      if (
        override.args !== undefined &&
        (!Array.isArray(override.args) || override.args.some((argument) => typeof argument !== "string"))
      ) {
        throwInvalidField(filePath, `languageServers.${language}.args`, "an array of strings");
      }
    }
  }
}

function throwInvalidField(filePath: string, field: string, expected: string): never {
  throw new LspClientConfigError(filePath, `${field} must be ${expected}; fix this field or remove the file`);
}

function isConfigObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidDiagnosticsTimeout(value: unknown): boolean {
  return value === "auto" || isValidPositiveNumber(value);
}

function isValidPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isValidNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647;
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mergeConfig(...configs: Partial<LspClientConfig>[]): LspClientConfig {
  return configs.reduce<LspClientConfig>(
    (merged, config) => ({
      defaultLanguage: isSupportedLanguage(config.defaultLanguage) ? config.defaultLanguage : merged.defaultLanguage,
      diagnosticsTimeoutMs: readDiagnosticsTimeoutPolicy(config.diagnosticsTimeoutMs, merged.diagnosticsTimeoutMs),
      mcpIdleTimeoutMs: readNonNegativeInteger(config.mcpIdleTimeoutMs, merged.mcpIdleTimeoutMs),
      hook: {
        maxFiles: readPositiveNumber(config.hook?.maxFiles, merged.hook.maxFiles),
        verbosePending: typeof config.hook?.verbosePending === "boolean" ? config.hook.verbosePending : merged.hook.verbosePending
      },
      languageServers: {
        ...merged.languageServers,
        ...config.languageServers
      }
    }),
    { ...defaults, hook: { ...defaults.hook }, languageServers: { ...defaults.languageServers } }
  );
}

function readPositiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function readNonNegativeInteger(value: unknown, fallback: number | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647 ? value : fallback;
}

function isSupportedLanguage(value: unknown): value is SupportedLanguage {
  return value === "typescript" || value === "rust" || value === "python" || value === "go";
}
