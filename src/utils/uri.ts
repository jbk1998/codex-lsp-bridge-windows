import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function filePathToUri(filePath: string): string {
  return pathToFileURL(path.resolve(filePath)).toString();
}

export function uriToFilePath(uri: string): string {
  if (!uri.startsWith("file://")) {
    throw new Error(`Only file:// URIs are supported: ${uri}`);
  }

  return fileURLToPath(uri);
}
