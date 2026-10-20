import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BIG_SCREEN_BUILTIN_TEMPLATE_IDS, BIG_SCREEN_RESERVED_TEMPLATE_IDS } from "@datafoundry/bigscreen";
import { callApi, type ApiFetchResult } from "./api-server-client";
import { ownerTemplateRoot, withTemplateStorage, writeUploadedTemplate } from "./bigscreen-templates-server";
import { checkBigScreenTemplate } from "./bigscreen-compliance-server";
import { DELETE } from "../app/api/big-screen-templates/[id]/route";
import { GET as listTemplates } from "../app/api/big-screen-templates/route";
import { GET as serveTemplate } from "../app/bigscreen/[...path]/route";

vi.mock("./api-server-client", async (original) => ({
  ...await original<typeof import("./api-server-client")>(),
  callApi: vi.fn()
}));

describe("owner-scoped template lifecycle", () => {
  let root: string;
  let ownerRoot: string;
  let deletion: ApiFetchResult;
  const request = () => new Request("http://localhost/api/big-screen-templates/fqc", { method: "DELETE" });
  const failure = (status: number, message: string): ApiFetchResult => ({
    ok: false, status, json: { success: false, error: { code: status === 404 ? "RESOURCE_NOT_FOUND" : "CONFLICT", message } }
  });
  const install = (owner: string, published = false) => {
    const directory = ownerTemplateRoot(owner);
    writeUploadedTemplate(directory, {
      id: "fqc", name: "uploaded FQC", description: "", published,
      entry: "fqc-quality-screen.html", dataFile: "", fields: [],
      filePaths: new Set(["fqc-quality-screen.html"])
    });
    writeFileSync(path.join(directory, "fqc", "fqc-quality-screen.html"), "<html><body>uploaded owner FQC</body></html>");
  };
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "template-lifecycle-"));
    vi.stubEnv("BIGSCREEN_ROOT", path.join(root, "bundled"));
    vi.stubEnv("BIGSCREEN_UPLOAD_ROOT", path.join(root, "uploads"));
    ownerRoot = ownerTemplateRoot("owner-a");
    deletion = { ok: true, status: 200, json: { success: true, data: { deleted: true } } };
    vi.mocked(callApi).mockImplementation(async (_request, pathname) =>
      pathname.endsWith("storage-context")
        ? { ok: true, status: 200, json: { success: true, data: { userId: "owner-a" } } }
        : deletion);
    mkdirSync(path.join(root, "bundled", "fqc"), { recursive: true });
    writeFileSync(path.join(root, "bundled", "fqc", "index.html"), "<html><body>built-in FQC</body></html>");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    rmSync(root, { recursive: true, force: true });
  });
  it("allows built-in names as owner uploads while protecting static routes", () => {
    expect(BIG_SCREEN_BUILTIN_TEMPLATE_IDS).toEqual([]);
    expect(BIG_SCREEN_BUILTIN_TEMPLATE_IDS.every(id => !(BIG_SCREEN_RESERVED_TEMPLATE_IDS as readonly string[]).includes(id))).toBe(true);
    expect(BIG_SCREEN_RESERVED_TEMPLATE_IDS).toEqual(expect.arrayContaining(["assets", "cleanup", "register", "storage-context", "repair", "design-prompt"]));
  });
  it("removes an uploaded folder after registration deletion, preserving other owners and built-ins", async () => {
    install("owner-a"); install("owner-b");
    expect((await DELETE(request())).status).toBe(200);
    expect(existsSync(path.join(ownerRoot, "fqc"))).toBe(false);
    expect(existsSync(path.join(ownerTemplateRoot("owner-b"), "fqc"))).toBe(true);
    expect(existsSync(path.join(root, "bundled", "fqc"))).toBe(true);
    expect(callApi).toHaveBeenLastCalledWith(expect.any(Request), "/api/v1/big-screen-templates/fqc", { method: "DELETE" });
    install("owner-a");
    expect(existsSync(path.join(ownerRoot, "fqc", ".template.json"))).toBe(true);
  });
  it("cleans an unpublished orphan when the API row is already gone", async () => {
    install("owner-a");
    deletion = failure(404, "CONFIG_RESOURCE_NOT_FOUND:big-screen-template:fqc");
    expect((await DELETE(request())).status).toBe(200);
    expect(existsSync(path.join(ownerRoot, "fqc"))).toBe(false);
  });
  it("clears registration even when its folder has already gone", async () => {
    expect((await DELETE(request())).status).toBe(200);
    expect(callApi).toHaveBeenLastCalledWith(expect.any(Request), "/api/v1/big-screen-templates/fqc", { method: "DELETE" });
  });
  it("returns not found if both halves are gone", async () => {
    deletion = failure(404, "CONFIG_RESOURCE_NOT_FOUND:big-screen-template:fqc");
    expect((await DELETE(request())).status).toBe(404);
  });
  it.each([
    [409, "BIG_SCREEN_TEMPLATE_IN_USE:wall-a"],
    [401, "Authentication required."],
    [500, "Storage unavailable"],
    [404, "Unknown API resource: big-screen-templates"]
  ])("preserves files when the API refuses deletion (%s)", async (status, message) => {
    install("owner-a"); deletion = failure(status, message);
    expect((await DELETE(request())).status).toBe(status);
    expect(existsSync(path.join(ownerRoot, "fqc", ".template.json"))).toBe(true);
  });
  it("deletes an orphan even when its cached sidecar still says published", async () => {
    install("owner-a", true);
    expect((await DELETE(request())).status).toBe(200);
    expect(existsSync(path.join(ownerRoot, "fqc"))).toBe(false);
    expect(callApi).toHaveBeenLastCalledWith(expect.any(Request), "/api/v1/big-screen-templates/fqc", { method: "DELETE" });
  });
  it("preserves a published template when the API reports it is still in use", async () => {
    install("owner-a", true);
    deletion = failure(409, "BIG_SCREEN_TEMPLATE_PUBLISHED");
    expect((await DELETE(request())).status).toBe(409);
    expect(callApi).toHaveBeenCalledTimes(2);
    expect(existsSync(path.join(ownerRoot, "fqc"))).toBe(true);
  });
  it("reconciles the sidecar when the API unpublishes a template after screen deletion", async () => {
    install("owner-a", true); install("owner-b", true);
    deletion = { ok: true, status: 200, json: { success: true, data: [{ id: "fqc", templateId: "fqc", published: false }] } };
    const response = await listTemplates(new Request("http://localhost/api/big-screen-templates"));
    expect(response.status).toBe(200);
    expect((await response.json()).data[0].published).toBe(false);
    const sidecar = (owner: string) => JSON.parse(readFileSync(path.join(ownerTemplateRoot(owner), "fqc", ".template.json"), "utf8"));
    expect(sidecar("owner-a").published).toBe(false);
    expect(sidecar("owner-b").published).toBe(true);
  });
  it("checks the owner's upload before the built-in template of the same name", async () => {
    install("owner-a");
    const check = withTemplateStorage(async () => Response.json(checkBigScreenTemplate("fqc")));
    const report = await (await check(new Request("http://localhost/compliance"))).json();
    expect(report.origin).toBe("uploaded");
    expect(report.repair.entry).toBe("fqc-quality-screen.html");
    expect(report.repair.html).toContain("uploaded owner FQC");
    expect(report.repair.html).not.toContain("built-in FQC");
  });
  it.each([true, false])("previews the owner's uploaded entry for built-in aliases (published=%s)", async (published) => {
    install("owner-a", published);
    for (const segments of [["fqc"], ["fqc", "index.html"], ["fqc", "fqc-quality-screen.html"]]) {
      const response = await serveTemplate(new Request("http://localhost/bigscreen/" + segments.join("/")), { params: Promise.resolve({ path: segments }) });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("uploaded owner FQC");
      expect(html).not.toContain("built-in FQC");
    }
  });
  it("bridges a nested uploaded entry and resolves its relative assets inside that directory", async () => {
    const directory = path.join(ownerRoot, "nested-iqc");
    mkdirSync(path.join(directory, "page", "assets"), { recursive: true });
    writeUploadedTemplate(ownerRoot, {
      id: "nested-iqc", name: "Nested IQC", description: "", published: false,
      entry: "page/incoming-quality-control.html", dataFile: "", fields: [],
      filePaths: new Set(["page/incoming-quality-control.html", "page/assets/chart.js"]),
      binding: { global: "IQC", call: "setData" }
    });
    writeFileSync(path.join(directory, "page", "incoming-quality-control.html"), '<html><head></head><body><script src="assets/chart.js"></script></body></html>');
    writeFileSync(path.join(directory, "page", "assets", "chart.js"), "window.IQC={setData(){}};");
    for (const segments of [["nested-iqc"], ["nested-iqc", "index.html"], ["nested-iqc", "page", "incoming-quality-control.html"]]) {
      const response = await serveTemplate(new Request("http://localhost/bigscreen"), { params: Promise.resolve({ path: segments }) });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('base href="/bigscreen/nested-iqc/page/"');
      expect(html).toContain("__DATAFOUNDRY_BIGSCREEN_BRIDGE__");
    }
    const asset = await serveTemplate(new Request("http://localhost/bigscreen"), { params: Promise.resolve({ path: ["nested-iqc", "page", "assets", "chart.js"] }) });
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain("window.IQC");
  });
});
