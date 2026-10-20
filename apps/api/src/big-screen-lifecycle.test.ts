import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMetadataStore, createVerifiedTestIdentity, type MetadataStore } from "@datafoundry/metadata";
import { assertBigScreenTemplateDeletable, deleteBigScreen } from "./big-screen-lifecycle.js";

describe("big-screen deletion and template publication", () => {
  let store: MetadataStore;
  let root: string;
  let scope: { workspace_id: string; user_id: string };
  const template = () => store.configResources.get({ ...scope, kind: "big-screen-template", id: "fqc" });
  const screen = (id: string, wrapped = false, owner = scope) => store.configResources.upsert({
    ...owner, kind: "big-screen", id, name: id,
    payload: wrapped ? { definition: { templateId: "fqc" } } : { templateId: "fqc" },
  });
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "big-screen-lifecycle-"));
    store = createMetadataStore({ database_path: join(root, "metadata.sqlite") });
    const identity = createVerifiedTestIdentity(store, { email: "owner@example.com" });
    scope = { workspace_id: identity.workspaceId, user_id: identity.userId };
    store.configResources.upsert({
      ...scope, kind: "big-screen-template", id: "fqc", name: "FQC", description: "Uploaded page",
      payload: { published: true, entry: "index.html", binding: { global: "FQC", call: "setData" } },
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  it("unpublishes the template after deleting the last screen and preserves its metadata", () => {
    screen("wall-a", true);
    const before = template();
    deleteBigScreen(store, scope, "wall-a");
    expect(store.configResources.find({ ...scope, kind: "big-screen", id: "wall-a" })).toBeUndefined();
    expect(template()).toMatchObject({
      name: before.name, description: before.description, status: before.status,
      default_enabled: before.default_enabled, builtin: before.builtin,
      payload: { ...before.payload, published: false }, revision: before.revision + 1,
    });
    expect(() => assertBigScreenTemplateDeletable(store, template())).not.toThrow();
  });
  it("keeps the template published while another screen still references it", () => {
    screen("wall-a"); screen("wall-b", true);
    deleteBigScreen(store, scope, "wall-a");
    expect(template().payload.published).toBe(true);
    expect(() => assertBigScreenTemplateDeletable(store, template())).toThrow("BIG_SCREEN_TEMPLATE_PUBLISHED");
    deleteBigScreen(store, scope, "wall-b");
    expect(template().payload.published).toBe(false);
  });
  it("allows deleting historical orphan templates even when their flag still says published", () => {
    expect(template().payload.published).toBe(true);
    expect(() => assertBigScreenTemplateDeletable(store, template())).not.toThrow();
  });
  it("protects references to an unpublished template", () => {
    store.configResources.upsert({ ...scope, kind: "big-screen-template", id: "fqc", name: "FQC", payload: { published: false } });
    screen("wall-a");
    expect(() => assertBigScreenTemplateDeletable(store, template())).toThrow("BIG_SCREEN_TEMPLATE_IN_USE:wall-a");
  });
  it("isolates identically named templates and screens owned by other users", () => {
    const identity = createVerifiedTestIdentity(store, { email: "other@example.com" });
    const other = { workspace_id: identity.workspaceId, user_id: identity.userId };
    store.configResources.upsert({ ...other, kind: "big-screen-template", id: "fqc", name: "Other FQC", payload: { published: true } });
    screen("wall-a"); screen("wall-a", true, other);
    deleteBigScreen(store, scope, "wall-a");
    expect(template().payload.published).toBe(false);
    expect(store.configResources.get({ ...other, kind: "big-screen-template", id: "fqc" }).payload.published).toBe(true);
    expect(store.configResources.find({ ...other, kind: "big-screen", id: "wall-a" })).toBeDefined();
  });
  it("rolls back screen deletion if the publication update fails", () => {
    screen("wall-a");
    vi.spyOn(store.configResources, "upsert").mockImplementationOnce(() => { throw new Error("update failed"); });
    expect(() => deleteBigScreen(store, scope, "wall-a")).toThrow("update failed");
    expect(store.configResources.find({ ...scope, kind: "big-screen", id: "wall-a" })).toBeDefined();
    expect(template().payload.published).toBe(true);
  });
  it("deletes a screen whose template registration is already missing", () => {
    store.configResources.delete({ ...scope, kind: "big-screen-template", id: "fqc" });
    screen("wall-a");
    expect(() => deleteBigScreen(store, scope, "wall-a")).not.toThrow();
    expect(store.configResources.find({ ...scope, kind: "big-screen", id: "wall-a" })).toBeUndefined();
  });
});
