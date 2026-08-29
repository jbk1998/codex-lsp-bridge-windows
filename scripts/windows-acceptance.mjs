#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "win32") {
  console.log("[windows-acceptance] skipped outside Windows");
  process.exit(0);
}

const vitestEntrypoint = path.join(packageRoot, "node_modules", "vitest", "vitest.mjs");
if (!fs.existsSync(vitestEntrypoint)) {
  console.error("[windows-acceptance] local Vitest installation is missing; run npm ci first");
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  [vitestEntrypoint, "run", "tests/windows-acceptance.test.ts", "--reporter=verbose", "--maxWorkers=1"],
  { cwd: packageRoot, stdio: "inherit", env: process.env }
);

if (result.error) {
  console.error(`[windows-acceptance] failed to start Vitest: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
