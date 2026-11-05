#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const lemminxPath = process.env.CODEX_LSP_LEMMINX_PATH;
if (!lemminxPath || !path.isAbsolute(lemminxPath) || !fs.existsSync(lemminxPath)) {
  console.error("Set CODEX_LSP_LEMMINX_PATH to the absolute path of the trusted LemMinX executable.");
  process.exit(1);
}

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = path.join(os.tmpdir(), `codex-lsp-lemminx-${process.pid}-${randomUUID()}.json`);
const vitestEntrypoint = path.join(packageRoot, "node_modules", "vitest", "vitest.mjs");
const result = spawnSync(
  process.execPath,
  [vitestEntrypoint, "run", "tests/lemminx-integration.test.ts", "--reporter=json", `--outputFile=${reportPath}`],
  {
    cwd: packageRoot,
    stdio: "inherit",
    env: { ...process.env, CODEX_LSP_REQUIRE_LEMMINX_INTEGRATION: "1" }
  }
);

try {
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);

  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  if (
    report.success !== true ||
    report.numTotalTests !== 1 ||
    report.numPassedTests !== 1 ||
    report.numFailedTests !== 0 ||
    report.numPendingTests !== 0 ||
    report.numTodoTests !== 0
  ) {
    console.error(
      `[integration] expected the one LemMinX test to run and pass: ${JSON.stringify({
        total: report.numTotalTests,
        passed: report.numPassedTests,
        failed: report.numFailedTests,
        skipped: report.numPendingTests,
        todo: report.numTodoTests
      })}`
    );
    process.exit(1);
  }
  console.log("[integration] LemMinX real Windows wire, OOXML diagnostics, and clean shutdown passed.");
} finally {
  fs.rmSync(reportPath, { force: true });
}
