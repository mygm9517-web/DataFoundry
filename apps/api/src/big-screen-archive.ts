import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { bigScreenUploadRoot } from "@datafoundry/bigscreen";

export { bigScreenUploadRoot };

/**
 * The archive an operator uploaded, kept beside the unpacked page.
 *
 * The web server writes it at upload time and the API reads it back for the
 * download endpoint. Both processes resolve `bigScreenUploadRoot()` from the
 * same shared package, so neither has to be told where the other put it.
 */

/** Where the archive lives for a template: `<root>/<templateId>/<filename>`. */
export const bigScreenArchivePath = (templateId: string, archiveFilename: string, ownerId: string): string | null => {
  if (![ownerId, templateId].every(value => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/u.test(value))) return null;
  const root = join(bigScreenUploadRoot(), "users", ownerId);
  const dir = resolve(root, templateId);
  // `archiveFilename` is the multipart filename a client chose, so it is only
  // ever a name: a value like `../../.env` must not be read, and must not be
  // written to at upload time either. `basename` collapses it to its last
  // segment; a name that was already bare is unchanged.
  const safeName = basename(archiveFilename.replaceAll("\\", "/"));
  if (!safeName || safeName.startsWith(".")) return null;
  const target = join(dir, safeName);
  return target.startsWith(dir + sep) ? target : null;
};

export const writeBigScreenTemplateArchive = (
  templateId: string,
  archiveFilename: string,
  content: Buffer,
  ownerId: string
): string => {
  const target = bigScreenArchivePath(templateId, archiveFilename, ownerId);
  if (!target) {
    throw new Error("BIG_SCREEN_TEMPLATE_ARCHIVE_PATH_UNSAFE");
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  return target;
};

export const readBigScreenTemplateArchiveFile = (input: {
  templateId: string;
  archiveFilename: string;
  ownerId: string;
}): Buffer | undefined => {
  const target = bigScreenArchivePath(input.templateId, input.archiveFilename, input.ownerId);
  if (!target || !existsSync(target)) return undefined;
  return readFileSync(target);
};
