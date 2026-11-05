#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executablePath = process.env.CODEX_LSP_TYPESCRIPT_NATIVE_EXECUTABLE;
if (!executablePath || !path.isAbsolute(executablePath) || !fs.existsSync(executablePath)) {
  throw new Error("Set CODEX_LSP_TYPESCRIPT_NATIVE_EXECUTABLE to an existing absolute TypeScript 7 tsc executable path");
}

const reportPath = path.join(os.tmpdir(), `codex-lsp-native-integration-${process.pid}.json`);
const vitestEntrypoint = path.join(packageRoot, "node_modules", "vitest", "vitest.mjs");
const result = spawnSync(
  process.execPath,
  [vitestEntrypoint, "run", "tests/typescript-native-integration.test.ts", "--reporter=json", `--outputFile=${reportPath}`],
  {
    cwd: packageRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      CODEX_LSP_REQUIRE_TYPESCRIPT_NATIVE_INTEGRATION: "1"
    }
  }
);

try {
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Native TypeScript integration process exited with ${result.status ?? "no status"}`);

  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  if (
    report.success !== true ||
    report.numTotalTests !== 1 ||
    report.numPassedTests !== 1 ||
    report.numFailedTests !== 0 ||
    report.numPendingTests !== 0 ||
    report.numTodoTests !== 0
  ) {
    throw new Error(
      `Expected exactly one native TypeScript integration test with no skips; received ${JSON.stringify({
        total: report.numTotalTests,
        passed: report.numPassedTests,
        failed: report.numFailedTests,
        skipped: report.numPendingTests,
        todo: report.numTodoTests
      })}`
    );
  }
  console.log("[integration] Native TypeScript 7 diagnostics, navigation, and clean disposal passed.");
} finally {
  fs.rmSync(reportPath, { force: true });
}
