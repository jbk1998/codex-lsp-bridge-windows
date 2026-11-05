import { lstatSync, realpathSync, watch } from "node:fs";
import path from "node:path";
import { filePathToUri } from "../utils/uri.js";
import { isPathInsideWorkspaceRootSync } from "./workspace-root.js";

interface FileChange {
  uri: string;
  type: 1 | 2 | 3;
}

const batchDelayMs = 50;
const maxBatchSize = 128;

export function watchPythonWorkspace(
  root: string,
  assertRootCurrent: () => void,
  publish: (changes: FileChange[]) => void,
  reportError: (error: unknown) => void
): () => void {
  const pending = new Map<string, boolean>();
  let timer: NodeJS.Timeout | undefined;

  function flush(): void {
    clearTimeout(timer);
    timer = undefined;
    try {
      assertRootCurrent();
      const changes = [...pending].flatMap(([file, renamed]) => {
        const change = getPythonFileChange(root, file, renamed);
        return change ? [change] : [];
      });
      if (changes.length) publish(changes);
    } catch (error) {
      reportError(error);
    } finally {
      pending.clear();
    }
  }

  const watcher = watch(root, { recursive: true, persistent: false }, (event, filename) => {
    if (!filename) {
      reportError(new Error("The filesystem did not identify a changed path"));
      return;
    }
    if (!/\.(py|pyi)$/i.test(filename)) return;
    const file = path.resolve(root, filename);
    const relative = path.relative(root, file);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return;
    pending.set(file, event === "rename" || pending.get(file) === true);
    if (pending.size >= maxBatchSize) flush();
    else timer ??= setTimeout(flush, batchDelayMs);
  });
  watcher.on("error", (error) => {
    close();
    reportError(error);
  });
  function close(): void {
    watcher.close();
    clearTimeout(timer);
    pending.clear();
  }
  return close;
}

function getPythonFileChange(root: string, file: string, renamed: boolean): FileChange | undefined {
  try {
    const parent = realpathSync(path.dirname(file));
    if (!isPathInsideWorkspaceRootSync(parent, root)) return undefined;
    const target = path.join(parent, path.basename(file));
    try {
      if (!lstatSync(target).isFile()) return undefined;
      return { uri: filePathToUri(target), type: renamed ? 1 : 2 };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { uri: filePathToUri(target), type: 3 };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
}
