import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

export const diagnosticsIpcProtocolVersion = 1;

export interface DiagnosticsIpcMetadata {
  protocolVersion: number;
  root: string;
  rootHash: string;
  endpoint: string;
  secret: string;
  pid: number;
}

export function createDiagnosticsIpcMetadata(root: string): DiagnosticsIpcMetadata {
  const rootHash = hashRoot(root);
  return {
    protocolVersion: diagnosticsIpcProtocolVersion,
    root,
    rootHash,
    endpoint: endpointForRootHash(rootHash),
    secret: crypto.randomBytes(32).toString("hex"),
    pid: process.pid
  };
}

export function diagnosticsIpcMetadataPath(root: string): string {
  return path.join(os.tmpdir(), `codex-lsp-bridge-ipc-${hashRoot(root)}.json`);
}

export function hashRoot(root: string): string {
  return crypto.createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 32);
}

function endpointForRootHash(rootHash: string): string {
  if (process.platform === "win32") return `\\\\.\\pipe\\codex-lsp-bridge-${rootHash}`;
  return path.join(os.tmpdir(), `codex-lsp-bridge-${rootHash}.sock`);
}
