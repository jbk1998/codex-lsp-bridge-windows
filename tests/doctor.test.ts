import { describe, expect, it } from "vitest";
import { runDoctor } from "../src/core/doctor.js";

describe("doctor", () => {
  it("reports every registered language server command", () => {
    const result = runDoctor(process.cwd());

    expect(result.languages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ language: "typescript", command: "typescript-language-server" }),
        expect.objectContaining({ language: "rust", command: "rust-analyzer" }),
        expect.objectContaining({ language: "python", command: "pyright-langserver" }),
        expect.objectContaining({ language: "go", command: "gopls" })
      ])
    );
    expect(result.languages.every((entry) => entry.status === "ok" || entry.status === "missing")).toBe(true);
  });
});
