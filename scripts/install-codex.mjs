#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const configPath = path.join(codexHome, "config.toml");
const hooksPath = path.join(codexHome, "hooks.json");
const bridgeCli = path.join(packageRoot, "dist", "index.js");
const hookScript = path.join(packageRoot, "scripts", "codex-lsp-post-tool-use.mjs");
const dryRun = process.argv.includes("--dry-run");

ensureBuilt();

const configResult = upsertMcpConfig(readText(configPath));
const hooksResult = upsertPostToolUseHook(readJson(hooksPath));

if (dryRun) {
  console.log(`[codex-lsp-bridge] dry run for ${codexHome}`);
  console.log(configResult);
  console.log(JSON.stringify(hooksResult, null, 2));
  process.exit(0);
}

fs.mkdirSync(codexHome, { recursive: true });
fs.writeFileSync(configPath, configResult);
fs.writeFileSync(hooksPath, `${JSON.stringify(hooksResult, null, 2)}\n`);

console.log(`[codex-lsp-bridge] installed Codex MCP config: ${configPath}`);
console.log(`[codex-lsp-bridge] installed PostToolUse diagnostics hook: ${hooksPath}`);
console.log("[codex-lsp-bridge] restart Codex for the changes to take effect.");

function ensureBuilt() {
  if (!fs.existsSync(bridgeCli)) {
    throw new Error(`Build output not found: ${bridgeCli}. Run npm run build before installing.`);
  }
  if (!fs.existsSync(hookScript)) {
    throw new Error(`Hook script not found: ${hookScript}`);
  }
}

function readText(filePath) {
  if (!fs.existsSync(filePath)) return "";
  return fs.readFileSync(filePath, "utf8");
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return { hooks: {} };
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (raw.length === 0) return { hooks: {} };
  return JSON.parse(raw);
}

function upsertMcpConfig(config) {
  const block = [
    "[mcp_servers.codex-lsp-bridge]",
    'command = "node"',
    "args = [",
    `  ${toTomlString(bridgeCli)},`,
    '  "mcp"',
    "]",
    ""
  ].join("\n");

  const pattern = /\n?\[mcp_servers\.codex-lsp-bridge\]\n(?:[^\n]*\n)*?(?=\n\[|$)/;
  const trimmed = config.trimEnd();
  if (pattern.test(trimmed)) {
    return `${trimmed.replace(pattern, `\n${block}`)}\n`;
  }

  return `${trimmed}${trimmed.length > 0 ? "\n\n" : ""}${block}`;
}

function upsertPostToolUseHook(config) {
  const next = config && typeof config === "object" && !Array.isArray(config) ? config : {};
  next.hooks = next.hooks && typeof next.hooks === "object" && !Array.isArray(next.hooks) ? next.hooks : {};
  const hooks = Array.isArray(next.hooks.PostToolUse) ? next.hooks.PostToolUse : [];
  const entry = {
    matcher: "Write|Edit|MultiEdit|apply_patch|functions.apply_patch",
    hooks: [
      {
        type: "command",
        command: `node ${shellQuote(hookScript)}`,
        id: "codex-lsp-bridge:post-tool-diagnostics"
      }
    ]
  };

  const index = hooks.findIndex(
    (candidate) =>
      Array.isArray(candidate?.hooks) &&
      candidate.hooks.some((hook) => hook?.id === "codex-lsp-bridge:post-tool-diagnostics")
  );

  if (index >= 0) hooks[index] = entry;
  else hooks.push(entry);

  next.hooks.PostToolUse = hooks;
  return next;
}

function toTomlString(value) {
  return JSON.stringify(value);
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
