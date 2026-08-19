#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createNativeNodeLaunchRecord,
  revalidateNativeNodeRuntime,
  validateNativeNodeRuntime
} from "../dist/core/native-node-runtime.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const configPath = path.join(codexHome, "config.toml");
const hooksPath = path.join(codexHome, "hooks.json");
const agentsPath = path.join(codexHome, "AGENTS.md");
const bridgeCli = path.join(packageRoot, "dist", "index.js");
const descriptorPath = path.join(packageRoot, "dist", "core", "native-node-runtime.js");
const hookScript = path.join(packageRoot, "scripts", "codex-lsp-post-tool-use.mjs");
const dryRun = process.argv.includes("--dry-run");
const autoUpdate = process.argv.includes("--auto-update");
const withRustAnalyzer = process.argv.includes("--with-rust-analyzer") || process.argv.includes("--with-rust");
const packageSpec = readOption("--package") ?? "codex-lsp-bridge@latest";

ensureBuilt();
ensureSafeCodexHome();
if (autoUpdate) validatePackageSpec(packageSpec);

const runtimeValidation = validateNativeNodeRuntime();
const existingConfig = readText(configPath);
const existingHooks = readText(hooksPath);
const existingAgents = readText(agentsPath);
const hookState = inspectHookState(existingHooks);
const updatePlan = autoUpdate
  ? dryRun
    ? { entrypointPath: path.join(codexHome, "codex-lsp-bridge", "bridge-entrypoint.mjs") }
    : stagePackageUpdate(packageSpec)
  : undefined;
const bridgeTarget = updatePlan?.entrypointPath ?? bridgeCli;
const launchRecord = createNativeNodeLaunchRecord(bridgeTarget, ["mcp"], runtimeValidation.executablePath);
const configResult = upsertMcpConfig(existingConfig, launchRecord);
const agentsResult = upsertAgentInstructions(existingAgents);

if (dryRun) {
  console.log(`[codex-lsp-bridge] dry run for ${codexHome}`);
  console.log(configResult);
  console.log(JSON.stringify({ hookState, managedHookChanged: false }, null, 2));
  console.log(agentsResult);
  if (autoUpdate) {
    console.log(`[codex-lsp-bridge] would resolve package during explicit update: ${packageSpec}`);
  }
  if (withRustAnalyzer) {
    console.log("[codex-lsp-bridge] would install rust-analyzer with: rustup component add rust-analyzer");
  }
  cleanupStagedUpdate(updatePlan);
  process.exit(0);
}

let activatedUpdate;
try {
  if (withRustAnalyzer) installRustAnalyzer();
  revalidateNativeNodeRuntime(runtimeValidation);
  activatedUpdate = activateStagedUpdate(updatePlan);
  writeManagedFilesAtomically([
    { filePath: configPath, content: configResult },
    { filePath: agentsPath, content: agentsResult }
  ]);
  commitStagedUpdate(activatedUpdate);
} catch (error) {
  rollbackStagedUpdate(activatedUpdate ?? updatePlan);
  if (error instanceof InstallTransactionError) throw error;
  throw new InstallTransactionError(error instanceof Error ? error.message : "installation failed", "rollback_complete");
}

console.log(`[codex-lsp-bridge] installed Codex MCP config: ${configPath}`);
console.log(`[codex-lsp-bridge] preserved PostToolUse hook state: ${hookState}`);
console.log(`[codex-lsp-bridge] installed Codex workflow instructions: ${agentsPath}`);
if (autoUpdate) console.log(`[codex-lsp-bridge] completed explicit package update: ${packageSpec}`);
console.log("[codex-lsp-bridge] restart Codex for the changes to take effect.");

function ensureBuilt() {
  if (!fs.existsSync(bridgeCli) || !fs.existsSync(descriptorPath)) {
    throw new Error("Build output is missing. Run npm run build before installing.");
  }
  if (!fs.existsSync(hookScript)) {
    throw new Error("Hook script is missing from the package.");
  }
}

function ensureSafeCodexHome() {
  try {
    if (fs.lstatSync(codexHome).isSymbolicLink()) {
      throw new Error("CODEX_HOME must not be a symbolic link.");
    }
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
}

function installRustAnalyzer() {
  if (commandExists("rust-analyzer")) {
    console.log("[codex-lsp-bridge] rust-analyzer already available.");
    return;
  }

  if (!commandExists("rustup")) {
    throw new Error("Cannot install rust-analyzer because rustup is not available. Install Rust from https://rustup.rs/ or rerun without --with-rust-analyzer.");
  }

  const result = spawnSync("rustup", ["component", "add", "rust-analyzer"], { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`rustup component add rust-analyzer failed with status ${result.status ?? "unknown"}`);
  }
}

function stagePackageUpdate(spec) {
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-lsp-bridge-update-"));
  const finalRoot = path.join(codexHome, "codex-lsp-bridge");
  const backupRoot = `${finalRoot}.backup-${process.pid}-${Date.now()}`;
  try {
    const npmCommand = resolveNpmCommand();
    const result = spawnSync(npmCommand.command, [...npmCommand.args, "install", "--no-save", "--no-package-lock", "--ignore-scripts", "--prefix", stagingRoot, spec], {
      cwd: packageRoot,
      env: { ...process.env, npm_config_update_notifier: "false" },
      encoding: "utf8",
      windowsVerbatimArguments: npmCommand.windowsVerbatimArguments
    });
    if (result.status !== 0) {
      throw new Error("explicit package update failed");
    }
    const installedCli = path.join(stagingRoot, "node_modules", "codex-lsp-bridge", "dist", "index.js");
    if (!fs.existsSync(installedCli)) {
      throw new Error("explicit package update did not contain the bridge entrypoint");
    }
    const entrypointPath = path.join(stagingRoot, "bridge-entrypoint.mjs");
    fs.writeFileSync(entrypointPath, 'import "./node_modules/codex-lsp-bridge/dist/index.js";\n', "utf8");
    return { stagingRoot, finalRoot, backupRoot, entrypointPath: path.join(finalRoot, "bridge-entrypoint.mjs"), active: false };
  } catch (error) {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

function activateStagedUpdate(plan) {
  if (!plan) return undefined;
  fs.mkdirSync(path.dirname(plan.finalRoot), { recursive: true });
  if (fs.existsSync(plan.finalRoot)) fs.renameSync(plan.finalRoot, plan.backupRoot);
  try {
    fs.renameSync(plan.stagingRoot, plan.finalRoot);
    plan.active = true;
    return plan;
  } catch (error) {
    if (fs.existsSync(plan.backupRoot) && !fs.existsSync(plan.finalRoot)) fs.renameSync(plan.backupRoot, plan.finalRoot);
    throw error;
  }
}

function commitStagedUpdate(plan) {
  if (!plan?.active) return;
  if (fs.existsSync(plan.backupRoot)) fs.rmSync(plan.backupRoot, { recursive: true, force: true });
}

function rollbackStagedUpdate(plan) {
  if (!plan) return;
  try {
    if (plan.active) {
      if (fs.existsSync(plan.finalRoot)) fs.rmSync(plan.finalRoot, { recursive: true, force: true });
      if (fs.existsSync(plan.backupRoot)) fs.renameSync(plan.backupRoot, plan.finalRoot);
      plan.active = false;
      return;
    }
    cleanupStagedUpdate(plan);
  } catch {
    // The transaction wrapper reports the original failure; the stable rollback code is retained.
  }
}

function cleanupStagedUpdate(plan) {
  if (plan?.stagingRoot && fs.existsSync(plan.stagingRoot)) fs.rmSync(plan.stagingRoot, { recursive: true, force: true });
}

function writeManagedFilesAtomically(files) {
  const snapshots = files.map(({ filePath }) => ({
    filePath,
    exists: fs.existsSync(filePath),
    content: fs.existsSync(filePath) ? fs.readFileSync(filePath) : undefined
  }));
  const written = [];
  try {
    for (const file of files) {
      assertSafeWriteTarget(file.filePath);
      writeFileAtomically(file.filePath, file.content);
      written.push(file.filePath);
    }
  } catch (error) {
    let rollbackComplete = true;
    for (const snapshot of snapshots.filter((candidate) => written.includes(candidate.filePath)).reverse()) {
      try {
        if (snapshot.exists) writeFileAtomically(snapshot.filePath, snapshot.content);
        else if (fs.existsSync(snapshot.filePath)) fs.rmSync(snapshot.filePath, { force: true });
      } catch {
        rollbackComplete = false;
      }
    }
    throw new InstallTransactionError(error instanceof Error ? error.message : "managed file write failed", rollbackComplete ? "rollback_complete" : "rollback_partial");
  }
}

function writeFileAtomically(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  assertSafeWriteTarget(filePath);
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
  fs.writeFileSync(temporaryPath, content, "utf8");
  try {
    if (process.platform === "win32" && fs.existsSync(filePath)) {
      const backupPath = `${filePath}.replace-${process.pid}-${Date.now()}`;
      fs.renameSync(filePath, backupPath);
      try {
        fs.renameSync(temporaryPath, filePath);
      } catch (error) {
        if (!fs.existsSync(filePath) && fs.existsSync(backupPath)) fs.renameSync(backupPath, filePath);
        throw error;
      }
      if (fs.existsSync(backupPath)) fs.rmSync(backupPath, { force: true });
      return;
    }
    fs.renameSync(temporaryPath, filePath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
  }
}

function assertSafeWriteTarget(filePath) {
  try {
    if (fs.lstatSync(filePath).isSymbolicLink()) throw new Error("managed target is a symbolic link");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try {
    if (fs.lstatSync(path.dirname(filePath)).isSymbolicLink()) throw new Error("managed target parent is a symbolic link");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function commandExists(command) {
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  for (const directory of pathEntries) {
    for (const extension of extensions) {
      try {
        fs.accessSync(path.join(directory, `${command}${extension}`), fs.constants.X_OK);
        return true;
      } catch {
        continue;
      }
    }
  }
  return false;
}

function readText(filePath) {
  if (!fs.existsSync(filePath)) return "";
  return fs.readFileSync(filePath, "utf8");
}

function upsertMcpConfig(config, launchRecord) {
  const pattern = /\n?\[mcp_servers\.codex-lsp-bridge\]\n[\s\S]*?(?=\n\[|$)/g;
  const matches = [...config.matchAll(pattern)];
  if (matches.length > 1) throw new Error("duplicate MCP configuration sections");
  const block = [
    "[mcp_servers.codex-lsp-bridge]",
    `command = ${toTomlString(launchRecord.command)}`,
    "args = [",
    ...launchRecord.args.map((arg) => `  ${toTomlString(arg)},`),
    "]",
    ""
  ].join("\n");
  const trimmed = config.trimEnd();
  if (matches.length === 1) return `${trimmed.replace(pattern, `\n${block}`)}\n`;
  return `${trimmed}${trimmed.length > 0 ? "\n\n" : ""}${block}`;
}

function upsertAgentInstructions(content) {
  const block = [
    "<!-- BEGIN codex-lsp-bridge -->",
    "## codex-lsp-bridge",
    "",
    "When the `codex-lsp-bridge` MCP tools are available, use them as the semantic feedback layer for code work.",
    "",
    "- After editing supported source files, use `lsp_diagnostics` for the touched files before broader verification.",
    "- During code review, audit, or investigation workflows, do not rely only on grep and diff review. After identifying changed supported source files, call `lsp_diagnostics` for the changed files or the smallest representative set before final findings.",
    "- Before renames, moves, signature changes, import rewrites, or multi-file semantic refactors, call `lsp_definition` and `lsp_references` for the relevant symbol or file position.",
    "- Prefer file-position or file-specific inputs over symbol-only inputs when the exact occurrence is known.",
    "- If LSP is unavailable, stale, missing a language server, or ambiguous, say so and fall back to the narrowest repo-native verification command.",
    "",
    "<!-- END codex-lsp-bridge -->"
  ].join("\n");
  const pattern = /\n?<!-- BEGIN codex-lsp-bridge -->[\s\S]*?<!-- END codex-lsp-bridge -->/;
  const trimmed = content.trimEnd();
  if (pattern.test(trimmed)) return `${trimmed.replace(pattern, `\n${block}`)}\n`;
  return `${trimmed}${trimmed.length > 0 ? "\n\n" : ""}${block}\n`;
}

function inspectHookState(content) {
  if (!content.trim()) return "absent";
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content.includes("codex-lsp-bridge:post-tool-diagnostics") ? "invalid" : "absent";
  }
  const hooks = parsed?.hooks?.PostToolUse;
  if (!Array.isArray(hooks)) return "absent";
  for (const entry of hooks) {
    for (const hook of Array.isArray(entry?.hooks) ? entry.hooks : []) {
      if (hook?.id !== "codex-lsp-bridge:post-tool-diagnostics") continue;
      return hook.enabled === false || entry.enabled === false ? "disabled" : "enabled";
    }
  }
  return "absent";
}

function validatePackageSpec(spec) {
  if (typeof spec !== "string" || spec.length === 0 || spec.length > 512 || spec.startsWith("-")) {
    throw new Error("invalid package specification");
  }
  if ([...spec].some((character) => character.charCodeAt(0) < 0x20 || ";&|<>`$".includes(character))) {
    throw new Error("invalid package specification");
  }
}

function toTomlString(value) {
  return JSON.stringify(value);
}

function readOption(option) {
  const index = process.argv.indexOf(option);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function resolveNpmCommand() {
  if (process.env.npm_execpath && fs.existsSync(process.env.npm_execpath)) {
    return { command: process.execPath, args: [process.env.npm_execpath] };
  }
  const bundledNpm = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (fs.existsSync(bundledNpm)) return { command: process.execPath, args: [bundledNpm] };
  if (process.platform === "win32") {
    return { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", "npm"], windowsVerbatimArguments: true };
  }
  return { command: "npm", args: [] };
}

class InstallTransactionError extends Error {
  constructor(message, rollbackState) {
    super(`${message} (${rollbackState})`);
    this.name = "InstallTransactionError";
    this.code = rollbackState;
  }
}
