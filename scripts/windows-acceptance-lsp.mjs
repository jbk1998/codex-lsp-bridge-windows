#!/usr/bin/env node

import fs from "node:fs";
import { randomUUID } from "node:crypto";

const eventsPath = process.argv[2];
const allocationMb = Number(process.argv[3] ?? "48");
if (typeof eventsPath !== "string" || eventsPath.length === 0 || !Number.isFinite(allocationMb) || allocationMb <= 0) {
  console.error("windows acceptance LSP requires an events path and positive allocation size");
  process.exit(2);
}

// Touch every page so the working-set sample observes a real allocation rather
// than a lazily committed virtual address range.
const allocation = Buffer.alloc(Math.ceil(allocationMb * 1024 * 1024), 0xa5);

function appendEvent(event) {
  fs.appendFileSync(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
}

// A Windows PID can be recycled immediately after a process exits. Record a
// per-process nonce so acceptance coverage can distinguish a genuine cold
// start from a numeric PID comparison.
appendEvent({ event: "start", pid: process.pid, ppid: process.ppid, allocationMb, instanceId: randomUUID() });

let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const header = buffer.subarray(0, headerEnd).toString("utf8");
    const match = /^Content-Length:\s*(\d+)\s*$/im.exec(header);
    if (!match) {
      buffer = Buffer.alloc(0);
      return;
    }
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (buffer.length < bodyEnd) return;
    const body = buffer.subarray(bodyStart, bodyEnd).toString("utf8");
    buffer = buffer.subarray(bodyEnd);
    try {
      handleMessage(JSON.parse(body));
    } catch {
      // The fixture only needs to answer valid JSON-RPC messages from the
      // bridge. Malformed input is intentionally ignored.
    }
  }
});
process.stdin.resume();
// Keep the touched pages observably live for the lifetime of the fixture.
// Merely allocating a buffer is insufficient because V8 may prove an otherwise
// unused module binding dead and allow its backing store to be reclaimed.
setInterval(() => {
  allocation[0] ^= 1;
}, 1_000);

function handleMessage(message) {
  if (message && message.id !== undefined && message.method) {
    if (message.method === "workspace/symbol") {
      writeMessage({ jsonrpc: "2.0", id: message.id, result: [] });
      return;
    }
    writeMessage({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }

  if (message?.method === "exit") {
    appendEvent({ event: "exit", pid: process.pid });
    process.exit(0);
  }
}

function writeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(`Content-Length: ${body.byteLength}\r\n\r\n`);
  process.stdout.write(body);
}
