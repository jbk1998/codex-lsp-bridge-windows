#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requiredPackageFiles = [
  "dist/index.js",
  "dist/adapters/language-config.js",
  "dist/core/command-service.js",
  "dist/core/lsp-manager.js",
  "dist/transport/mcp.js",
  "dist/utils/uri.js",
  "scripts/codex-lsp-post-tool-use.mjs",
  "scripts/install-codex.mjs",
  "scripts/smoke-install.mjs",
  "scripts/smoke-package.mjs",
  "scripts/uninstall-codex.mjs",
  "scripts/verify-package.mjs",
  ".codex-plugin/plugin.json",
  ".mcp.json",
  "hooks/hooks.json",
  "skills/lsp/SKILL.md",
  "docs/RELEASE.md",
  "docs/MARKETPLACE.md",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "SECURITY.md"
];

const requiredLocalFiles = [
  "dist/index.js",
  ".codex-plugin/plugin.json",
  ".mcp.json",
  "hooks/hooks.json",
  "skills/lsp/SKILL.md",
  "docs/RELEASE.md",
  "docs/MARKETPLACE.md",
  "scripts/install-codex.mjs",
  "scripts/uninstall-codex.mjs",
  "scripts/codex-lsp-post-tool-use.mjs",
  "scripts/smoke-install.mjs",
  "scripts/smoke-package.mjs",
  "scripts/verify-package.mjs"
];

for (const file of requiredLocalFiles) {
  assert(fs.existsSync(path.join(packageRoot, file)), `Missing local package input: ${file}`);
}

const npmCommand = resolveNpmCommand();
const pack = spawnSync(npmCommand.command, [...npmCommand.args, "pack", "--dry-run", "--json"], {
  cwd: packageRoot,
  env: {
    ...process.env,
    npm_config_cache: path.join(osTmp(), "codex-lsp-bridge-npm-cache")
  },
  encoding: "utf8"
});

if (pack.status !== 0) {
  process.stderr.write(pack.stderr ?? pack.error?.message ?? "npm pack failed without stderr");
  process.exit(pack.status ?? 1);
}

const entries = JSON.parse(pack.stdout);
const files = new Set((entries[0]?.files?.map((file) => file.path) ?? []).map((file) => file.replace(/^package\//, "")));
for (const file of requiredPackageFiles) {
  assert(files.has(file), `npm pack output is missing ${file}`);
}

const unexpected = [...files].filter((file) => file.startsWith("dist/tests/") || file.startsWith("dist/src/"));
assert(unexpected.length === 0, `npm pack output includes stale build artifacts: ${unexpected.join(", ")}`);

console.log(`[codex-lsp-bridge] verified npm package contents (${files.size} files)`);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function osTmp() {
  return process.env.TMPDIR || process.env.TEMP || process.env.TMP || "/tmp";
}

function resolveNpmCommand() {
  if (process.env.npm_execpath && fs.existsSync(process.env.npm_execpath)) {
    return { command: process.execPath, args: [process.env.npm_execpath] };
  }

  const bundledNpm = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (fs.existsSync(bundledNpm)) {
    return { command: process.execPath, args: [bundledNpm] };
  }

  return { command: process.platform === "win32" ? "npm.cmd" : "npm", args: [] };
}
