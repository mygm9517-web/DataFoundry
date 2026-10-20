import type { ConfigResourceRecord, MetadataStore } from "@datafoundry/metadata";
import { normalizeBigScreenDefinition } from "./big-screen.js";

type Scope = Pick<ConfigResourceRecord, "workspace_id" | "user_id">;

export const bigScreenTemplateUsage = (store: MetadataStore, scope: Scope, templateId: string): string[] =>
  store.configResources.list({ ...scope, kind: "big-screen" })
    .filter(screen => normalizeBigScreenDefinition(screen.payload).templateId === templateId)
    .map(screen => screen.id);

export function assertBigScreenTemplateDeletable(
  store: MetadataStore, template: ConfigResourceRecord,
): void {
  const inUse = bigScreenTemplateUsage(store, template, template.id);
  if (inUse.length === 0) return;
  if (template.payload.published === true) throw new Error("BIG_SCREEN_TEMPLATE_PUBLISHED");
  throw new Error(`BIG_SCREEN_TEMPLATE_IN_USE:${inUse.join(",")}`);
}

/** Removing the last wall also takes its template offline, in one DB transaction. */
export function deleteBigScreen(store: MetadataStore, scope: Scope, id: string): void {
  store.db.exec("BEGIN IMMEDIATE");
  try {
    const screen = store.configResources.get({ ...scope, kind: "big-screen", id });
    const templateId = normalizeBigScreenDefinition(screen.payload).templateId;
    store.configResources.delete({ ...scope, kind: "big-screen", id });
    const template = store.configResources.find({ ...scope, kind: "big-screen-template", id: templateId });
    if (template?.payload.published === true && bigScreenTemplateUsage(store, scope, templateId).length === 0) {
      store.configResources.upsert({
        ...scope, kind: "big-screen-template", id: template.id,
        name: template.name,
        ...(template.description ? { description: template.description } : {}),
        payload: { ...template.payload, published: false },
        ...(template.secret_ref ? { secret_ref: template.secret_ref } : {}),
        default_enabled: template.default_enabled,
        builtin: template.builtin,
        status: template.status,
        expected_revision: template.revision,
      });
    }
    store.db.exec("COMMIT");
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
}
