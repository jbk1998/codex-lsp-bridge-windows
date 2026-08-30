import fs from "node:fs";
import path from "node:path";

export type NativeNodeRuntimeErrorCode =
  | "runtime_missing"
  | "runtime_relative"
  | "runtime_shim"
  | "runtime_code_mode"
  | "runtime_unsafe_path"
  | "runtime_not_file"
  | "runtime_not_executable"
  | "runtime_identity_changed"
  | "invalid_launch_record"
  | "unsafe_launch_argument";

export interface NativeNodeFileIdentity {
  realpath: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  mode: number;
  dev?: number;
  ino?: number;
}

export interface NativeNodeRuntimeValidation {
  executablePath: string;
  identity: NativeNodeFileIdentity;
}

export interface NativeNodeLaunchRecord {
  version: 1;
  runtime: "native-node";
  command: string;
  args: string[];
}

export interface ValidatedNativeNodeLaunchRecord extends NativeNodeLaunchRecord {
  identity: NativeNodeFileIdentity;
}

export class NativeNodeRuntimeError extends Error {
  readonly code: NativeNodeRuntimeErrorCode;

  constructor(code: NativeNodeRuntimeErrorCode, reason: string) {
    super(`native runtime rejected: ${reason}`);
    this.name = "NativeNodeRuntimeError";
    this.code = code;
  }
}

/**
 * Validate the lexical shape of a native Node executable without touching the filesystem.
 * This is intentionally separate from validateNativeNodeRuntime so generated records can be
 * rejected before any path is opened.
 */
export function validateNativeNodePath(runtimePath: string, platform: NodeJS.Platform = process.platform): string {
  if (typeof runtimePath !== "string" || runtimePath.length === 0) {
    throw new NativeNodeRuntimeError("runtime_missing", "missing");
  }
  if ([...runtimePath].some((character) => character.charCodeAt(0) < 0x20 || character === "\u007f")) {
    throw new NativeNodeRuntimeError("runtime_unsafe_path", "unsafe path");
  }

  const pathApi = platform === "win32" ? path.win32 : path.posix;
  if (!pathApi.isAbsolute(runtimePath)) {
    throw new NativeNodeRuntimeError("runtime_relative", "relative");
  }

  const normalized = pathApi.normalize(runtimePath);
  if (platform === "win32") {
    const lower = normalized.toLowerCase();
    if (lower.startsWith("\\\\") || lower.startsWith("//") || lower.startsWith("\\\\?\\") || lower.startsWith("\\\\.\\")) {
      throw new NativeNodeRuntimeError("runtime_unsafe_path", "unsafe path");
    }
  }

  const baseName = pathApi.basename(normalized).toLowerCase();
  if (baseName === "node_repl.exe" || baseName === "node_repl" || baseName.includes("node_repl")) {
    throw new NativeNodeRuntimeError("runtime_code_mode", "code-mode runtime");
  }
  if (baseName.endsWith(".cmd") || baseName.endsWith(".bat") || baseName.endsWith(".com")) {
    throw new NativeNodeRuntimeError("runtime_shim", "shim");
  }
  if (platform === "win32" && baseName !== "node.exe") {
    throw new NativeNodeRuntimeError("runtime_unsafe_path", "native node executable");
  }
  if (platform !== "win32" && baseName !== "node" && baseName !== "nodejs") {
    throw new NativeNodeRuntimeError("runtime_unsafe_path", "native node executable");
  }

  return platform === "win32" ? path.win32.resolve(normalized) : path.resolve(normalized);
}

export function validateNativeNodeRuntime(runtimePath = process.execPath): NativeNodeRuntimeValidation {
  const executablePath = validateNativeNodePath(runtimePath);
  let realpath: string;
  let stats: fs.Stats;
  try {
    realpath = fs.realpathSync(executablePath);
    stats = fs.statSync(realpath);
  } catch {
    throw new NativeNodeRuntimeError("runtime_missing", "missing");
  }
  if (!stats.isFile()) {
    throw new NativeNodeRuntimeError("runtime_not_file", "not a file");
  }
  try {
    fs.accessSync(realpath, fs.constants.X_OK);
  } catch {
    throw new NativeNodeRuntimeError("runtime_not_executable", "not executable");
  }
  if (process.platform === "win32" && !looksLikePortableExecutable(realpath)) {
    throw new NativeNodeRuntimeError("runtime_not_executable", "not executable");
  }

  return {
    executablePath,
    identity: readIdentity(realpath, stats)
  };
}

function looksLikePortableExecutable(filePath: string): boolean {
  let handle: number | undefined;
  try {
    handle = fs.openSync(filePath, "r");
    const dosHeader = Buffer.alloc(64);
    if (fs.readSync(handle, dosHeader, 0, dosHeader.length, 0) < dosHeader.length || dosHeader[0] !== 0x4d || dosHeader[1] !== 0x5a) {
      return false;
    }
    const peOffset = dosHeader.readUInt32LE(0x3c);
    if (peOffset < 64 || peOffset > 1024 * 1024) return false;
    const signature = Buffer.alloc(4);
    return (
      fs.readSync(handle, signature, 0, signature.length, peOffset) === signature.length && signature.toString("ascii") === "PE\u0000\u0000"
    );
  } catch {
    return false;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

export function createNativeNodeLaunchRecord(
  bridgeCli: string,
  bridgeArgs: string[] = ["mcp"],
  runtimePath = process.execPath
): NativeNodeLaunchRecord {
  const validation = validateNativeNodeRuntime(runtimePath);
  const record: NativeNodeLaunchRecord = {
    version: 1,
    runtime: "native-node",
    command: validation.executablePath,
    args: [bridgeCli, ...bridgeArgs]
  };
  validateNativeNodeLaunchRecord(record);
  return record;
}

export function validateNativeNodeLaunchRecord(record: unknown): ValidatedNativeNodeLaunchRecord {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new NativeNodeRuntimeError("invalid_launch_record", "invalid launch record");
  }
  const candidate = record as Partial<NativeNodeLaunchRecord>;
  if (
    candidate.version !== 1 ||
    candidate.runtime !== "native-node" ||
    typeof candidate.command !== "string" ||
    !Array.isArray(candidate.args)
  ) {
    throw new NativeNodeRuntimeError("invalid_launch_record", "invalid launch record");
  }
  for (const argument of candidate.args) {
    if (typeof argument !== "string" || [...argument].some((character) => character.charCodeAt(0) < 0x20 || character === "\u007f")) {
      throw new NativeNodeRuntimeError("unsafe_launch_argument", "unsafe launch argument");
    }
  }

  const validation = validateNativeNodeRuntime(candidate.command);
  return {
    version: 1,
    runtime: "native-node",
    command: validation.executablePath,
    args: [...candidate.args],
    identity: validation.identity
  };
}

export function revalidateNativeNodeRuntime(validation: NativeNodeRuntimeValidation): NativeNodeRuntimeValidation {
  const current = validateNativeNodeRuntime(validation.executablePath);
  if (!sameIdentity(validation.identity, current.identity)) {
    throw new NativeNodeRuntimeError("runtime_identity_changed", "identity changed");
  }
  return current;
}

function readIdentity(realpath: string, stats: fs.Stats): NativeNodeFileIdentity {
  return {
    realpath,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
    mode: stats.mode,
    ...(typeof stats.dev === "number" ? { dev: stats.dev } : {}),
    ...(typeof stats.ino === "number" ? { ino: stats.ino } : {})
  };
}

function sameIdentity(left: NativeNodeFileIdentity, right: NativeNodeFileIdentity): boolean {
  if (left.realpath !== right.realpath) return false;
  if (left.dev !== undefined && right.dev !== undefined && left.ino !== undefined && right.ino !== undefined) {
    if (left.dev !== right.dev || left.ino !== right.ino) return false;
  }
  return left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && left.mode === right.mode;
}
