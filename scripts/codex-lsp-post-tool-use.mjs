#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runPostToolUseDiagnostics } from "./codex-lsp-post-tool-use-core.mjs";

const input = await readStdin();
const bridgeCli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/index.js");
const result = runPostToolUseDiagnostics({ input, bridgeCli });

if (result.stdout) process.stdout.write(result.stdout);
process.exitCode = result.exitCode;

async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) {
    data += chunk;
  }
  return data;
}
