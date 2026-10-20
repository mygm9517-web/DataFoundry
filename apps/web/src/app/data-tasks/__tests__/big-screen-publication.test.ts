import { describe, expect, it, vi } from "vitest";
import type { BigScreenDto, UploadedBigScreenTemplateDto } from "../../../lib/config-api";
import { publishSavedBigScreen, publishedTemplateIds } from "../big-screen-publication";

const screen = { id: "iqc-screen", templateId: "uploaded-iqc" } as BigScreenDto;
const template = { id: "uploaded-iqc", published: false } as UploadedBigScreenTemplateDto;
describe("save and go live publication", () => {
  it("publishes the uploaded template after saving its SQL definition", async () => {
    const api = { listBigScreenTemplates: vi.fn(async () => [template]), publishBigScreenTemplate: vi.fn(async () => ({})) };
    await publishSavedBigScreen(api, screen);
    expect(api.publishBigScreenTemplate).toHaveBeenCalledWith("uploaded-iqc", true);
    expect(api.listBigScreenTemplates.mock.invocationCallOrder[0]).toBeLessThan(api.publishBigScreenTemplate.mock.invocationCallOrder[0]!);
  });
  it("reconciles both publication stores even when the DB already says published", async () => {
    const api = { listBigScreenTemplates: vi.fn(async () => [{ ...template, published: true }]), publishBigScreenTemplate: vi.fn(async () => ({})) };
    await publishSavedBigScreen(api, screen);
    expect(api.publishBigScreenTemplate).toHaveBeenCalledWith("uploaded-iqc", true);
  });
  it("does not report success when publication fails", async () => {
    const api = { listBigScreenTemplates: vi.fn(async () => [template]), publishBigScreenTemplate: vi.fn(async () => { throw new Error("Publication denied"); }) };
    await expect(publishSavedBigScreen(api, screen)).rejects.toThrow("Publication denied");
  });
  it("refuses a missing uploaded template and unavailable registry", async () => {
    const api = { listBigScreenTemplates: vi.fn(async () => [] as UploadedBigScreenTemplateDto[]), publishBigScreenTemplate: vi.fn(async () => ({})) };
    await expect(publishSavedBigScreen(api, screen)).rejects.toThrow("BIG_SCREEN_TEMPLATE_NOT_FOUND");
    api.listBigScreenTemplates.mockRejectedValue(new Error("Registry unavailable"));
    await expect(publishSavedBigScreen(api, screen)).rejects.toThrow("Registry unavailable");
    expect(api.publishBigScreenTemplate).not.toHaveBeenCalled();
  });
  it("requires an uploaded registration because business pages are not bundled", async () => {
    const api = { listBigScreenTemplates: vi.fn(async () => []), publishBigScreenTemplate: vi.fn(async () => ({})) };
    await expect(publishSavedBigScreen(api, { ...screen, templateId: "home" })).rejects.toThrow("BIG_SCREEN_TEMPLATE_NOT_FOUND");
    expect(api.publishBigScreenTemplate).not.toHaveBeenCalled();
  });
  it("uses actual publication flags rather than saved screen references for badges", () => {
    expect([...publishedTemplateIds([template, { ...template, id: "already-live", published: true }])]).toEqual(["already-live"]);
  });
});
