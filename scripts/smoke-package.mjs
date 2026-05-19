#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-lsp-package-"));
const npmCache = path.join(tempRoot, "npm-cache");
const env = { ...process.env, npm_config_cache: npmCache };

const packed = run("npm", ["pack", "--json"], packageRoot);
const packEntries = JSON.parse(packed.stdout);
const tarballName = packEntries[0]?.filename;
assert(typeof tarballName === "string" && tarballName.length > 0, "npm pack did not return a tarball filename");

const tarballPath = path.join(packageRoot, tarballName);
try {
  run("npm", ["init", "-y"], tempRoot);
  run("npm", ["install", tarballPath], tempRoot);

  const binPath = path.join(tempRoot, "node_modules", ".bin", process.platform === "win32" ? "codex-lsp-bridge.cmd" : "codex-lsp-bridge");
  const usage = run(binPath, ["--help"], tempRoot);
  assert(usage.stdout.includes("Usage:"), "installed package --help did not print usage");

  const help = run(binPath, ["doctor", "--root", packageRoot], tempRoot);
  assert(help.stdout.includes('"distExists": true'), "installed package doctor did not report distExists true");

  const installBin = path.join(tempRoot, "node_modules", ".bin", process.platform === "win32" ? "codex-lsp-bridge-install.cmd" : "codex-lsp-bridge-install");
  const codexHome = path.join(tempRoot, "codex-home");
  run(installBin, ["--dry-run"], tempRoot, { CODEX_HOME: codexHome });
} finally {
  fs.rmSync(tarballPath, { force: true });
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log("[codex-lsp-bridge] package install smoke passed");

function run(command, args, cwd, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...env, ...extraEnv },
    encoding: "utf8",
    shell: process.platform === "win32"
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.stderr.write(result.stdout);
    process.exit(result.status ?? 1);
  }
  return result;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
