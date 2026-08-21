#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-lsp-install-"));
const env = { ...process.env, CODEX_HOME: codexHome };

fs.writeFileSync(path.join(codexHome, "hooks.json"), JSON.stringify({ hooks: { UserHook: [{ id: "user-owned" }] } }, null, 2) + "\n", "utf8");
fs.writeFileSync(path.join(codexHome, "AGENTS.md"), "# User-owned instructions\n", "utf8");

run(["scripts/install-codex.mjs"]);

const config = read("config.toml");
const hooks = read("hooks.json");
const agents = read("AGENTS.md");

assert(config.includes("[mcp_servers.codex-lsp-bridge]"), "install did not write MCP config");
assert(config.replaceAll("\\", "/").replace(/\/+/g, "/").includes("dist/index.js"), "install did not point MCP config at local dist");
assert(!hooks.includes("codex-lsp-bridge:post-tool-diagnostics"), "install unexpectedly enabled the managed PostToolUse hook");
assert(hooks.includes("user-owned"), "install did not preserve user-owned hooks");
assert(!config.match(/command\s*=\s*"(?:node|npm|npx)"/), "install used a mutable runtime command");
assert(agents.includes("BEGIN codex-lsp-bridge"), "install did not write AGENTS instructions");
assert(agents.includes("User-owned instructions"), "install did not preserve user-owned AGENTS content");

const crlfConfig = config.replace(/\r\n?/g, "\n").replace(/\n/g, "\r\n");
fs.writeFileSync(path.join(codexHome, "config.toml"), crlfConfig, "utf8");
run(["scripts/install-codex.mjs"]);
const rewrittenConfig = read("config.toml");
assert(rewrittenConfig.includes("\r\n"), "reinstall did not preserve CRLF config line endings");
assert((rewrittenConfig.replace(/\r\n?/g, "\n").match(/^\[mcp_servers\.codex-lsp-bridge\]$/gm) ?? []).length === 1, "CRLF reinstall created duplicate MCP sections");

run(["scripts/uninstall-codex.mjs"]);

assert(!read("config.toml").includes("[mcp_servers.codex-lsp-bridge]"), "uninstall left MCP config behind");
assert(!read("hooks.json").includes("codex-lsp-bridge:post-tool-diagnostics"), "uninstall left hook behind");
assert(!read("AGENTS.md").includes("BEGIN codex-lsp-bridge"), "uninstall left AGENTS instructions behind");
assert(read("hooks.json").includes("user-owned"), "uninstall removed user-owned hooks");
assert(read("AGENTS.md").includes("User-owned instructions"), "uninstall removed user-owned AGENTS content");

run(["scripts/install-codex.mjs", "--auto-update", "--package", `file:${packageRoot}`]);

const autoConfig = read("config.toml");
assert(!autoConfig.match(/command\s*=\s*"(?:node|npm|npx)"/), "auto-update install used a mutable runtime command");
assert(autoConfig.replaceAll("\\", "/").replace(/\/+/g, "/").includes("codex-lsp-bridge/bridge-entrypoint.mjs"), "auto-update install did not materialize a local bridge entrypoint");
assert(!read("hooks.json").includes("codex-lsp-bridge:post-tool-diagnostics"), "auto-update install enabled the managed PostToolUse hook");

run(["scripts/install-codex.mjs", "--auto-update", "--package", `file:${packageRoot}`]);
const leftoverBackups = fs.readdirSync(codexHome).filter((entry) => entry.startsWith("codex-lsp-bridge.backup-"));
assert(leftoverBackups.length === 0, "auto-update left an installer-owned backup behind");

const rustDryRun = run(["scripts/install-codex.mjs", "--dry-run", "--with-rust-analyzer"]);
assert(rustDryRun.stdout.includes("would install rust-analyzer"), "with-rust-analyzer dry run did not report rustup action");

fs.rmSync(codexHome, { recursive: true, force: true });
console.log("[codex-lsp-bridge] install/uninstall smoke passed");

function run(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: packageRoot,
    env,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.stderr.write(result.stdout);
    process.exit(result.status ?? 1);
  }
  return result;
}

function read(relativePath) {
  const filePath = path.join(codexHome, relativePath);
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
