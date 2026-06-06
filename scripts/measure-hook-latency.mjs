#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const file = readOption(args, "--file");
const runs = readPositiveInteger(readOption(args, "--runs"), 5);
const cwd = path.resolve(readOption(args, "--root") ?? process.cwd());
const hookScript = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "codex-lsp-post-tool-use.mjs");

if (!file) {
  console.error("Usage: node scripts/measure-hook-latency.mjs --file <path> [--root <path>] [--runs <n>]");
  process.exitCode = 1;
} else {
  const payload = JSON.stringify({ file_path: file });
  const results = [];

  for (let index = 0; index < runs; index += 1) {
    const startedAt = performance.now();
    const result = spawnSync(process.execPath, [hookScript], {
      cwd,
      input: payload,
      encoding: "utf8",
      env: process.env,
      maxBuffer: 1024 * 1024
    });
    const durationMs = performance.now() - startedAt;
    results.push({
      run: index + 1,
      durationMs: Math.round(durationMs),
      status: result.status,
      stdout: firstLine(result.stdout),
      stderr: firstLine(result.stderr)
    });
  }

  console.log(JSON.stringify(summarize(results), null, 2));
}

function summarize(results) {
  const durations = results.map((result) => result.durationMs).sort((left, right) => left - right);
  return {
    file,
    root: cwd,
    runs: results.length,
    minMs: durations[0],
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    maxMs: durations[durations.length - 1],
    results
  };
}

function percentile(sortedValues, percentileValue) {
  if (sortedValues.length === 0) return undefined;
  const index = Math.ceil(sortedValues.length * percentileValue) - 1;
  return sortedValues[Math.max(0, Math.min(index, sortedValues.length - 1))];
}

function firstLine(value) {
  return value.trim().split(/\r?\n/, 1)[0] ?? "";
}

function readOption(values, option) {
  const index = values.indexOf(option);
  if (index === -1) return undefined;
  return values[index + 1];
}

function readPositiveInteger(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  return fallback;
}
