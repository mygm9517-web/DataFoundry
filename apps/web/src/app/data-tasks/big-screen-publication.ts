import type { BigScreenDto, UploadedBigScreenTemplateDto } from "../../lib/config-api";
import { getBigScreenTemplate } from "./big-screen-templates";

type PublicationApi = {
  listBigScreenTemplates: () => Promise<UploadedBigScreenTemplateDto[]>;
  publishBigScreenTemplate: (id: string, published: boolean) => Promise<Record<string, unknown>>;
};

/** Saving a SQL definition is only the first half of "save and go live". */
export async function publishSavedBigScreen(
  api: PublicationApi,
  screen: BigScreenDto,
): Promise<void> {
  const templates = await api.listBigScreenTemplates();
  if (templates.some(template => template.id === screen.templateId)) {
    // The web endpoint updates both the database and the disk sidecar.
    // Republish also reconciles a sidecar left by an interrupted request.
    await api.publishBigScreenTemplate(screen.templateId, true);
  } else if (!getBigScreenTemplate(screen.templateId)) {
    throw new Error("BIG_SCREEN_TEMPLATE_NOT_FOUND:" + screen.templateId);
  }
}

export const publishedTemplateIds = (templates: UploadedBigScreenTemplateDto[]): Set<string> =>
  new Set(templates.filter(template => template.published).map(template => template.id));
