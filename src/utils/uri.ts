import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function filePathToUri(filePath: string): string {
  return pathToFileURL(canonicalizeFilePath(path.resolve(filePath))).toString();
}

export function uriToFilePath(uri: string): string {
  if (!uri.startsWith("file://")) {
    throw new Error(`Only file:// URIs are supported: ${uri}`);
  }

  return canonicalizeFilePath(fileURLToPath(canonicalizeFileUri(uri)));
}

export function canonicalizeFileUri(uri: string): string {
  if (!uri.startsWith("file://")) {
    throw new Error(`Only file:// URIs are supported: ${uri}`);
  }

  return uri.replace(/^file:\/\/\/([a-z])(?:%3A|:)/i, (_match, drive: string) => `file:///${drive.toUpperCase()}:`);
}

function canonicalizeFilePath(filePath: string): string {
  if (/^[a-z]:/.test(filePath)) return `${filePath[0].toUpperCase()}${filePath.slice(1)}`;
  return filePath;
}
