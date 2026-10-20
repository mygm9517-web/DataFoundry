"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../../i18n/locale-context";
import type { TranslateFn } from "../../../i18n/types";
import type {
  BigScreenBundleViolationDto,
  BigScreenRepairSourceDto,
  UploadedBigScreenTemplateDto,
} from "../../../lib/config-api";
import { ConfigApiError, configApi } from "../../../lib/config-api";
import {
  ComplianceChip,
  CompliancePanel,
  errorText,
  repairErrorText,
  type BigScreenComplianceMap,
} from "./BigScreenCompliance";
import { btnSecondaryClass, sectionLabelClass } from "../ui-tokens";

/**
 * Uploaded page templates: the half of the console that manages the pages
 * themselves, as opposed to the screens that render them.
 *
 * This is where an operator brings a page they built elsewhere into the platform.
 * A page that fails the import contract is not a dead end: the rejection carries
 * the design prompt and the specific rules it broke, so the page can be fixed —
 * by hand, elsewhere, or by the workspace's default model on the spot.
 */

type UploadedPagesPanelProps = {
  onOpenScreens: () => void;
};

const cardClass =
  "space-y-3 rounded-xl border border-border bg-white px-4 py-3 shadow-[var(--shadow-card)]";
const eyebrowClass = sectionLabelClass;
const fieldClass =
  "h-9 w-full rounded-lg border border-border bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-slate-400";
const tinyActionClass =
  "h-7 rounded-lg border border-border bg-white px-2.5 text-[11px] font-semibold text-slate-700 transition hover:bg-surface-subtle disabled:cursor-not-allowed disabled:opacity-40";
const dangerButtonClass =
  "h-7 rounded-lg border border-rose-200 bg-rose-50 px-2.5 text-[11px] font-semibold text-rose-800 transition hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-40";
const primaryButtonClass =
  "h-9 rounded-lg bg-teal-700 px-4 text-sm font-semibold text-white transition hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-40";

export function UploadedPagesPanel({ onOpenScreens }: UploadedPagesPanelProps) {
  const t = useT();
  const [templates, setTemplates] = useState<UploadedBigScreenTemplateDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rejection, setRejection] = useState<Rejection | null>(null);
  /** The row whose compliance detail is open, keyed by id so a refresh keeps it. */
  const [detailId, setDetailId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setTemplates(await configApi.listBigScreenTemplates());
      setError(null);
    } catch (loadError) {
      setTemplates([]);
      setError(t("bigScreen.loadFailed", { message: errorText(loadError) }));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  // A deleted page leaves nothing to inspect. Closing the detail here rather than
  // in `remove` covers every path that can take a row away, including the refresh
  // button and an upload that renames one.
  useEffect(() => {
    if (detailId && !templates.some((item) => item.id === detailId)) setDetailId(null);
  }, [detailId, templates]);

  const clearMessages = useCallback(() => {
    setError(null);
    setNotice(null);
  }, []);

  /**
   * Uploads one archive and folds either outcome into the page.
   *
   * The failure branch is the common one for a first upload, so it is not treated
   * as an error banner: it opens the repair panel, which is where the operator can
   * actually do something about it.
   */
  const upload = useCallback(
    async (file: File, templateId: string, description: string) => {
      setBusy("upload");
      clearMessages();
      try {
        const result = await configApi.uploadBigScreenTemplate(file, {
          ...(templateId.trim() ? { templateId: templateId.trim() } : {}),
          ...(description.trim() ? { description: description.trim() } : {}),
        });
        if (result.ok) {
          setRejection(null);
          setNotice(t("bigScreen.uploadSucceeded", { id: result.template.id }));
          await load();
          return;
        }
        setError(null);
        setRejection({
          filename: file.name,
          templateIdFromArchive: templateId.trim() || deriveTemplateId(file.name),
          violations: result.violations,
          designPrompt: result.designPrompt ?? "",
          message: result.message,
          code: result.code,
          ...(result.repair ? { repair: result.repair } : {}),
        });
      } catch (uploadError) {
        setError(t("bigScreen.uploadFailed", { message: errorText(uploadError) }));
      } finally {
        setBusy(null);
      }
    },
    [clearMessages, load, t],
  );

  const setPublished = useCallback(
    async (id: string, published: boolean) => {
      setBusy(`publish:${id}`);
      clearMessages();
      try {
        await configApi.publishBigScreenTemplate(id, published);
        setNotice(
          published
            ? t("bigScreen.publishedNotice")
            : t("bigScreen.unpublishedNotice"),
        );
        await load();
      } catch (publishError) {
        setError(
          published
            ? t("bigScreen.publishFailed", { message: errorText(publishError) })
            : t("bigScreen.unpublishFailed", { message: errorText(publishError) }),
        );
      } finally {
        setBusy(null);
      }
    },
    [clearMessages, load, t],
  );

  const remove = useCallback(
    async (template: UploadedBigScreenTemplateDto) => {
      // A published page is live on a wall; the server refuses this too, but the
      // point of asking here is to say why before the request goes out.
      if (template.published) {
        setError(t("bigScreen.deleteUploadedPublished"));
        return;
      }
      if (!window.confirm(t("bigScreen.deleteUploadedConfirm", { name: template.name }))) {
        return;
      }
      setBusy(`delete:${template.id}`);
      clearMessages();
      try {
        await configApi.deleteBigScreenTemplate(template.id);
        setNotice(t("bigScreen.deletedNotice", { id: template.id }));
        await load();
      } catch (deleteError) {
        setError(t("bigScreen.deleteUploadedFailed", { message: errorText(deleteError) }));
      } finally {
        setBusy(null);
      }
    },
    [clearMessages, load, t],
  );

  const download = useCallback(
    async (template: UploadedBigScreenTemplateDto) => {
      setBusy(`download:${template.id}`);
      clearMessages();
      try {
        const { blob, filename } = await configApi.downloadBigScreenTemplate(template.id);
        saveBlob(blob, filename);
      } catch (downloadError) {
        setError(t("bigScreen.downloadFailed", { message: errorText(downloadError) }));
      } finally {
        setBusy(null);
      }
    },
    [clearMessages, t],
  );

  return (
    <div className="space-y-4">
      {error ? <Banner tone="error" text={error} /> : null}
      {notice ? <Banner tone="ok" text={notice} /> : null}

      <UploadCard busy={busy === "upload"} onUpload={upload} />

      {rejection ? (
        <RejectionPanel
          rejection={rejection}
          onDismiss={() => setRejection(null)}
          onUploaded={async (file, id) => {
            setRejection(null);
            await upload(file, id, "");
          }}
        />
      ) : null}

      <section className={cardClass}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className={eyebrowClass}>{t("bigScreen.uploadedTemplates")}</div>
            <p className="mt-1 text-xs text-muted-light">
              {t("bigScreen.uploadedTemplatesHint")}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onOpenScreens} className={btnSecondaryClass}>
              {t("bigScreen.screens")}
            </button>
            <button type="button" onClick={() => void load()} className={btnSecondaryClass}>
              {loading ? t("common.refreshing") : t("common.refresh")}
            </button>
          </div>
        </div>

        {loading ? (
          <p className="text-xs text-muted-light">{t("common.loading")}</p>
        ) : templates.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border bg-surface-subtle px-3 py-4 text-center text-xs text-muted-light">
            {t("bigScreen.uploadedEmpty")}
          </p>
        ) : (
          <div className="space-y-2">
            {templates.map((template) => (
              <TemplateRow
                key={template.id}
                busy={busy}
                open={detailId === template.id}
                template={template}
                onDelete={() => void remove(template)}
                onDownload={() => void download(template)}
                onPublish={() => void setPublished(template.id, true)}
                onUnpublish={() => void setPublished(template.id, false)}
                onToggleDetail={() =>
                  setDetailId((current) => (current === template.id ? null : template.id))
                }
              />
            ))}
          </div>
        )}
      </section>

      {detailId ? (
        <CompliancePanel
          key={detailId}
          templateId={detailId}
          onClose={() => setDetailId(null)}
          onFixed={async () => {
            setDetailId(null);
            setNotice(t("bigScreen.complianceFixedNotice"));
            await load();
          }}
        />
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Upload                                                                      */
/* -------------------------------------------------------------------------- */

function UploadCard({
  busy,
  onUpload,
}: {
  busy: boolean;
  onUpload: (file: File, templateId: string, description: string) => Promise<void>;
}) {
  const t = useT();
  const [file, setFile] = useState<File | null>(null);
  const [templateId, setTemplateId] = useState("");
  const [description, setDescription] = useState("");
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const pick = (next: File | null) => {
    setFile(next);
    if (!next) return;
    // Prefill the id from the filename so the common case is one click: the
    // operator can still override it, but most archives are already named after
    // the page they contain.
    setTemplateId((current) => (current.trim() ? current : deriveTemplateId(next.name)));
  };

  const submit = async () => {
    if (!file) return;
    await onUpload(file, templateId, description);
    setFile(null);
    setDescription("");
    setTemplateId("");
    if (inputRef.current) inputRef.current.value = "";
  };

  return (
    <section className={cardClass}>
      <div className={eyebrowClass}>{t("bigScreen.uploadPage")}</div>
      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          pick(event.dataTransfer.files?.[0] ?? null);
        }}
        className={[
          "rounded-xl border border-dashed px-3 py-4 text-center text-xs transition",
          dragging
            ? "border-teal-400 bg-teal-50 text-teal-900"
            : "border-border bg-surface-subtle text-muted-light",
        ].join(" ")}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".zip,.html,.htm"
          className="hidden"
          onChange={(event) => pick(event.target.files?.[0] ?? null)}
        />
        {file ? (
          <div className="space-y-1">
            <div className="font-medium text-foreground">{file.name}</div>
            <div className="text-[11px] text-muted-light">{formatBytes(file.size)}</div>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className={tinyActionClass}
            >
              {t("bigScreen.uploadFileLabel")}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="text-xs font-medium text-teal-800 underline-offset-2 hover:underline"
          >
            {t("bigScreen.uploadDropHint")}
          </button>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="text-[11px] font-medium text-muted-light">
            {t("bigScreen.uploadIdLabel")}
          </span>
          <input
            value={templateId}
            onChange={(event) => setTemplateId(event.target.value)}
            placeholder={t("bigScreen.uploadIdPlaceholder")}
            className={`${fieldClass} font-mono`}
          />
          <span className="block text-[10px] text-muted-light">
            {t("bigScreen.uploadIdHelp")}
          </span>
        </label>
        <label className="space-y-1">
          <span className="text-[11px] font-medium text-muted-light">
            {t("bigScreen.uploadDescriptionLabel")}
          </span>
          <input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={t("bigScreen.uploadDescriptionPlaceholder")}
            className={fieldClass}
          />
        </label>
      </div>

      <button
        type="button"
        disabled={!file || busy}
        onClick={() => void submit()}
        className={primaryButtonClass}
      >
        {busy ? t("bigScreen.uploading") : t("bigScreen.uploadPage")}
      </button>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Rejection                                                                   */
/* -------------------------------------------------------------------------- */

type Rejection = {
  filename: string;
  /**
   * The id the refused archive was uploaded under.
   *
   * Resolved here rather than at re-upload time because the repaired page is
   * re-uploaded under the same id: the operator already chose it, and deriving it
   * again from the model's filename would silently rename the page.
   */
  templateIdFromArchive: string;
  message: string;
  code: string;
  violations: BigScreenBundleViolationDto[];
  designPrompt: string;
  /** The page as uploaded, when the server unpacked it far enough to keep it. */
  repair?: BigScreenRepairSourceDto;
};

/**
 * A page that failed the import contract, and the two ways out of it.
 *
 * Both ways are shown at once rather than behind a choice: copying the prompt is
 * always available and always safe, while asking the model is the shortcut, and
 * it can fail for reasons that have nothing to do with the page (no model
 * configured, provider down). Hiding the prompt behind the model button would
 * leave the operator stuck in exactly that case.
 */
function RejectionPanel({
  rejection,
  onDismiss,
  onUploaded,
}: {
  rejection: Rejection;
  onDismiss: () => void;
  onUploaded: (file: File, templateId: string) => Promise<void>;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [repairError, setRepairError] = useState<string | null>(null);
  const [repairedHtml, setRepairedHtml] = useState<string | null>(null);
  const [repairMeta, setRepairMeta] = useState<{ model: string; latencyMs: number } | null>(null);
  const [uploadingRepaired, setUploadingRepaired] = useState(false);

  const prompt = useMemo(
    () => rejection.designPrompt || "",
    [rejection.designPrompt],
  );

  const copyPrompt = async () => {
    // Clipboard access needs a secure context and a user gesture; both hold here,
    // but a denial is a normal outcome, not a bug — the fallback is that the
    // prompt is already on screen and selectable.
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
      setRepairError(t("bigScreen.copyFailed"));
    }
  };

  const repair = async () => {
    const source = rejection.repair;
    if (!source) return;
    setRepairing(true);
    setRepairError(null);
    try {
      const result = await configApi.repairBigScreenTemplate({
        // The page as it was uploaded. Nothing was written to disk by the refused
        // upload, so this is the only copy — it came down with the rejection.
        html: source.html,
        entry: source.entry,
        files: source.files,
        violations: rejection.violations.map((item) => ({
          code: item.code,
          message: item.message,
          fix: item.fix,
        })),
      });
      setRepairedHtml(result.html);
      setRepairMeta({ model: result.model, latencyMs: result.latencyMs });
    } catch (error) {
      setRepairError(repairErrorText(error, t));
    } finally {
      setRepairing(false);
    }
  };

  const uploadRepaired = async () => {
    if (!repairedHtml) return;
    setUploadingRepaired(true);
    try {
      // The model rewrote one file. It goes back as a single `index.html`, which is
      // exactly the shape the server accepts and the same page it just rejected —
      // the id is passed explicitly, so nothing depends on the filename.
      const file = new File([repairedHtml], "index.html", { type: "text/html" });
      await onUploaded(file, rejection.templateIdFromArchive);
    } finally {
      setUploadingRepaired(false);
    }
  };

  return (
    <section className="space-y-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-amber-900">
            {t("bigScreen.violationsTitle")}
          </div>
          <p className="mt-1 text-xs text-amber-900">
            {rejection.filename}
            {" · "}
            {rejection.code}
            {" · "}
            {rejection.message}
          </p>
        </div>
        <button type="button" onClick={onDismiss} className={tinyActionClass}>
          {t("common.close")}
        </button>
      </div>

      {rejection.violations.length > 0 ? (
        <div className="overflow-hidden rounded-lg border border-amber-200 bg-white">
          {rejection.violations.map((violation, index) => (
            <div
              key={`${violation.code}-${index}`}
              className="border-b border-amber-100 px-3 py-2 last:border-b-0"
            >
              <div className="font-mono text-[10px] text-amber-800">{violation.code}</div>
              <div className="mt-0.5 text-xs text-slate-800">{violation.message}</div>
              <div className="mt-0.5 text-[11px] text-teal-800">
                {t("bigScreen.violationFix")}
                {"："}
                {violation.fix}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="space-y-2 rounded-lg border border-amber-200 bg-white px-3 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-xs font-semibold text-foreground">
              {t("bigScreen.designPromptTitle")}
            </div>
            <p className="mt-0.5 text-[11px] text-muted-light">
              {t("bigScreen.designPromptHint")}
            </p>
            {rejection.repair?.entryGuessed ? (
              <p className="mt-0.5 text-[11px] text-amber-700">
                {t("bigScreen.repairEntryGuessed", { entry: rejection.repair.entry })}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => void copyPrompt()} className={tinyActionClass}>
              {copied ? t("bigScreen.copiedDesignPrompt") : t("bigScreen.copyDesignPrompt")}
            </button>
            <button
              type="button"
              disabled={repairing || !rejection.repair}
              title={rejection.repair ? undefined : t("bigScreen.repairUnavailable")}
              onClick={() => void repair()}
              className={tinyActionClass}
            >
              {repairing ? t("bigScreen.repairing") : t("bigScreen.repairAction")}
            </button>
          </div>
        </div>
        <textarea
          readOnly
          value={prompt}
          rows={8}
          spellCheck={false}
          onFocus={(event) => event.currentTarget.select()}
          className="w-full rounded-lg border border-border bg-surface-subtle px-3 py-2 font-mono text-[11px] leading-5 text-slate-800 outline-none"
        />
        {repairError ? (
          <p className="text-[11px] text-rose-700">{repairError}</p>
        ) : null}
      </div>

      {repairedHtml ? (
        <div className="space-y-2 rounded-lg border border-teal-200 bg-white px-3 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-xs font-semibold text-foreground">
                {t("bigScreen.repairResultTitle")}
              </div>
              <p className="mt-0.5 text-[11px] text-muted-light">
                {t("bigScreen.repairResultHint")}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {repairMeta ? (
                <span className="self-center text-[10px] text-muted-light">
                  {t("bigScreen.repairModel", { model: repairMeta.model })}
                  {" · "}
                  {t("bigScreen.repairLatency", { ms: repairMeta.latencyMs })}
                </span>
              ) : null}
              <button
                type="button"
                disabled={uploadingRepaired}
                onClick={() => void uploadRepaired()}
                className={tinyActionClass}
              >
                {t("bigScreen.repairUpload")}
              </button>
              <button
                type="button"
                onClick={() => {
                  setRepairedHtml(null);
                  setRepairMeta(null);
                }}
                className={tinyActionClass}
              >
                {t("bigScreen.repairDiscard")}
              </button>
            </div>
          </div>
          <textarea
            readOnly
            value={repairedHtml}
            rows={10}
            spellCheck={false}
            className="w-full rounded-lg border border-border bg-surface-subtle px-3 py-2 font-mono text-[11px] leading-5 text-slate-800 outline-none"
          />
        </div>
      ) : null}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Rows                                                                        */
/* -------------------------------------------------------------------------- */

function TemplateRow({
  busy,
  open,
  template,
  onDelete,
  onDownload,
  onPublish,
  onToggleDetail,
  onUnpublish,
}: {
  busy: string | null;
  open: boolean;
  template: UploadedBigScreenTemplateDto;
  onDelete: () => void;
  onDownload: () => void;
  onPublish: () => void;
  onToggleDetail: () => void;
  onUnpublish: () => void;
}) {
  const t = useT();
  const rowBusy = busy?.endsWith(`:${template.id}`) ?? false;
  const compliance = template.compliance;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface-subtle px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-semibold text-foreground">{template.name}</span>
          <span
            className={[
              "shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium",
              template.published
                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                : "border-border bg-white text-muted-light",
            ].join(" ")}
          >
            {template.published ? t("bigScreen.published") : t("bigScreen.unpublished")}
          </span>
          <ComplianceChip compliance={compliance} open={open} onOpen={onToggleDetail} />
          {template.installed === false ? (
            <span className="shrink-0 rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-[10px] font-medium text-rose-800">
              {t("bigScreen.uploadedMissingOnDisk")}
            </span>
          ) : null}
        </div>
        <div className="truncate text-[11px] text-muted-light">
          {template.id}
          {" · "}
          {t("bigScreen.entryFile")}
          {": "}
          {template.entry}
          {template.dataFile ? ` · ${t("bigScreen.dataFileLabel")}: ${template.dataFile}` : ""}
          {" · "}
          {t("bigScreen.boundFields", { count: template.fields.length })}
          {template.sizeBytes ? ` · ${formatBytes(template.sizeBytes)}` : ""}
        </div>
        {template.description ? (
          <div className="truncate text-[11px] text-muted-light">{template.description}</div>
        ) : null}
      </div>
      <button type="button" disabled={rowBusy} onClick={onDownload} className={tinyActionClass}>
        {t("bigScreen.download")}
      </button>
      {template.published ? (
        <button type="button" disabled={rowBusy} onClick={onUnpublish} className={tinyActionClass}>
          {t("bigScreen.unpublish")}
        </button>
      ) : (
        <button type="button" disabled={rowBusy} onClick={onPublish} className={tinyActionClass}>
          {t("bigScreen.publish")}
        </button>
      )}
      {/* Disabled rather than hidden while published: the rule is "take it down
          first", and showing the button greyed out with that reason next to it
          teaches the rule; a hidden button just looks like a missing feature. */}
      <button
        type="button"
        disabled={rowBusy || template.published}
        title={template.published ? t("bigScreen.deleteUploadedPublished") : undefined}
        onClick={onDelete}
        className={dangerButtonClass}
      >
        {t("bigScreen.deleteUploaded")}
      </button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Shared bits                                                                 */
/* -------------------------------------------------------------------------- */

function Banner({ tone, text }: { tone: "ok" | "error"; text: string }) {
  return (
    <div
      className={[
        "rounded-lg border px-3 py-2 text-xs",
        tone === "error"
          ? "border-rose-200 bg-rose-50 text-rose-800"
          : "border-emerald-200 bg-emerald-50 text-emerald-800",
      ].join(" ")}
    >
      {text}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** Mirrors the server's derivation so the prefill matches what would be stored. */
function deriveTemplateId(filename: string): string {
  return filename
    .replace(/\.(zip|html?)$/iu, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 40);
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoked on the next tick, not immediately: Safari reads the blob after the
  // click handler returns, and revoking in the same tick yields an empty file.
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
