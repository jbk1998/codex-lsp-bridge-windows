#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const configPath = path.join(codexHome, "config.toml");
const hooksPath = path.join(codexHome, "hooks.json");
const agentsPath = path.join(codexHome, "AGENTS.md");
const bridgeCli = path.join(packageRoot, "dist", "index.js");
const hookScript = path.join(packageRoot, "scripts", "codex-lsp-post-tool-use.mjs");
const dryRun = process.argv.includes("--dry-run");
const autoUpdate = process.argv.includes("--auto-update");
const packageSpec = readOption("--package") ?? "codex-lsp-bridge@latest";

ensureBuilt();

const configResult = upsertMcpConfig(readText(configPath));
const hooksResult = upsertPostToolUseHook(readJson(hooksPath));
const agentsResult = upsertAgentInstructions(readText(agentsPath));

if (dryRun) {
  console.log(`[codex-lsp-bridge] dry run for ${codexHome}`);
  console.log(configResult);
  console.log(JSON.stringify(hooksResult, null, 2));
  console.log(agentsResult);
  process.exit(0);
}

fs.mkdirSync(codexHome, { recursive: true });
fs.writeFileSync(configPath, configResult);
fs.writeFileSync(hooksPath, `${JSON.stringify(hooksResult, null, 2)}\n`);
fs.writeFileSync(agentsPath, agentsResult);

console.log(`[codex-lsp-bridge] installed Codex MCP config: ${configPath}`);
console.log(`[codex-lsp-bridge] installed PostToolUse diagnostics hook: ${hooksPath}`);
console.log(`[codex-lsp-bridge] installed Codex workflow instructions: ${agentsPath}`);
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
  const command = autoUpdate ? "npm" : "node";
  const args = autoUpdate
    ? ["exec", "--yes", `--package=${packageSpec}`, "--", "codex-lsp-bridge", "mcp"]
    : [bridgeCli, "mcp"];
  const block = ["[mcp_servers.codex-lsp-bridge]", `command = ${toTomlString(command)}`, "args = ["]
    .concat(args.map((arg) => `  ${toTomlString(arg)},`))
    .concat("]", "")
    .join("\n");

  const pattern = /\n?\[mcp_servers\.codex-lsp-bridge\]\n[\s\S]*?(?=\n\[|$)/;
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
        command: autoUpdate
          ? `npm exec --yes --package=${shellQuote(packageSpec)} -- codex-lsp-bridge post-tool-diagnostics`
          : `node ${shellQuote(hookScript)}`,
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
  if (pattern.test(trimmed)) {
    return `${trimmed.replace(pattern, `\n${block}`)}\n`;
  }
  return `${trimmed}${trimmed.length > 0 ? "\n\n" : ""}${block}\n`;
}

function toTomlString(value) {
  return JSON.stringify(value);
}

function readOption(option) {
  const index = process.argv.indexOf(option);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
