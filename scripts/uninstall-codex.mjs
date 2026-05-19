#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const configPath = path.join(codexHome, "config.toml");
const hooksPath = path.join(codexHome, "hooks.json");
const dryRun = process.argv.includes("--dry-run");

const configResult = removeMcpConfig(readText(configPath));
const hooksResult = removePostToolUseHook(readJson(hooksPath));

if (dryRun) {
  console.log(`[codex-lsp-bridge] dry run uninstall for ${codexHome}`);
  console.log(configResult);
  console.log(JSON.stringify(hooksResult, null, 2));
  process.exit(0);
}

if (fs.existsSync(configPath)) {
  fs.writeFileSync(configPath, configResult);
}
if (fs.existsSync(hooksPath)) {
  fs.writeFileSync(hooksPath, `${JSON.stringify(hooksResult, null, 2)}\n`);
}

console.log(`[codex-lsp-bridge] removed Codex MCP config from: ${configPath}`);
console.log(`[codex-lsp-bridge] removed PostToolUse diagnostics hook from: ${hooksPath}`);
console.log("[codex-lsp-bridge] restart Codex for the changes to take effect.");

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

function removeMcpConfig(config) {
  const pattern = /\n?\[mcp_servers\.codex-lsp-bridge\]\n[\s\S]*?(?=\n\[|$)/;
  return `${config.trimEnd().replace(pattern, "")}\n`;
}

function removePostToolUseHook(config) {
  const next = config && typeof config === "object" && !Array.isArray(config) ? config : {};
  next.hooks = next.hooks && typeof next.hooks === "object" && !Array.isArray(next.hooks) ? next.hooks : {};
  const hooks = Array.isArray(next.hooks.PostToolUse) ? next.hooks.PostToolUse : [];

  next.hooks.PostToolUse = hooks
    .map((entry) => ({
      ...entry,
      hooks: Array.isArray(entry?.hooks)
        ? entry.hooks.filter((hook) => hook?.id !== "codex-lsp-bridge:post-tool-diagnostics")
        : entry?.hooks
    }))
    .filter((entry) => !Array.isArray(entry?.hooks) || entry.hooks.length > 0);

  if (next.hooks.PostToolUse.length === 0) {
    delete next.hooks.PostToolUse;
  }

  return next;
}
