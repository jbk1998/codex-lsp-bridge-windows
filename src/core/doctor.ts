import fs from "node:fs";
import path from "node:path";
import { listLanguageServerConfigs } from "../adapters/language-config.js";

export interface DoctorResult {
  languages: Array<{
    language: string;
    command: string;
    status: "ok" | "missing";
    path?: string;
  }>;
}

export function runDoctor(rootPath: string): DoctorResult {
  return {
    languages: listLanguageServerConfigs(rootPath).map((config) => {
      const executablePath = findExecutable(config.server.command);
      return {
        language: config.language,
        command: config.server.command,
        status: executablePath ? "ok" : "missing",
        ...(executablePath ? { path: executablePath } : {})
      };
    })
  };
}

function findExecutable(command: string): string | undefined {
  if (command.includes(path.sep)) {
    return isExecutable(command) ? command : undefined;
  }

  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];

  for (const directory of pathEntries) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      if (isExecutable(candidate)) return candidate;
    }
  }

  return undefined;
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
