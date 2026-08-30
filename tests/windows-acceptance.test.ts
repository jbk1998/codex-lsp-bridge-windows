import { describe, expect, it } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { JsonRpcLspClient } from "../src/core/json-rpc-lsp-client.js";
import { LspManager } from "../src/core/lsp-manager.js";
import { createDisposalDeadline, createProcessOwnership, type OwnedChildProcess } from "../src/core/process-ownership.js";
import { WorkspaceCommandService } from "../src/core/command-service.js";
import { runStdioMcp } from "../src/transport/mcp.js";

const windows = describe.skipIf(process.platform !== "win32");
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const childFixture = path.join(packageRoot, "scripts", "windows-acceptance-child.mjs");
const lspFixture = path.join(packageRoot, "scripts", "windows-acceptance-lsp.mjs");
const workingSetFloor = 8 * 1024 * 1024;

interface ChildState {
  pid: number;
  ppid: number;
}

interface LspFixtureEvent {
  event: "start" | "exit";
  pid: number;
  ppid?: number;
  allocationMb?: number;
  instanceId?: string;
}

windows("Windows process and idle-resource acceptance", () => {
  it("fails closed for real .cmd and .bat descendants", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codex-lsp-windows-wrapper-"));
    try {
      for (const extension of [".cmd", ".bat"]) {
        const statePath = path.join(root, `wrapper${extension}.json`);
        const wrapperPath = path.join(root, `server${extension}`);
        await fsp.writeFile(wrapperPath, createWrapperScript(statePath), "utf8");

        const client = new JsonRpcLspClient({ command: wrapperPath, args: [], cwd: root });
        let state: ChildState | undefined;
        try {
          client.start();
          state = await waitForJson<ChildState>(statePath, `the ${extension} descendant to start`);
          expect(state.pid).toBeGreaterThan(0);
          expect(state.ppid).toBeGreaterThan(0);
          expect(isProcessAlive(state.pid), `${extension} descendant should be alive before teardown`).toBe(true);
          expect(isProcessAlive(state.ppid), `${extension} wrapper should be alive before teardown`).toBe(true);

          const result = await client.stop(createDisposalDeadline(Date.now(), 2_000, 100, 100));
          expect(result, `${extension} wrapper teardown result`).toMatchObject({
            clean: false,
            reasonCode: "descendant_unverified"
          });
          expect(isProcessAlive(state.pid), `${extension} descendant must survive an unverified teardown`).toBe(true);
        } finally {
          if (state) terminateProcessTree(state.ppid);
          if (state) terminateProcessTree(state.pid);
          await waitForCondition(
            () => !isProcessAlive(state?.pid ?? -1) && !isProcessAlive(state?.ppid ?? -1),
            `the ${extension} fixture process tree to exit`,
            5_000
          ).catch(() => undefined);
          await client.stop(createDisposalDeadline(Date.now(), 1_000, 50, 50)).catch(() => undefined);
        }
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("uses native process identity for a real direct child", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codex-lsp-windows-identity-"));
    const statePath = path.join(root, "child.json");
    const child = spawn(process.execPath, [childFixture, statePath], {
      cwd: root,
      stdio: ["ignore", "ignore", "ignore"]
    });
    let state: ChildState | undefined;
    try {
      state = await waitForJson<ChildState>(statePath, "the direct child to start");
      const ownership = createProcessOwnership(child as unknown as OwnedChildProcess);
      const result = await ownership.terminate(Date.now() + 10_000);

      expect(result).toEqual({ clean: true, reasonCode: "owned_child_exit" });
      await waitForChildExit(child, 3_000);
      expect(isProcessAlive(state.pid)).toBe(false);
    } finally {
      if (state) terminateProcessTree(state.pid);
      await waitForChildExit(child, 2_000).catch(() => undefined);
      await fsp.rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("reduces idle working set and cold-starts a provider on the next request", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codex-lsp-windows-idle-"));
    const eventsPath = path.join(root, "lsp-events.jsonl");
    await fsp.mkdir(path.join(root, "src"), { recursive: true });
    await fsp.writeFile(path.join(root, "src", "index.ts"), "export const fixture = 1;\n", "utf8");
    await fsp.writeFile(eventsPath, "", "utf8");

    const manager = new LspManager(root, {
      languageServers: {
        typescript: {
          command: lspFixture,
          args: [eventsPath, "48"]
        }
      }
    });
    const service = new WorkspaceCommandService(manager, "typescript");
    const input = new PassThrough();
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    const responses: Array<Record<string, unknown>> = [];
    let outputBuffer = "";
    output.on("data", (chunk: Buffer) => {
      outputBuffer += chunk.toString("utf8");
      while (true) {
        const newline = outputBuffer.indexOf("\n");
        if (newline < 0) return;
        const line = outputBuffer.slice(0, newline).trim();
        outputBuffer = outputBuffer.slice(newline + 1);
        if (!line) continue;
        responses.push(JSON.parse(line) as Record<string, unknown>);
      }
    });

    const runPromise = runStdioMcp(service, {
      input,
      output,
      errorOutput,
      idleTimeoutMs: 8_000,
      suspend: (deadline) => manager.suspend(deadline),
      dispose: (deadline) => manager.dispose(deadline)
    });
    const startedPids: number[] = [];
    let inputClosed = false;

    try {
      writeSymbolsRequest(input, 1);
      await waitFor(() => responses.find((response) => response.id === 1), "the first MCP response", 8_000);
      const first = await waitForEvent(
        eventsPath,
        (event, starts) => event.event === "start" && starts.length === 1,
        "the first LSP process",
        8_000
      );
      startedPids.push(first.pid);
      expect(first.instanceId).toBeDefined();
      const firstWorkingSet = await waitFor(
        () => {
          const workingSet = readWorkingSet(first.pid);
          return workingSet >= workingSetFloor ? workingSet : undefined;
        },
        "the first LSP working set",
        5_000
      );

      await waitForCondition(() => !isProcessAlive(first.pid), "idle suspension to stop the first LSP process", 15_000);
      const afterSuspensionWorkingSet = readWorkingSet(first.pid);
      expect(afterSuspensionWorkingSet).toBe(0);
      expect(firstWorkingSet - afterSuspensionWorkingSet).toBeGreaterThanOrEqual(workingSetFloor);

      writeSymbolsRequest(input, 2);
      await waitFor(() => responses.find((response) => response.id === 2), "the second MCP response", 8_000);
      const second = await waitForEvent(
        eventsPath,
        (event, starts) => event.event === "start" && starts.length === 2 && event.instanceId !== first.instanceId,
        "the cold-started LSP process",
        8_000
      );
      startedPids.push(second.pid);
      expect(second.instanceId).toBeDefined();
      expect(second.instanceId).not.toBe(first.instanceId);
      expect(
        await waitFor(
          () => {
            const workingSet = readWorkingSet(second.pid);
            return workingSet >= workingSetFloor ? workingSet : undefined;
          },
          "the second LSP working set",
          5_000
        )
      ).toBeGreaterThanOrEqual(workingSetFloor);

      inputClosed = true;
      input.end();
      await expect(runPromise).resolves.toMatchObject({ state: "clean", clean: true });
    } finally {
      if (!inputClosed) input.end();
      await Promise.race([runPromise.catch(() => undefined), delay(8_000)]);
      for (const pid of startedPids) terminateProcessTree(pid);
      input.destroy();
      output.destroy();
      errorOutput.destroy();
      await fsp.rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});

function createWrapperScript(statePath: string): string {
  return [
    "@echo off",
    "setlocal",
    `${quoteBatchArgument(process.execPath)} ${quoteBatchArgument(childFixture)} ${quoteBatchArgument(statePath)}`,
    ""
  ].join("\r\n");
}

function quoteBatchArgument(value: string): string {
  if (/[&|<>^%]/.test(value)) throw new Error(`unsafe fixture path: ${value}`);
  return `"${value.replaceAll('"', '""')}"`;
}

function writeSymbolsRequest(input: PassThrough, id: number): void {
  input.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "lsp_symbols", arguments: { query: "fixture" } }
    })}\n`
  );
}

async function waitForJson<T>(filePath: string, description: string): Promise<T> {
  return waitFor(
    async () => {
      try {
        const contents = await fsp.readFile(filePath, "utf8");
        return JSON.parse(contents) as T;
      } catch {
        return undefined;
      }
    },
    description,
    8_000
  );
}

async function waitForEvent(
  filePath: string,
  match: (event: LspFixtureEvent, starts: LspFixtureEvent[]) => boolean,
  description: string,
  timeoutMs: number
): Promise<LspFixtureEvent> {
  return waitFor(
    async () => {
      const events = await readEvents(filePath);
      const starts = events.filter((event) => event.event === "start");
      return events.find((event) => match(event, starts));
    },
    description,
    timeoutMs
  );
}

async function readEvents(filePath: string): Promise<LspFixtureEvent[]> {
  try {
    return (await fsp.readFile(filePath, "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LspFixtureEvent);
  } catch {
    return [];
  }
}

async function waitFor<T>(probe: () => T | undefined | Promise<T | undefined>, description: string, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function waitForCondition(probe: () => boolean, description: string, timeoutMs: number): Promise<void> {
  await waitFor(() => (probe() ? true : undefined), description, timeoutMs);
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    delay(timeoutMs).then(() => {
      throw new Error("Timed out waiting for child exit");
    })
  ]);
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function terminateProcessTree(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return;
  try {
    execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 5_000
    });
  } catch {
    // The target may have exited between the liveness check and taskkill.
  }
}

function readWorkingSet(pid: number): number {
  try {
    const output = execFileSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$p = Get-Process -Id ${String(pid)} -ErrorAction Stop; [Console]::Out.Write(([int64]$p.WorkingSet64).ToString([Globalization.CultureInfo]::InvariantCulture))`
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2_000, windowsHide: true }
    ).trim();
    const value = Number(output);
    if (Number.isSafeInteger(value) && value > 0) return value;
  } catch {
    // Fall through to tasklist if PowerShell is unavailable.
  }

  // Get-Process may be unavailable while the hosted runner is initializing
  // PowerShell. tasklist is a native Windows fallback and reports the same
  // process working set in KiB; use it only for this acceptance probe.
  try {
    const output = execFileSync("tasklist.exe", ["/FI", `PID eq ${String(pid)}`, "/FO", "CSV", "/NH"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
      windowsHide: true
    });
    const row = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !/^INFO:/i.test(line));
    if (!row) return 0;
    const fields = [...row.matchAll(/"([^"]*)"/g)].map((match) => match[1]);
    if (Number(fields[1]) !== pid) return 0;
    const memory = fields[4]?.replaceAll(",", "").match(/^(\d+)\s*K$/i);
    const value = memory ? Number(memory[1]) * 1024 : 0;
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}
