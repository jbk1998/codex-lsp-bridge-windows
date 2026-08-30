#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const configPath = path.join(codexHome, "config.toml");
const hooksPath = path.join(codexHome, "hooks.json");
const agentsPath = path.join(codexHome, "AGENTS.md");
const dryRun = process.argv.includes("--dry-run");

const configResult = removeMcpConfig(readText(configPath));
const hooksResult = removePostToolUseHook(readJson(hooksPath));
const agentsResult = removeAgentInstructions(readText(agentsPath));

if (dryRun) {
  console.log(`[codex-lsp-bridge] dry run uninstall for ${codexHome}`);
  console.log(configResult);
  console.log(JSON.stringify(hooksResult, null, 2));
  console.log(agentsResult);
  process.exit(0);
}

if (fs.existsSync(configPath)) {
  fs.writeFileSync(configPath, configResult);
}
if (fs.existsSync(hooksPath)) {
  fs.writeFileSync(hooksPath, `${JSON.stringify(hooksResult, null, 2)}\n`);
}
if (fs.existsSync(agentsPath)) {
  fs.writeFileSync(agentsPath, agentsResult);
}

console.log(`[codex-lsp-bridge] removed Codex MCP config from: ${configPath}`);
console.log(`[codex-lsp-bridge] removed PostToolUse diagnostics hook from: ${hooksPath}`);
console.log(`[codex-lsp-bridge] removed Codex workflow instructions from: ${agentsPath}`);
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
  const newline = config.includes("\r\n") ? "\r\n" : "\n";
  const normalized = config.replace(/\r\n?/g, "\n");
  const pattern = /\n?\[mcp_servers\.codex-lsp-bridge\]\n[\s\S]*?(?=\n\[|$)/;
  return convertNewlines(`${normalized.trimEnd().replace(pattern, "")}\n`, newline);
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

function removeAgentInstructions(content) {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const normalized = content.replace(/\r\n?/g, "\n");
  const pattern = /\n?<!-- BEGIN codex-lsp-bridge -->[\s\S]*?<!-- END codex-lsp-bridge -->/;
  const result = normalized.trimEnd().replace(pattern, "");
  return result.length > 0 ? convertNewlines(`${result}\n`, newline) : "";
}

function convertNewlines(content, newline) {
  return newline === "\n" ? content : content.replace(/\n/g, newline);
}
