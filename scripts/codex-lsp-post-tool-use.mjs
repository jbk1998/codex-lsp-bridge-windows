#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = process.cwd();
const bridgeCli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/index.js");
const maxFiles = Number(process.env.CODEX_LSP_HOOK_MAX_FILES ?? 5);

const input = await readStdin();
const event = parseJson(input);
const files = [...collectTouchedFiles(event)]
  .map((file) => path.resolve(repoRoot, file))
  .filter((file) => file.startsWith(repoRoot + path.sep))
  .filter((file) => /\.(ts|tsx)$/.test(file))
  .filter((file) => fs.existsSync(file))
  .slice(0, maxFiles);

if (files.length === 0) {
  process.exit(0);
}

const diagnostics = [];
for (const file of files) {
  const result = spawnSync(process.execPath, [bridgeCli, "diagnostics", "--file", file, "--root", repoRoot], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 1024 * 1024
  });

  if (result.status !== 0) {
    diagnostics.push({
      file,
      error: result.stderr.trim() || result.stdout.trim() || `codex-lsp-bridge exited with status ${result.status}`
    });
    continue;
  }

  diagnostics.push(JSON.parse(result.stdout));
}

const total = diagnostics.reduce((sum, item) => sum + (typeof item.total === "number" ? item.total : 0), 0);
const errorTotal = diagnostics.reduce((sum, item) => sum + (item.bySeverity?.error ?? 0), 0);
const timedOut = diagnostics.filter((item) => item.timedOut || item.status === "timed_out");

if (timedOut.length > 0 && errorTotal === 0) {
  console.log(`[codex-lsp-bridge] LSP diagnostics pending for ${timedOut.length} touched TS/TSX file(s).`);
  process.exit(0);
}

if (total === 0 && diagnostics.every((item) => !item.error)) {
  console.log(`[codex-lsp-bridge] diagnostics clean for ${files.length} touched TS/TSX file(s).`);
  process.exit(0);
}

if (errorTotal === 0 && diagnostics.every((item) => !item.error)) {
  console.log(`[codex-lsp-bridge] diagnostics: ${total} non-error issue(s) across ${files.length} touched TS/TSX file(s).`);
  process.exit(0);
}

if (isDuplicate(diagnostics)) {
  process.exit(0);
}

console.log("[codex-lsp-bridge] diagnostics after tool use:");
console.log(JSON.stringify(diagnostics, null, 2));

function parseJson(value) {
  if (value.trim().length === 0) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) {
    data += chunk;
  }
  return data;
}

function collectTouchedFiles(value, files = new Set()) {
  if (typeof value === "string") {
    addPathIfCandidate(value, files);
    return files;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectTouchedFiles(item, files);
    return files;
  }

  if (!value || typeof value !== "object") {
    return files;
  }

  for (const [key, nested] of Object.entries(value)) {
    if (isPathKey(key) && typeof nested === "string") {
      addPathIfCandidate(nested, files);
    } else {
      collectTouchedFiles(nested, files);
    }
  }

  return files;
}

function isPathKey(key) {
  return /^(file|file_path|filepath|path|target_file|target_path|absolute_path|relative_path)$/i.test(key);
}

function addPathIfCandidate(value, files) {
  if (!/\.(ts|tsx)$/.test(value)) return;
  if (value.includes("\n")) return;
  files.add(value);
}

function isDuplicate(value) {
  const hash = crypto.createHash("sha256").update(repoRoot).update(JSON.stringify(value)).digest("hex");
  const filePath = path.join(os.tmpdir(), `codex-lsp-bridge-hook-${hash}.stamp`);
  if (fs.existsSync(filePath)) return true;
  fs.writeFileSync(filePath, String(Date.now()));
  return false;
}
