#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = path.join(os.tmpdir(), `codex-lsp-integration-${process.pid}.json`);
const vitestEntrypoint = path.join(packageRoot, "node_modules", "vitest", "vitest.mjs");

const result = spawnSync(
  process.execPath,
  [vitestEntrypoint, "run", "tests/typescript-integration.test.ts", "--reporter=json", `--outputFile=${reportPath}`],
  {
    cwd: packageRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      CODEX_LSP_REQUIRE_TYPESCRIPT_PYRIGHT_INTEGRATION: "1"
    }
  }
);

try {
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);

  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  if (
    report.success !== true ||
    report.numTotalTests < 7 ||
    report.numPassedTests !== report.numTotalTests ||
    report.numFailedTests !== 0 ||
    report.numPendingTests !== 0 ||
    report.numTodoTests !== 0
  ) {
    console.error(
      `[integration] expected at least 7 executed tests with zero failures/skips/todos; received ${JSON.stringify({
        total: report.numTotalTests,
        passed: report.numPassedTests,
        failed: report.numFailedTests,
        skipped: report.numPendingTests,
        todo: report.numTodoTests
      })}`
    );
    process.exit(1);
  }
  console.log(`[integration] ${report.numPassedTests}/${report.numTotalTests} real TypeScript/Pyright tests passed; 0 skipped.`);
} finally {
  fs.rmSync(reportPath, { force: true });
}
