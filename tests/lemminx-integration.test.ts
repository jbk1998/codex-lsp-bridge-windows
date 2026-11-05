import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { JsonRpcLspClient } from "../src/core/json-rpc-lsp-client.js";
import { loadConfig } from "../src/core/config.js";
import { LspManager } from "../src/core/lsp-manager.js";
import { WorkspaceCommandService } from "../src/core/command-service.js";
import { filePathToUri } from "../src/utils/uri.js";

const configuredLemMinXPath = process.env.CODEX_LSP_LEMMINX_PATH;
const hasConfiguredLemMinX =
  configuredLemMinXPath !== undefined && path.isAbsolute(configuredLemMinXPath) && fsSync.existsSync(configuredLemMinXPath);
const requireLemMinX = process.env.CODEX_LSP_REQUIRE_LEMMINX_INTEGRATION === "1";
const originalCodexHome = process.env.CODEX_HOME;

if (requireLemMinX && !hasConfiguredLemMinX) {
  throw new Error("Set CODEX_LSP_LEMMINX_PATH to the absolute path of the trusted LemMinX executable");
}

afterAll(() => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
});

describe.skipIf(!hasConfiguredLemMinX)("LemMinX OOXML pilot integration", () => {
  it("diagnoses synthetic unpacked OOXML parts with safe settings sent before didOpen and shuts down cleanly", async () => {
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-lsp-lemminx-ooxml-"));
    const fixtureRoot = path.join(temporaryDirectory, "ooxml");
    const isolatedCodexHome = path.join(temporaryDirectory, "codex-home");
    const fixtureSource = new URL("./fixtures/lemminx-ooxml/", import.meta.url);
    await fs.cp(fixtureSource, fixtureRoot, { recursive: true });
    await fs.mkdir(isolatedCodexHome, { recursive: true });
    process.env.CODEX_HOME = isolatedCodexHome;

    const workbookPath = path.join(fixtureRoot, "xl", "workbook.xml");
    const relationshipsPath = path.join(fixtureRoot, "xl", "_rels", "workbook.xml.rels");
    const workspaceConfig = loadConfig(fixtureRoot);
    const observedWireOrder: string[] = [];
    let initializeOptions: unknown;
    let initializeCapabilities: unknown;
    const originalRequest = JsonRpcLspClient.prototype.request;
    const originalNotify = JsonRpcLspClient.prototype.notify;
    JsonRpcLspClient.prototype.request = function <T>(method: string, params?: unknown): Promise<T> {
      if (method === "initialize") {
        observedWireOrder.push("initialize");
        initializeOptions = (params as { initializationOptions?: unknown }).initializationOptions;
        initializeCapabilities = (params as { capabilities?: unknown }).capabilities;
      }
      return originalRequest.call(this, method, params) as Promise<T>;
    };
    JsonRpcLspClient.prototype.notify = function (method: string, params?: unknown): void {
      if (method === "initialized" || method === "textDocument/didOpen" || method === "textDocument/didChange") {
        observedWireOrder.push(method);
      }
      if (method === "textDocument/didOpen") {
        // Enforce the security settings before the first document can reach the server.
        expect(initializeOptions).toMatchObject({
          settings: {
            xml: {
              downloadExternalResources: { enabled: false },
              validation: { resolveExternalEntities: false }
            }
          }
        });
        expect(observedWireOrder.indexOf("initialize")).toBeGreaterThanOrEqual(0);
        expect(observedWireOrder.indexOf("initialize")).toBeLessThan(observedWireOrder.indexOf("textDocument/didOpen"));
      }
      return originalNotify.call(this, method, params);
    };

    const manager = new LspManager(fixtureRoot, {
      diagnosticsTimeoutMs: 30000,
      languageServers: { xml: { command: configuredLemMinXPath!, args: [] } },
      xmlSettings: workspaceConfig.xml
    });
    const service = new WorkspaceCommandService(manager, "typescript");

    let shutdownResult: Awaited<ReturnType<typeof manager.dispose>>;
    try {
      expect(workspaceConfig.xml.fileAssociations).toEqual([
        { pattern: "**/*.rels", systemId: path.join(fixtureRoot, "schemas", "relationships-pilot.xsd") }
      ]);

      const malformedWorkbook = await service.diagnostics(filePathToUri(workbookPath));
      expect(malformedWorkbook).toMatchObject({ status: "ok", stale: false, timedOut: false });
      expect(malformedWorkbook.items.some((item) => item.severity === "error")).toBe(true);
      expect(initializeOptions).toMatchObject({
        settings: {
          xml: {
            downloadExternalResources: { enabled: false },
            validation: { resolveExternalEntities: false },
            fileAssociations: [{ pattern: "**/*.rels", systemId: path.join(fixtureRoot, "schemas", "relationships-pilot.xsd") }]
          }
        }
      });
      expect(initializeCapabilities).toMatchObject({ workspace: { configuration: true } });

      const invalidRelationships = await service.diagnostics(filePathToUri(relationshipsPath));
      expect(invalidRelationships).toMatchObject({ status: "ok", stale: false, timedOut: false });
      expect(invalidRelationships.items).toEqual(
        expect.arrayContaining([expect.objectContaining({ severity: "error", message: expect.stringMatching(/\bType\b/) })])
      );

      await fs.writeFile(
        relationshipsPath,
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n' +
          '  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" ' +
          'Target="worksheets/sheet1.xml" />\n' +
          "</Relationships>\n",
        "utf8"
      );
      const correctedRelationships = await service.diagnostics(filePathToUri(relationshipsPath));
      expect(correctedRelationships).toMatchObject({ status: "ok", stale: false, timedOut: false, items: [] });

      expect(initializeOptions).toMatchObject({
        settings: {
          xml: {
            downloadExternalResources: { enabled: false },
            validation: { resolveExternalEntities: false },
            fileAssociations: [{ pattern: "**/*.rels", systemId: path.join(fixtureRoot, "schemas", "relationships-pilot.xsd") }]
          }
        }
      });
      expect(observedWireOrder.indexOf("initialize")).toBeGreaterThanOrEqual(0);
      expect(observedWireOrder.indexOf("initialize")).toBeLessThan(observedWireOrder.indexOf("textDocument/didOpen"));
    } finally {
      JsonRpcLspClient.prototype.request = originalRequest;
      JsonRpcLspClient.prototype.notify = originalNotify;
      shutdownResult = await manager.dispose();
      await fs.rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }

    expect(shutdownResult).toMatchObject({ clean: true });
  }, 60000);
});
