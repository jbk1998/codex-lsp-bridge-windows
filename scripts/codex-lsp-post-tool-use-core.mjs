import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export const supportedSourceFilePattern = /\.(ts|tsx|js|jsx|rs|py|go)$/;

export const languageServersByExtension = {
  ".ts": "typescript-language-server",
  ".tsx": "typescript-language-server",
  ".js": "typescript-language-server",
  ".jsx": "typescript-language-server",
  ".rs": "rust-analyzer",
  ".py": "pyright-langserver",
  ".go": "gopls"
};

export const languagesByExtension = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "typescript",
  ".jsx": "typescript",
  ".rs": "rust",
  ".py": "python",
  ".go": "go"
};

const diagnosticsIpcProtocolVersion = 1;
const defaultIpcTimeoutMs = 200;

export async function runPostToolUseDiagnostics({
  input,
  cwd = process.cwd(),
  env = process.env,
  bridgeCli,
  fsImpl = fs,
  spawnSyncImpl = spawnSync,
  processExecPath = process.execPath,
  sendIpcRequestImpl = sendIpcRequest
}) {
  const repoRoot = findWorkspaceRoot(cwd, env, fsImpl);
  const maxFiles = Number(env.CODEX_LSP_HOOK_MAX_FILES ?? 5);
  const verbosePending = isEnabled(env.CODEX_LSP_HOOK_VERBOSE_PENDING);
  const event = parseJson(input);
  const files = resolveTouchedFiles(event, {
    repoRoot,
    maxFiles,
    fsImpl
  });

  if (files.length === 0) {
    return { exitCode: 0, stdout: "" };
  }

  const ipcResult = await tryIpcDiagnostics(files, {
    repoRoot,
    env,
    fsImpl,
    sendIpcRequestImpl
  });
  if (ipcResult?.kind === "success") {
    return formatDiagnosticsOutput([ipcResult.diagnostics], files, repoRoot, verbosePending, fsImpl);
  }
  if (ipcResult?.kind === "security") {
    return {
      exitCode: 1,
      stdout: `[codex-lsp-bridge] IPC diagnostics rejected: ${ipcResult.message}\n`
    };
  }

  const diagnostics = [];
  const skippedServers = new Map();
  for (const [language, languageFiles] of groupFilesByLanguage(files)) {
    const serverCommand = languageServersByExtension[path.extname(languageFiles[0])];
    if (serverCommand && !commandExists(serverCommand, repoRoot, env, fsImpl)) {
      skippedServers.set(serverCommand, (skippedServers.get(serverCommand) ?? 0) + languageFiles.length);
      continue;
    }

    const result = spawnSyncImpl(processExecPath, [
      bridgeCli,
      "diagnostics",
      ...languageFiles.flatMap((file) => ["--file", file]),
      "--language",
      language,
      "--root",
      repoRoot
    ], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 1024 * 1024
    });

    if (result.status !== 0) {
      diagnostics.push({
        files: languageFiles,
        error: result.stderr.trim() || result.stdout.trim() || `codex-lsp-bridge exited with status ${result.status}`
      });
      continue;
    }

    diagnostics.push(JSON.parse(result.stdout));
  }

  return formatDiagnosticsOutput(diagnostics, files, repoRoot, verbosePending, fsImpl, skippedServers);
}

export function diagnosticsIpcMetadataPath(root) {
  return path.join(os.tmpdir(), `codex-lsp-bridge-ipc-${hashRoot(root)}.json`);
}

export function hashRoot(root) {
  return crypto.createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 32);
}

function formatDiagnosticsOutput(diagnostics, files, repoRoot, verbosePending, fsImpl, skippedServers = new Map()) {
  if (diagnostics.length === 0) {
    if (verbosePending && skippedServers.size > 0) {
      const skipped = [...skippedServers.entries()]
        .map(([command, count]) => `${count} file(s) need ${command}`)
        .join(", ");
      return { exitCode: 0, stdout: `[codex-lsp-bridge] skipped diagnostics; missing language server(s): ${skipped}.\n` };
    }
    return { exitCode: 0, stdout: "" };
  }

  const total = diagnostics.reduce((sum, item) => sum + (typeof item.total === "number" ? item.total : 0), 0);
  const errorTotal = diagnostics.reduce((sum, item) => sum + (item.bySeverity?.error ?? 0), 0);
  const timedOut = diagnostics.filter((item) => item.timedOut || item.status === "timed_out");

  if (timedOut.length > 0 && total === 0 && diagnostics.every((item) => !item.error)) {
    if (verbosePending) {
      return {
        exitCode: 0,
        stdout: `[codex-lsp-bridge] LSP diagnostics inconclusive for ${timedOut.length} touched supported source file(s); not type-check passed.\n`
      };
    }
    return { exitCode: 0, stdout: "" };
  }

  if (total === 0 && diagnostics.every((item) => !item.error)) {
    return {
      exitCode: 0,
      stdout: `[codex-lsp-bridge] LSP diagnostics clean for ${files.length} touched supported source file(s); not a full project type-check.\n`
    };
  }

  if (errorTotal === 0 && diagnostics.every((item) => !item.error)) {
    return {
      exitCode: 0,
      stdout: `[codex-lsp-bridge] diagnostics: ${total} non-error issue(s) across ${files.length} touched supported source file(s).\n`
    };
  }

  if (isDuplicate(diagnostics, repoRoot, fsImpl)) {
    return { exitCode: 0, stdout: "" };
  }

  return {
    exitCode: 0,
    stdout: `[codex-lsp-bridge] diagnostics after tool use:\n${JSON.stringify(diagnostics, null, 2)}\n`
  };
}

async function tryIpcDiagnostics(files, { repoRoot, env, fsImpl, sendIpcRequestImpl }) {
  if (isEnabled(env.CODEX_LSP_HOOK_DISABLE_IPC)) return undefined;
  const metadataPath = diagnosticsIpcMetadataPath(repoRoot);
  if (!fsImpl.existsSync(metadataPath)) return undefined;

  try {
    const metadata = JSON.parse(fsImpl.readFileSync(metadataPath, "utf8"));
    if (!metadata || typeof metadata !== "object") return undefined;
    if (metadata.protocolVersion !== diagnosticsIpcProtocolVersion) return undefined;
    if (metadata.rootHash !== hashRoot(repoRoot)) {
      return { kind: "security", message: "root hash mismatch" };
    }
    if (typeof metadata.endpoint !== "string" || typeof metadata.secret !== "string") return undefined;
    const timeoutMs = readPositiveInteger(env.CODEX_LSP_HOOK_IPC_TIMEOUT_MS, defaultIpcTimeoutMs);
    const response = await sendIpcRequestImpl(metadata.endpoint, {
      protocolVersion: diagnosticsIpcProtocolVersion,
      rootHash: metadata.rootHash,
      secret: metadata.secret,
      root: repoRoot,
      files
    }, timeoutMs);
    if (!response || typeof response !== "object") return undefined;
    if (response.ok === true) return { kind: "success", diagnostics: response.result };
    if (response.error?.kind === "security") return { kind: "security", message: response.error.message };
    return undefined;
  } catch {
    return undefined;
  }
}

function sendIpcRequest(endpoint, request, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.createConnection(endpoint);
    let buffer = "";
    let done = false;

    const finish = (value) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(value);
    };

    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs, () => finish(undefined));
    socket.on("error", () => finish(undefined));
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) return;
      try {
        finish(JSON.parse(buffer.slice(0, newlineIndex)));
      } catch {
        finish(undefined);
      }
    });
  });
}

export function findWorkspaceRoot(cwd, env = process.env, fsImpl = fs) {
  if (env.CODEX_LSP_HOOK_ROOT) return path.resolve(env.CODEX_LSP_HOOK_ROOT);

  const start = path.resolve(cwd);
  const gitRoot = findUpward(start, (directory) => fsImpl.existsSync(path.join(directory, ".git")));
  if (gitRoot) return gitRoot;

  const packageRoot = findUpward(start, (directory) =>
    ["package.json", "tsconfig.json", "Cargo.toml"].some((marker) => fsImpl.existsSync(path.join(directory, marker)))
  );
  return packageRoot ?? start;
}

export function resolveTouchedFiles(event, { repoRoot, maxFiles, fsImpl = fs }) {
  return [...collectTouchedFiles(event)]
    .map((file) => resolveInsideRoot(repoRoot, file))
    .filter((file) => file !== undefined)
    .filter((file) => supportedSourceFilePattern.test(file))
    .filter((file) => fsImpl.existsSync(file))
    .slice(0, maxFiles);
}

export function collectTouchedFiles(value, files = new Set()) {
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

export function groupFilesByLanguage(files) {
  const groups = new Map();
  for (const file of files) {
    const language = languagesByExtension[path.extname(file)];
    if (!language) continue;
    const groupedFiles = groups.get(language) ?? [];
    groupedFiles.push(file);
    groups.set(language, groupedFiles);
  }
  return groups;
}

export function parseJson(value) {
  if (value.trim().length === 0) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

export function isEnabled(value) {
  return value === "1" || value === "true" || value === "yes";
}

function findUpward(start, predicate) {
  let current = start;
  while (true) {
    if (predicate(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function resolveInsideRoot(root, file) {
  const resolvedRoot = path.resolve(root);
  const filePath = path.isAbsolute(file) ? path.resolve(file) : path.resolve(resolvedRoot, file);
  const relative = path.relative(resolvedRoot, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return filePath;
}

function isPathKey(key) {
  return /^(file|file_path|filepath|path|target_file|target_path|absolute_path|relative_path)$/i.test(key);
}

function addPathIfCandidate(value, files) {
  if (!supportedSourceFilePattern.test(value)) return;
  if (value.includes("\n")) return;
  files.add(value);
}

function isDuplicate(value, repoRoot, fsImpl) {
  const hash = crypto.createHash("sha256").update(repoRoot).update(JSON.stringify(value)).digest("hex");
  const filePath = path.join(os.tmpdir(), `codex-lsp-bridge-hook-${hash}.stamp`);
  if (fsImpl.existsSync(filePath)) return true;
  fsImpl.writeFileSync(filePath, String(Date.now()));
  return false;
}

function readPositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function commandExists(command, repoRoot, env, fsImpl) {
  const localCommand = path.join(repoRoot, "node_modules", ".bin", command);
  if (isExecutable(localCommand, fsImpl)) return true;
  if (process.platform === "win32" && isExecutable(`${localCommand}.cmd`, fsImpl)) return true;

  const pathEntries = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  for (const directory of pathEntries) {
    for (const extension of extensions) {
      if (isExecutable(path.join(directory, `${command}${extension}`), fsImpl)) return true;
    }
  }
  return false;
}

function isExecutable(filePath, fsImpl) {
  try {
    fsImpl.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
