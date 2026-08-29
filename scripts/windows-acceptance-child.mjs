#!/usr/bin/env node

import fs from "node:fs";

const statePath = process.argv[2];
if (typeof statePath !== "string" || statePath.length === 0) {
  console.error("windows acceptance child requires a state path");
  process.exit(2);
}

fs.writeFileSync(statePath, `${JSON.stringify({ pid: process.pid, ppid: process.ppid })}\n`, "utf8");

// Keep the process and its standard input alive until the acceptance test
// explicitly terminates the process tree.
process.stdin.resume();
setInterval(() => undefined, 1_000);
