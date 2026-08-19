#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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

class InstallTransactionError extends Error {
  constructor(message, rollbackState) {
    super(`${message} (${rollbackState})`);
    this.name = "InstallTransactionError";
    this.code = rollbackState;
  }
}

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
  const rollbackState = rollbackStagedUpdate(activatedUpdate ?? updatePlan);
  if (error instanceof InstallTransactionError) {
    if (rollbackState === "rollback_partial" && error.code !== "rollback_partial") {
      throw new InstallTransactionError(stripRollbackState(error.message), "rollback_partial");
    }
    throw error;
  }
  throw new InstallTransactionError(error instanceof Error ? error.message : "installation failed", rollbackState);
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
  assertSafePathAncestry(codexHome);
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
  const ownershipMarkerPath = path.join(stagingRoot, ".codex-lsp-bridge-installer-owned");
  const ownershipMarkerContent = JSON.stringify({ tool: "codex-lsp-bridge", version: 1, token: randomUUID() }) + "\n";
  let stagingRootIdentity;
  let stagingMarkerIdentity;
  try {
    fs.writeFileSync(ownershipMarkerPath, ownershipMarkerContent, { encoding: "utf8", flag: "wx" });
    stagingRootIdentity = captureFileIdentity(stagingRoot);
    stagingMarkerIdentity = captureFileIdentity(ownershipMarkerPath);
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
    return {
      stagingRoot,
      finalRoot,
      backupRoot,
      entrypointPath: path.join(finalRoot, "bridge-entrypoint.mjs"),
      ownershipMarkerPath,
      ownershipMarkerContent,
      stagingRootIdentity,
      stagingMarkerIdentity,
      active: false
    };
  } catch (error) {
    const cleanupComplete = removeOwnedPackageTree({ stagingRoot, ownershipMarkerPath, ownershipMarkerContent, stagingRootIdentity, stagingMarkerIdentity });
    if (!cleanupComplete) {
      throw new InstallTransactionError(error instanceof Error ? error.message : "explicit package update failed", "rollback_partial");
    }
    throw error;
  }
}

function activateStagedUpdate(plan) {
  if (!plan) return undefined;
  assertOwnedPackageTree(plan, plan.stagingRoot, plan.stagingRootIdentity, plan.stagingMarkerIdentity);
  assertSafePathAncestry(plan.finalRoot);
  assertSafePathAncestry(path.dirname(plan.finalRoot));
  fs.mkdirSync(path.dirname(plan.finalRoot), { recursive: true });
  assertSafePathAncestry(plan.finalRoot);
  if (pathExists(plan.finalRoot)) {
    const previousRootIdentity = captureFileIdentity(plan.finalRoot);
    fs.renameSync(plan.finalRoot, plan.backupRoot);
    plan.backupRootIdentity = previousRootIdentity;
  }
  try {
    assertSafePathAncestry(plan.stagingRoot);
    assertSafePathAncestry(plan.finalRoot);
    fs.renameSync(plan.stagingRoot, plan.finalRoot);
    plan.active = true;
    plan.activeRootIdentity = captureFileIdentity(plan.finalRoot);
    plan.activeMarkerPath = path.join(plan.finalRoot, path.basename(plan.ownershipMarkerPath));
    plan.activeMarkerIdentity = captureFileIdentity(plan.activeMarkerPath);
    assertOwnedPackageTree(plan, plan.finalRoot, plan.activeRootIdentity, plan.activeMarkerIdentity);
    return plan;
  } catch (error) {
    if (!plan.active && pathExists(plan.backupRoot) && !pathExists(plan.finalRoot)) {
      if (!plan.backupRootIdentity || sameFileIdentity(captureFileIdentity(plan.backupRoot), plan.backupRootIdentity)) {
        fs.renameSync(plan.backupRoot, plan.finalRoot);
      }
    }
    throw error;
  }
}

function commitStagedUpdate(plan) {
  if (!plan?.active) return;
  assertOwnedPackageTree(plan, plan.finalRoot, plan.activeRootIdentity, plan.activeMarkerIdentity);
  if (!pathExists(plan.backupRoot)) return;
  if (!plan.backupRootIdentity || !sameFileIdentity(captureFileIdentity(plan.backupRoot), plan.backupRootIdentity)) {
    console.warn(`[codex-lsp-bridge] preserved unproven package backup: ${plan.backupRoot}`);
    return;
  }
  if (!isInstallerOwnedPackageTree(plan, plan.backupRoot, plan.backupRootIdentity)) {
    console.warn(`[codex-lsp-bridge] preserved unproven package backup: ${plan.backupRoot}`);
    return;
  }
  if (!removeOwnedPackageTree({ root: plan.backupRoot, rootIdentity: plan.backupRootIdentity })) {
    console.warn(`[codex-lsp-bridge] preserved unproven package backup: ${plan.backupRoot}`);
  }
}

function rollbackStagedUpdate(plan) {
  if (!plan) return "rollback_complete";
  let rollbackComplete = true;
  try {
    if (plan.active) {
      if (!isInstallerOwnedPackageTree(plan, plan.finalRoot, plan.activeRootIdentity)) {
        rollbackComplete = false;
      } else {
        const activeRemoved = removeOwnedPackageTree({ root: plan.finalRoot, rootIdentity: plan.activeRootIdentity, markerPath: plan.activeMarkerPath, markerIdentity: plan.activeMarkerIdentity, markerContent: plan.ownershipMarkerContent });
        if (!activeRemoved) {
          rollbackComplete = false;
        } else {
          plan.active = false;
          if (pathExists(plan.backupRoot)) {
            if (!plan.backupRootIdentity || !sameFileIdentity(captureFileIdentity(plan.backupRoot), plan.backupRootIdentity) || pathExists(plan.finalRoot)) {
              rollbackComplete = false;
            } else {
              assertSafePathAncestry(plan.backupRoot);
              assertSafePathAncestry(plan.finalRoot);
              fs.renameSync(plan.backupRoot, plan.finalRoot);
            }
          }
        }
      }
    } else if (!cleanupStagedUpdate(plan)) {
      rollbackComplete = false;
    }
  } catch {
    rollbackComplete = false;
  }
  return rollbackComplete ? "rollback_complete" : "rollback_partial";
}

function cleanupStagedUpdate(plan) {
  if (!plan?.stagingRoot || !pathExists(plan.stagingRoot)) return true;
  return removeOwnedPackageTree({
    root: plan.stagingRoot,
    rootIdentity: plan.stagingRootIdentity,
    markerPath: plan.ownershipMarkerPath,
    markerIdentity: plan.stagingMarkerIdentity,
    markerContent: plan.ownershipMarkerContent
  });
}

function writeManagedFilesAtomically(files) {
  const journal = files.map(({ filePath, content }) => {
    assertSafePathAncestry(filePath);
    const preWrite = snapshotManagedFile(filePath);
    return { filePath, preWrite, writtenContent: Buffer.from(content, "utf8"), writtenIdentity: undefined, attempted: false };
  });
  try {
    for (const entry of journal) {
      assertManagedSnapshotCurrent(entry);
      entry.attempted = true;
      entry.writtenIdentity = writeFileAtomically(entry.filePath, entry.writtenContent);
    }
  } catch (error) {
    let rollbackComplete = true;
    for (const entry of journal.filter((candidate) => candidate.writtenIdentity).reverse()) {
      try {
        if (!managedFileMatches(entry.filePath, entry.writtenContent, entry.writtenIdentity)) {
          rollbackComplete = false;
          continue;
        }
        assertSafePathAncestry(entry.filePath);
        if (entry.preWrite.exists) writeFileAtomically(entry.filePath, entry.preWrite.content);
        else fs.unlinkSync(entry.filePath);
      } catch {
        rollbackComplete = false;
      }
    }
    if (journal.some((entry) => entry.attempted && !entry.writtenIdentity)) rollbackComplete = false;
    throw new InstallTransactionError(error instanceof Error ? error.message : "managed file write failed", rollbackComplete ? "rollback_complete" : "rollback_partial");
  }
}

function writeFileAtomically(filePath, content) {
  const bytes = Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(content, "utf8");
  assertSafePathAncestry(filePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  assertSafePathAncestry(filePath);
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
  fs.writeFileSync(temporaryPath, bytes, { flag: "wx" });
  try {
    assertSafePathAncestry(filePath);
    if (process.platform === "win32" && pathExists(filePath)) {
      const replacementBackupPath = `${filePath}.native-backup-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      if (pathExists(replacementBackupPath)) throw new Error("Windows replacement backup path already exists; refusing unsafe replacement");
      replaceExistingFileWindows(temporaryPath, filePath, replacementBackupPath);
      if (pathExists(replacementBackupPath)) fs.unlinkSync(replacementBackupPath);
    } else if (process.platform === "win32") {
      moveNewFileWindows(temporaryPath, filePath);
    } else {
      fs.renameSync(temporaryPath, filePath);
    }
    return captureFileIdentity(filePath);
  } finally {
    if (pathExists(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

function assertSafePathAncestry(filePath) {
  const absolutePath = path.resolve(filePath);
  const ancestors = [];
  let current = absolutePath;
  while (true) {
    ancestors.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const candidate of ancestors.reverse()) {
    let stats;
    try {
      stats = fs.lstatSync(candidate);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (candidate !== absolutePath && !stats.isDirectory()) throw new Error(`managed path ancestor is not a directory: ${candidate}`);
    // On Windows Node reports directory junctions and symbolic links as symbolic links from lstat.
    if (stats.isSymbolicLink()) throw new Error(`managed path ancestor is a symlink or reparse escape: ${candidate}`);
  }
}

function pathExists(filePath) {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function captureFileIdentity(filePath) {
  const stats = fs.lstatSync(filePath);
  return {
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    birthtimeMs: stats.birthtimeMs,
    isDirectory: stats.isDirectory(),
    isSymbolicLink: stats.isSymbolicLink()
  };
}

function sameFileIdentity(left, right) {
  if (!left || !right || left.isDirectory !== right.isDirectory || left.isSymbolicLink !== right.isSymbolicLink) return false;
  if (left.dev !== undefined && right.dev !== undefined && left.ino !== undefined && right.ino !== undefined && left.ino !== 0 && right.ino !== 0) {
    return left.dev === right.dev && left.ino === right.ino;
  }
  return left.birthtimeMs === right.birthtimeMs && left.size === right.size;
}

function snapshotManagedFile(filePath) {
  if (!pathExists(filePath)) return { exists: false, content: undefined, identity: undefined };
  const identity = captureFileIdentity(filePath);
  if (identity.isDirectory || identity.isSymbolicLink) throw new Error("managed target must be a regular file");
  return { exists: true, content: fs.readFileSync(filePath), identity };
}

function assertManagedSnapshotCurrent(entry) {
  const current = snapshotManagedFile(entry.filePath);
  if (current.exists !== entry.preWrite.exists || (current.exists && (!sameFileIdentity(current.identity, entry.preWrite.identity) || !current.content.equals(entry.preWrite.content)))) {
    throw new Error(`managed target changed before write: ${entry.filePath}`);
  }
}

function managedFileMatches(filePath, expectedContent, expectedIdentity) {
  if (!pathExists(filePath)) return false;
  const current = snapshotManagedFile(filePath);
  return current.content.equals(expectedContent) && sameFileIdentity(current.identity, expectedIdentity);
}

function replaceExistingFileWindows(sourcePath, targetPath, backupPath) {
  runWindowsFilePrimitive("replace", sourcePath, targetPath, backupPath);
}

function moveNewFileWindows(sourcePath, targetPath) {
  runWindowsFilePrimitive("move", sourcePath, targetPath);
}

function runWindowsFilePrimitive(operation, sourcePath, targetPath, backupPath) {
  const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (!fs.existsSync(powershell)) throw new Error("Windows atomic file primitive is unavailable; refusing unsafe replacement");
  const command = "$ErrorActionPreference='Stop'; $source=$env:CODEX_LSP_INSTALL_SOURCE; $target=$env:CODEX_LSP_INSTALL_TARGET; $backup=$env:CODEX_LSP_INSTALL_BACKUP; if ($env:CODEX_LSP_INSTALL_OPERATION -eq 'replace') { [System.IO.File]::Replace($source, $target, $backup) } else { [System.IO.File]::Move($source, $target) }";
  const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command], {
    env: { ...process.env, CODEX_LSP_INSTALL_SOURCE: sourcePath, CODEX_LSP_INSTALL_TARGET: targetPath, CODEX_LSP_INSTALL_BACKUP: backupPath ?? "", CODEX_LSP_INSTALL_OPERATION: operation },
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Windows ${operation} primitive failed: ${result.error?.message ?? (result.stderr || `status ${result.status ?? "unknown"}`).trim()}`);
  }
}

function isInstallerOwnedPackageTree(plan, root, expectedRootIdentity, expectedMarkerIdentity) {
  try {
    assertSafePathAncestry(root);
    const rootIdentity = captureFileIdentity(root);
    if (!rootIdentity.isDirectory || (expectedRootIdentity && !sameFileIdentity(rootIdentity, expectedRootIdentity))) return false;
    const markerPath = path.join(root, path.basename(plan.ownershipMarkerPath ?? ".codex-lsp-bridge-installer-owned"));
    const markerIdentity = captureFileIdentity(markerPath);
    if (expectedMarkerIdentity && !sameFileIdentity(markerIdentity, expectedMarkerIdentity)) return false;
    const marker = fs.readFileSync(markerPath, "utf8");
    return marker.startsWith('{"tool":"codex-lsp-bridge","version":1,"token":"') && marker.endsWith('"}\n');
  } catch {
    return false;
  }
}

function assertOwnedPackageTree(plan, root, expectedRootIdentity, expectedMarkerIdentity) {
  if (!isInstallerOwnedPackageTree(plan, root, expectedRootIdentity, expectedMarkerIdentity)) {
    throw new Error(`installer-owned package tree proof failed: ${root}`);
  }
}

function removeOwnedPackageTree({ root, rootIdentity, markerPath, markerIdentity, markerContent, stagingRoot, ownershipMarkerPath, ownershipMarkerContent, stagingRootIdentity, stagingMarkerIdentity }) {
  const actualRoot = root ?? stagingRoot;
  const actualMarkerPath = markerPath ?? ownershipMarkerPath;
  const actualMarkerContent = markerContent ?? ownershipMarkerContent;
  const actualRootIdentity = rootIdentity ?? stagingRootIdentity;
  const actualMarkerIdentity = markerIdentity ?? stagingMarkerIdentity;
  const plan = { ownershipMarkerPath: actualMarkerPath ?? path.join(actualRoot, ".codex-lsp-bridge-installer-owned") };
  if (!isInstallerOwnedPackageTree(plan, actualRoot, actualRootIdentity, actualMarkerIdentity)) return false;
  if (actualMarkerContent && fs.readFileSync(actualMarkerPath ?? path.join(actualRoot, path.basename(plan.ownershipMarkerPath)), "utf8") !== actualMarkerContent) return false;
  assertSafePathAncestry(actualRoot);
  fs.rmSync(actualRoot, { recursive: true, force: true });
  return !pathExists(actualRoot);
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
  const newline = config.includes("\r\n") ? "\r\n" : "\n";
  const normalized = config.replace(/\r\n?/g, "\n");
  const pattern = /(?:^|\n)\[mcp_servers\.codex-lsp-bridge\]\n[\s\S]*?(?=\n\[|$)/g;
  const matches = [...normalized.matchAll(pattern)];
  if (matches.length > 1) throw new Error("duplicate MCP configuration sections");
  const block = [
    "[mcp_servers.codex-lsp-bridge]",
    `command = ${toTomlString(launchRecord.command)}`,
    "args = [",
    ...launchRecord.args.map((arg) => `  ${toTomlString(arg)},`),
    "]",
    ""
  ].join("\n");
  const trimmed = normalized.trimEnd();
  let result;
  if (matches.length === 1) {
    result = trimmed.replace(pattern, (match) => `${match.startsWith("\n") ? "\n" : ""}${block}`);
  } else {
    result = `${trimmed}${trimmed.length > 0 ? "\n\n" : ""}${block}`;
  }
  return newline === "\n" ? result : result.replace(/\n/g, newline);
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

function stripRollbackState(message) {
  return message.replace(/\s+\(rollback_(?:complete|partial)\)$/, "");
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
