"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../../i18n/locale-context";
import type {
  BigScreenDataDto,
  BigScreenDatasetResultDto,
  BigScreenDto,
  UploadedBigScreenTemplateDto,
} from "../../../lib/config-api";
import { configApi } from "../../../lib/config-api";
import { publishSavedBigScreen, publishedTemplateIds as actualPublishedTemplateIds } from "../big-screen-publication";
import { BigScreenView } from "../../bigscreen/components/BigScreenView";
import {
  DEFAULT_BIG_SCREEN_PREFETCH_ROWS,
  DEFAULT_BIG_SCREEN_REFRESH_MS,
  DEFAULT_BIG_SCREEN_VISIBLE_POINTS,
  MAX_BIG_SCREEN_DATASETS,
  MAX_BIG_SCREEN_PREFETCH_ROWS,
  MAX_BIG_SCREEN_REFRESH_HOURS,
  MAX_BIG_SCREEN_VISIBLE_POINTS,
  MIN_BIG_SCREEN_REFRESH_HOURS,
  HOUR_MS,
  refreshMsToHours,
  getBigScreenTemplate,
  type BigScreenTemplate,
} from "../big-screen-templates";
import {
  clampInteger,
  collectColumns,
  draftBody,
  draftDefinition,
  draftFromScreen,
  emptyDraft,
  type Draft,
  type DraftDataset,
  type DraftRule,
} from "../big-screen-draft";
import { isConfigItemUsable, type WorkspaceConfigItem } from "../data-task-state";
import { btnSecondaryClass, panelTitleClass, sectionLabelClass } from "../ui-tokens";
import { UploadedPagesPanel } from "./UploadedPagesPanel";
import {
  ComplianceChip,
  CompliancePanel,
  useBigScreenCompliance,
  type BigScreenComplianceMap,
} from "./BigScreenCompliance";

/**
 * Console for the big screens.
 *
 * The point of this screen is that the wall's data contract is *not* fixed: the
 * operator picks a layout, then decides which data category feeds which slot.
 * So the editing order here is template → categories → bindings → cadence, and
 * the preview at the end is the actual runtime component on the actual payload
 * the backend builds, not a mock.
 *
 * Two tabs, in that order of use: pages are imported once, screens then reuse
 * them. Keeping both here rather than in separate drawers is deliberate — an
 * import that fails the contract is fixed and re-imported, and the screen that
 * wanted it is one click away instead of a trip through the sidebar.
 */

type BigScreenPanelProps = {
  /** Datasources already configured for the workspace — screens reuse them. */
  datasources: WorkspaceConfigItem[];
  onBack: () => void;
  onOpenDatasourceConfig: () => void;
};

const panelShellClass =
  "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-surface";
const eyebrowClass = sectionLabelClass;
const cardClass =
  "space-y-3 rounded-xl border border-border bg-white px-4 py-3 shadow-[var(--shadow-card)]";
const fieldClass =
  "h-9 w-full rounded-lg border border-border bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-slate-400";
const textareaClass =
  "w-full rounded-lg border border-border bg-white px-3 py-2 font-mono text-[12px] leading-5 text-slate-900 outline-none transition focus:border-slate-400";
const primaryButtonClass =
  "h-9 rounded-lg bg-teal-700 px-4 text-sm font-semibold text-white transition hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-40";
const smallActionClass =
  "h-8 rounded-lg border border-border bg-white px-3 text-xs font-semibold text-slate-700 transition hover:bg-surface-subtle disabled:cursor-not-allowed disabled:opacity-40";
const dangerButtonClass =
  "h-8 rounded-lg border border-rose-200 bg-rose-50 px-3 text-xs font-semibold text-rose-800 transition hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-40";

export function BigScreenPanel({
  datasources,
  onBack,
  onOpenDatasourceConfig,
}: BigScreenPanelProps) {
  const t = useT();
  const [screens, setScreens] = useState<BigScreenDto[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const libraryScrollTop = useRef(0);
  const editing = draft !== null;
  useLayoutEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = editing ? 0 : libraryScrollTop.current;
  }, [editing]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [preview, setPreview] = useState<BigScreenDataDto | null>(null);
  /** Column names per dataset, learned from the last successful run. */
  const [columnsByDataset, setColumnsByDataset] = useState<Record<string, string[]>>({});
  const [dirty, setDirty] = useState(false);
  /** The installed page whose compliance detail is expanded in the library. */
  const [inspectedPage, setInspectedPage] = useState<string | null>(null);
  const { compliance, reload: reloadCompliance } = useBigScreenCompliance();
  /**
   * Uploaded pages, as binding targets for the editor.
   *
   * A page is described by the manifest captured at upload, which names every
   * field the page's data contract exposes. The editor builds binding targets
   * from that, so a page opened here offers real columns rather than an empty
   * picker that saves rules nothing can match.
   *
   * Uploaded first, and only then the bundled registry: a user who uploads a
   * page under an id a bundled sample also uses must get their own page's field
   * list, since that is the page the wall serves.
   */
  const [uploadedForEditor, setUploadedForEditor] = useState<UploadedBigScreenTemplateDto[]>([]);
  useEffect(() => {
    let cancelled = false;
    void configApi.listBigScreenTemplates()
      .then((templates) => { if (!cancelled) setUploadedForEditor(templates); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  const resolveTemplate = useCallback(
    (templateId: string): BigScreenTemplate | undefined =>
      uploadedAsTemplate(uploadedForEditor.find((item) => item.id === templateId))
        ?? getBigScreenTemplate(templateId),
    [uploadedForEditor],
  );

  const usableDatasources = useMemo(
    () => datasources.filter(isConfigItemUsable),
    [datasources],
  );

  const loadScreens = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setScreens(await configApi.listBigScreens());
    } catch (loadError) {
      setError(t("bigScreen.loadFailed", { message: errorText(loadError) }));
      setScreens([]);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadScreens();
  }, [loadScreens]);

  const updateDraft = useCallback((patch: Partial<Draft>) => {
    setDirty(true);
    setNotice(null);
    setDraft((current) => (current ? { ...current, ...patch } : current));
  }, []);

  const updateDataset = useCallback(
    (key: string, patch: Partial<DraftDataset>) => {
      setDirty(true);
      setNotice(null);
      setDraft((current) =>
        current
          ? {
              ...current,
              datasets: current.datasets.map((dataset) =>
                dataset.key === key ? { ...dataset, ...patch } : dataset,
              ),
            }
          : current,
      );
    },
    [],
  );

  const startNew = useCallback(
    (template: BigScreenTemplate) => {
      libraryScrollTop.current = contentRef.current?.scrollTop ?? 0;
      const next = emptyDraft(template);
      setDraft(next);
      setColumnsByDataset({});
      setPreview(null);
      setDirty(true);
      setNotice(null);
      setError(null);
    },
    [],
  );

  const editScreen = useCallback((screen: BigScreenDto) => {
    libraryScrollTop.current = contentRef.current?.scrollTop ?? 0;
    setDraft(draftFromScreen(screen));
    setColumnsByDataset({});
    setPreview(null);
    setDirty(false);
    setNotice(null);
    setError(null);
  }, []);

  const closeDraft = useCallback(() => {
    setDraft(null);
    setColumnsByDataset({});
    setPreview(null);
    setDirty(false);
    setNotice(null);
    setError(null);
  }, []);

  /** Runs the draft and folds the returned column names into the binding pickers. */
  const runPreview = useCallback(async () => {
    if (!draft) return;
    const definition = draftDefinition(draft);
    setBusy("preview");
    setError(null);
    setNotice(null);
    try {
      // Always use previewBigScreenDraft: it works for both saved and unsaved drafts.
      // testBigScreen requires a row that exists on the backend — an unsaved draft
      // has a client-minted id the server has never seen and would return
      // CONFIG_RESOURCE_NOT_FOUND. The preview endpoint accepts the same definition
      // payload and returns the same result shape, so nothing downstream changes.
      const result = await configApi.previewBigScreenDraft({
        definition,
        ...(draft.datasourceId ? { datasourceId: draft.datasourceId } : {}),
      });
      setPreview(result);
      setColumnsByDataset(collectColumns(draft, result));
    } catch (previewError) {
      setPreview(null);
      setError(t("bigScreen.testFailed", { message: errorText(previewError) }));
    } finally {
      setBusy(null);
    }
  }, [draft, t]);

  const save = useCallback(async () => {
    if (!draft) return;
    const definition = draftDefinition(draft);
    if (!Array.isArray(definition.datasets) || definition.datasets.length === 0) {
      setError(t("bigScreen.definitionMissing"));
      return;
    }
    setBusy("save");
    setError(null);
    setNotice(null);
    try {
      const body = draftBody(draft, draft.datasourceId);
      // `draft.id` is minted when the editor opens, not when the row is created,
      // so it outlives the row it names: deleting the published screen and
      // saving the draft again would PATCH an id nothing holds. The API answers
      // that with CONFIG_RESOURCE_NOT_FOUND, and re-creating under the same id
      // is what the operator meant — the id is the draft's own.
      const saved = draft.id
        ? await configApi.patchBigScreen(draft.id, body).catch((patchError: unknown) => {
            if (!isMissingResourceError(patchError)) throw patchError;
            return configApi.createBigScreen(body);
          })
        : await configApi.createBigScreen(body);
      setDraft(draftFromScreen(saved));
      setDirty(false);
      try {
        await publishSavedBigScreen(configApi, saved);
      } catch (publishError) {
        setError(t("bigScreen.publishFailed", { message: errorText(publishError) }));
        return;
      }
      setNotice(t("bigScreen.saved"));
      setUploadedForEditor(await configApi.listBigScreenTemplates());
      await loadScreens();
    } catch (saveError) {
      setError(t("bigScreen.saveFailed", { message: errorText(saveError) }));
    } finally {
      setBusy(null);
    }
  }, [draft, loadScreens, t]);

  const remove = useCallback(
    async (id: string) => {
      if (!window.confirm(t("bigScreen.deleteConfirm"))) return;
      setBusy("delete");
      setError(null);
      try {
        await configApi.deleteBigScreen(id);
        if (draft?.id === id) closeDraft();
        await loadScreens();
      } catch (deleteError) {
        setError(t("bigScreen.saveFailed", { message: errorText(deleteError) }));
      } finally {
        setBusy(null);
      }
    },
    [closeDraft, draft?.id, loadScreens, t],
  );

  // The wall is only fed from a saved screen: an unsaved draft has no id to poll,
  // and previewing one live would show numbers the backend has not accepted yet.
  const previewScreen = useMemo<BigScreenDto | null>(() => {
    if (!draft?.id) return null;
    const saved = screens.find((screen) => screen.id === draft.id);
    return saved ?? null;
  }, [draft?.id, screens]);

  return (
    <div className={panelShellClass}>
      <PanelHeader
        draft={draft}
        loading={loading}
        onBack={draft ? closeDraft : onBack}
        onRefresh={() => void loadScreens()}
      />
      <div ref={contentRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {error ? <Banner tone="error" text={error} /> : null}
        {notice ? <Banner tone="ok" text={notice} /> : null}
        {draft ? (
          <DraftEditor
            busy={busy}
            columnsByDataset={columnsByDataset}
            datasources={usableDatasources}
            draft={draft}
            preview={preview}
            previewScreen={previewScreen}
            template={resolveTemplate(draft.templateId)}
            templates={uploadedForEditor
              .map((row) => uploadedAsTemplate(row))
              .filter((entry): entry is BigScreenTemplate => Boolean(entry))}
            onCloseDraft={closeDraft}
            onDatasetChange={updateDataset}
            onDraftChange={updateDraft}
            onOpenDatasourceConfig={onOpenDatasourceConfig}
            onPreview={() => void runPreview()}
            onSave={() => void save()}
          />
        ) : null}
        <div hidden={editing}>
          <ScreenLibrary
            compliance={compliance}
            datasources={usableDatasources}
            inspected={inspectedPage}
            loading={loading}
            onFixed={reloadCompliance}
            onInspect={(templateId) =>
              setInspectedPage((current) => (current === templateId ? null : templateId))
            }
            screens={screens}
            onEdit={editScreen}
            onNew={startNew}
            onOpenDatasourceConfig={onOpenDatasourceConfig}
            onRefreshScreens={() => void loadScreens()}
            onRemove={(id) => void remove(id)}
          />
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Library                                                                     */
/* -------------------------------------------------------------------------- */

function ScreenLibrary({
  compliance,
  datasources,
  inspected,
  loading,
  onFixed,
  onInspect,
  screens,
  onEdit,
  onNew,
  onOpenDatasourceConfig,
  onRefreshScreens,
  onRemove,
}: {
  compliance: BigScreenComplianceMap;
  datasources: WorkspaceConfigItem[];
  /** The template whose compliance detail is expanded below the grid, if any. */
  inspected: string | null;
  loading: boolean;
  onFixed: () => Promise<void>;
  onInspect: (templateId: string) => void;
  screens: BigScreenDto[];
  onEdit: (screen: BigScreenDto) => void;
  onNew: (template: BigScreenTemplate) => void;
  onOpenDatasourceConfig: () => void;
  onRefreshScreens: () => void;
  onRemove: (id: string) => void;
}) {
  const t = useT();
  const [uploadedTemplates, setUploadedTemplates] = useState<any[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [showUploadDialog, setShowUploadDialog] = useState(false);

  const loadUploadedTemplates = useCallback(async () => {
    try {
      const templates = await configApi.listBigScreenTemplates();
      setUploadedTemplates(templates);
    } catch (error) {
      console.error("Failed to load uploaded templates:", error);
    }
  }, []);

  useEffect(() => {
    void loadUploadedTemplates();
  }, [loadUploadedTemplates, screens]);

  const handleUploadComplete = useCallback(async () => {
    setShowUploadDialog(false);
    await loadUploadedTemplates();
    await onFixed(); // Reload compliance
    onRefreshScreens();
  }, [loadUploadedTemplates, onFixed, onRefreshScreens]);

  const handleDeleteTemplate = useCallback(async (templateId: string) => {
    if (!window.confirm(t("bigScreen.deleteTemplateConfirm"))) return;

    try {
      await configApi.deleteBigScreenTemplate(templateId);
      await loadUploadedTemplates();
      await onFixed(); // Reload compliance
      onRefreshScreens();
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "删除失败");
    }
  }, [loadUploadedTemplates, onFixed, onRefreshScreens, t]);

  const handleTogglePublish = useCallback(async (templateId: string, published: boolean) => {
    try {
      await configApi.publishBigScreenTemplate(templateId, !published);
      await loadUploadedTemplates();
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "操作失败");
    }
  }, [loadUploadedTemplates]);

  // Every page in the library is an upload belonging to this user.
  //
  // The list comes from the API row, which is scoped to the signed-in user, so
  // one user never sees another's pages — and there is no built-in catalogue
  // here to mix in: a page the platform happens to ship is not this user's, and
  // offering it a delete button would promise a deletion that cannot happen.
  // Each row is described by the manifest captured at upload, so the card shows
  // the page's real field count and the editor gets real binding targets.
  const allTemplates = useMemo(
    () =>
      uploadedTemplates
        .map((row) => uploadedAsTemplate(row))
        .filter((template): template is BigScreenTemplate => Boolean(template)),
    [uploadedTemplates],
  );
  const publishedTemplateIds = useMemo(
    () => actualPublishedTemplateIds(uploadedTemplates),
    [uploadedTemplates],
  );
  return (
    <div className="space-y-4">
      {uploadError ? <Banner tone="error" text={uploadError} /> : null}

      <section className={cardClass}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className={eyebrowClass}>{t("bigScreen.startFromTemplate")}</div>
            <p className="mt-1 text-xs text-muted-light">{t("bigScreen.templateHint")}</p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setShowUploadDialog(true)}
              className={smallActionClass}
            >
              上传页面模板
            </button>
            <button type="button" onClick={onOpenDatasourceConfig} className={smallActionClass}>
              {t("bigScreen.openDatasourceConfig")}
            </button>
          </div>
        </div>
        {datasources.length === 0 ? (
          <p className="rounded-lg border border-dashed border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            {t("bigScreen.noDatasource")}
          </p>
        ) : null}

        {/* The user's own pages. Nothing is listed here that they did not upload. */}
        {allTemplates.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border bg-surface-subtle px-3 py-3 text-xs text-muted-light">
            {t("bigScreen.uploadedEmpty")}
          </p>
        ) : null}
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {allTemplates.map((template) => {
            const summary = compliance[template.id];
            // The persisted publication flag is the public serving gate.
            const isPublished = publishedTemplateIds.has(template.id);

            return (
              <div
                key={template.id}
                className="relative rounded-xl border border-border bg-surface-subtle px-3 py-3 transition hover:border-teal-300 hover:bg-white"
              >
                {/* Delete button in top-right corner */}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDeleteTemplate(template.id);
                  }}
                  className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-md text-muted-light transition hover:bg-rose-50 hover:text-rose-600"
                  title="删除模板"
                >
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                </button>

                <button
                  type="button"
                  onClick={() => onNew(template)}
                  className="block w-full text-left pr-6"
                >
                  <span className="block text-sm font-semibold text-foreground">
                    {template.name}
                  </span>
                  <span className="mt-1 block text-[11px] leading-5 text-muted">
                    {template.description || "无描述"}
                  </span>
                  <span className="mt-2 flex flex-wrap gap-1.5">
                    <Chip text={template.id} />
                    <Chip text={t("bigScreen.templateLayout", { points: template.fields.length })} />
                    {isPublished ? (
                      <span className="rounded-full border border-teal-200 bg-teal-50 px-2 py-0.5 text-[10px] font-medium text-teal-700">
                        {t("bigScreen.published")}
                      </span>
                    ) : (
                      <span className="rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[10px] font-medium text-gray-600">
                        {t("bigScreen.unpublished")}
                      </span>
                    )}
                  </span>
                </button>
                {summary && summary.status !== "compliant" ? (
                  <span className="mt-2 flex flex-wrap items-center gap-1.5">
                    <ComplianceChip
                      compliance={summary}
                      open={inspected === template.id}
                      onOpen={() => onInspect(template.id)}
                    />
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>

        {inspected ? (
          <CompliancePanel
            key={inspected}
            templateId={inspected}
            onClose={() => onInspect(inspected)}
            onFixed={async () => {
              onInspect(inspected);
              await onFixed();
            }}
          />
        ) : null}
      </section>

      {showUploadDialog ? (
        <UploadTemplateDialog
          onClose={() => setShowUploadDialog(false)}
          onSuccess={handleUploadComplete}
          onError={setUploadError}
        />
      ) : null}

      <section className={cardClass}>
        <div className={eyebrowClass}>{t("bigScreen.publishedScreens")}</div>
        {loading ? (
          <p className="text-xs text-muted-light">{t("common.loading")}</p>
        ) : screens.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border bg-surface-subtle px-3 py-4 text-center text-xs text-muted-light">
            {t("bigScreen.noPublishedScreens")}
          </p>
        ) : (
          <div className="space-y-2">
            {screens.map((screen) => (
              <div
                key={screen.id}
                className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface-subtle px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-foreground">
                    {screen.title || screen.name}
                  </div>
                  <div className="truncate text-[11px] text-muted-light">
                    {screen.id}
                    {" · "}
                    {screen.templateId}
                    {" · "}
                    {t("bigScreen.everyHours", { hours: refreshMsToHours(screen.refreshMs) })}
                    {" · "}
                    {screen.datasets.length} {t("bigScreen.dataCategory")}
                  </div>
                </div>
                <button type="button" onClick={() => onEdit(screen)} className={smallActionClass}>
                  {t("common.edit")}
                </button>
                {/* A real route, so a plain anchor: the wall opens in its own tab
                    and survives the console navigating away from it. */}
                {publishedTemplateIds.has(screen.templateId) ? <a
                  href={screen.publicUrl ?? `/wall/${screen.ownerId}/${encodeURIComponent(screen.id)}`}
                  target="_blank"
                  rel="noreferrer"
                  title={t("bigScreen.wallHint", { id: screen.id })}
                  className={`${smallActionClass} inline-flex items-center justify-center`}
                >
                  {t("bigScreen.openWall")}
                </a> : <button
                  type="button"
                  onClick={() => void handleTogglePublish(screen.templateId, false)}
                  className={smallActionClass}
                >
                  {t("bigScreen.publish")}
                </button>}
                <button type="button" onClick={() => onRemove(screen.id)} className={dangerButtonClass}>
                  {t("common.delete")}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Editor                                                                      */
/* -------------------------------------------------------------------------- */

function DraftEditor({
  busy,
  columnsByDataset,
  datasources,
  draft,
  preview,
  previewScreen,
  template,
  templates,
  onCloseDraft,
  onDatasetChange,
  onDraftChange,
  onOpenDatasourceConfig,
  onPreview,
  onSave,
}: {
  busy: string | null;
  columnsByDataset: Record<string, string[]>;
  datasources: WorkspaceConfigItem[];
  draft: Draft;
  preview: BigScreenDataDto | null;
  previewScreen: BigScreenDto | null;
  template: BigScreenTemplate | undefined;
  /** Every page this user has uploaded, offered as the screen's template. */
  templates: BigScreenTemplate[];
  onCloseDraft: () => void;
  onDatasetChange: (key: string, patch: Partial<DraftDataset>) => void;
  onDraftChange: (patch: Partial<Draft>) => void;
  onOpenDatasourceConfig: () => void;
  onPreview: () => void;
  onSave: () => void;
}) {
  const t = useT();
  const boundTargets = useMemo(
    () => new Set(draft.datasets.flatMap((dataset) => dataset.rules.map((rule) => rule.target))),
    [draft.datasets],
  );

  return (
    <div className="grid min-h-0 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,520px)]">
      <div className="space-y-4">
        <section className={cardClass}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className={eyebrowClass}>{t("bigScreen.chooseTemplate")}</div>
            <button type="button" onClick={onCloseDraft} className={smallActionClass}>
              {t("bigScreen.back")}
            </button>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="space-y-1">
              <span className="text-[11px] font-medium text-muted-light">
                {t("bigScreen.screenName")}
              </span>
              <input
                value={draft.name}
                onChange={(event) => onDraftChange({ name: event.target.value })}
                placeholder={t("bigScreen.screenNamePlaceholder")}
                className={fieldClass}
              />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] font-medium text-muted-light">
                {t("bigScreen.screenTitle")}
              </span>
              <input
                value={draft.title}
                onChange={(event) => onDraftChange({ title: event.target.value })}
                placeholder={t("bigScreen.screenTitlePlaceholder")}
                className={fieldClass}
              />
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            {templates.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => onDraftChange({ templateId: entry.id })}
                className={[
                  "rounded-lg border px-3 py-2 text-left text-xs transition",
                  entry.id === draft.templateId
                    ? "border-teal-300 bg-teal-50 text-teal-900"
                    : "border-border bg-white text-slate-700 hover:bg-surface-subtle",
                ].join(" ")}
              >
                <span className="block font-semibold">{entry.name}</span>
                <span className="text-[10px] text-muted-light">
                  {t("bigScreen.templateLayout", { points: entry.fields.length })}
                </span>
              </button>
            ))}
          </div>
          {template ? (
            <p className="text-[11px] text-muted-light">
              {template.description}
            </p>
          ) : null}
        </section>

        <section className={cardClass}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className={eyebrowClass}>{t("bigScreen.dataCategory")}</div>
              <p className="mt-1 text-xs text-muted-light">{t("bigScreen.dataCategoryHint")}</p>
            </div>
            <div className="flex flex-col items-end gap-1">
              <button
                type="button"
                className={smallActionClass}
                disabled={draft.datasets.length >= MAX_BIG_SCREEN_DATASETS}
                onClick={() =>
                  onDraftChange({
                    datasets: [
                      ...draft.datasets,
                      {
                        key: `dataset-${Date.now().toString(36)}`,
                        id: `dataset-${draft.datasets.length + 1}`,
                        sql: "",
                        datasourceId: "",
                        limit: "",
                        rules: [],
                      },
                    ],
                  })
                }
              >
                {t("bigScreen.addDataset")}
              </button>
              <span className="text-[10px] text-muted-light">
                {t("bigScreen.datasetLimit", {
                  count: draft.datasets.length,
                  max: MAX_BIG_SCREEN_DATASETS,
                })}
              </span>
            </div>
          </div>
          {draft.datasets.map((dataset, index) => (
            <DatasetCard
              key={dataset.key}
              columns={columnsByDataset[dataset.id] ?? []}
              datasources={datasources}
              dataset={dataset}
              index={index}
              previewResult={preview?.datasets.find((entry) => entry.id === dataset.id)}
              template={template}
              onOpenDatasourceConfig={onOpenDatasourceConfig}
              onRemove={() =>
                onDraftChange({ datasets: draft.datasets.filter((entry) => entry.key !== dataset.key) })
              }
              onDatasetChange={(patch) => onDatasetChange(dataset.key, patch)}
            />
          ))}
        </section>

        <RefreshSection draft={draft} onDraftChange={onDraftChange} />
        <DatasourceSection
          datasources={datasources}
          draft={draft}
          onDraftChange={onDraftChange}
          onOpenDatasourceConfig={onOpenDatasourceConfig}
        />
      </div>

      <div className="space-y-4">
        <section className={cardClass}>
          <div className={eyebrowClass}>{t("bigScreen.preview")}</div>
          <p className="mt-1 text-xs text-muted-light">{t("bigScreen.previewHint")}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy !== null}
              onClick={onPreview}
              className={primaryButtonClass}
            >
              {busy === "preview" ? t("bigScreen.running") : t("bigScreen.runPreview")}
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={onSave}
              className={btnSecondaryClass}
            >
              {busy === "save" ? t("bigScreen.saving") : t("bigScreen.deploy")}
            </button>
          </div>
          {previewScreen && draft.id ? (
            <div className="h-[360px] overflow-hidden rounded-xl border border-border">
              <BigScreenView screen={previewScreen} />
            </div>
          ) : (
            <p className="rounded-lg border border-dashed border-border bg-surface-subtle px-3 py-3 text-[11px] text-muted-light">
              {t("bigScreen.unsaved")}
            </p>
          )}
        </section>

        <Diagnostics preview={preview} />
        <BindingSummary boundTargets={boundTargets} template={template} />
      </div>
    </div>
  );
}

function DatasetCard({
  columns,
  datasources,
  dataset,
  index,
  previewResult,
  template,
  onDatasetChange,
  onOpenDatasourceConfig,
  onRemove,
}: {
  columns: string[];
  datasources: WorkspaceConfigItem[];
  dataset: DraftDataset;
  index: number;
  previewResult: BigScreenDatasetResultDto | undefined;
  template: BigScreenTemplate | undefined;
  onDatasetChange: (patch: Partial<DraftDataset>) => void;
  onOpenDatasourceConfig: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  const groups = useMemo(
    () => (template ? groupFields(template) : []),
    [template],
  );
  // Columns come from the last 试跑预览, so a freshly opened screen has none yet
  // and targets come from the template list, which loads after the editor opens.
  // A saved rule must still show what it was saved with: a `<select>` whose
  // value has no matching `<option>` silently displays its placeholder, which
  // reads as "never configured" even though the rule is intact. So every column
  // and target already used by a rule is offered alongside the learned ones.
  const columnOptions = useMemo(() => {
    const seen = new Set(columns);
    const extra: string[] = [];
    for (const rule of dataset.rules) {
      for (const column of [rule.column, rule.labelColumn]) {
        if (column && !seen.has(column)) {
          seen.add(column);
          extra.push(column);
        }
      }
    }
    return [...columns, ...extra];
  }, [columns, dataset.rules]);
  const targetGroups = useMemo(() => {
    const known = new Set(groups.flatMap((group) => group.fields.map((field) => field.target)));
    const missing = dataset.rules
      .map((rule) => rule.target)
      .filter((target, at, all) => target && !known.has(target) && all.indexOf(target) === at);
    if (missing.length === 0) return groups;
    return [
      ...groups,
      {
        group: t("bigScreen.savedTargets"),
        fields: missing.map((target) => ({
          path: target,
          kind: (target.endsWith("[]") ? "series" : "scalar") as BigScreenTemplate["fields"][number]["kind"],
          target,
        })),
      },
    ];
  }, [dataset.rules, groups, t]);

  const setRule = (position: number, patch: Partial<DraftRule>) => {
    const rules = dataset.rules.map((rule, at) => (at === position ? { ...rule, ...patch } : rule));
    onDatasetChange({ rules });
  };

  return (
    <div className="space-y-3 rounded-xl border border-border bg-surface-subtle px-3 py-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-[160px] flex-1 space-y-1">
          <span className="text-[11px] font-medium text-muted-light">
            {t("bigScreen.dataset")} #{index + 1}
          </span>
          <input
            value={dataset.id}
            onChange={(event) => onDatasetChange({ id: event.target.value })}
            className={fieldClass}
          />
        </label>
        <label className="min-w-[160px] flex-1 space-y-1">
          <span className="text-[11px] font-medium text-muted-light">{t("bigScreen.datasource")}</span>
          <select
            value={dataset.datasourceId}
            onChange={(event) => onDatasetChange({ datasourceId: event.target.value })}
            className={fieldClass}
          >
            <option value="">{t("bigScreen.useWorkspaceDefault")}</option>
            {datasources.map((datasource) => (
              <option key={datasource.id} value={datasource.id}>
                {datasource.name}
              </option>
            ))}
          </select>
        </label>
        <label className="w-[130px] space-y-1">
          <span
            className="text-[11px] font-medium text-muted-light"
            title={t("bigScreen.limitRowsHint")}
          >
            {t("bigScreen.limitRows")}
          </span>
          <input
            value={dataset.limit}
            inputMode="numeric"
            onChange={(event) => onDatasetChange({ limit: event.target.value.replace(/[^0-9]/g, "") })}
            className={fieldClass}
          />
        </label>
        <button type="button" onClick={onRemove} className={dangerButtonClass}>
          {t("bigScreen.removeDataset")}
        </button>
      </div>

      <label className="block space-y-1">
        <span className="text-[11px] font-medium text-muted-light">{t("bigScreen.datasetSql")}</span>
        <textarea
          value={dataset.sql}
          rows={4}
          spellCheck={false}
          onChange={(event) => onDatasetChange({ sql: event.target.value })}
          placeholder={t("bigScreen.sqlPlaceholder")}
          className={textareaClass}
        />
      </label>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[11px] font-semibold text-muted">{t("bigScreen.bindFields")}</span>
          <div className="flex items-center gap-2">
            {previewResult ? (
              <span className="text-[10px] text-muted-light">
                {t("bigScreen.rows", { count: previewResult.rowCount })}
                {" · "}
                {t("bigScreen.elapsed", { ms: previewResult.elapsedMs })}
              </span>
            ) : null}
            <button
              type="button"
              className={smallActionClass}
              disabled={columns.length === 0}
              onClick={() =>
                onDatasetChange({
                  rules: [...dataset.rules, { column: columns[0], target: "", label: "" }],
                })
              }
            >
              {t("bigScreen.addFieldRule")}
            </button>
          </div>
        </div>
        <p className="text-[11px] leading-5 text-muted-light">{t("bigScreen.bindFieldsHint")}</p>

        {previewResult?.error ? (
          <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] text-rose-800">
            {t("bigScreen.datasetFailed")}
            {": "}
            {previewResult.error}
          </p>
        ) : null}

        {columnOptions.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border bg-white px-3 py-2 text-[11px] text-muted-light">
            {t("bigScreen.chooseColumnFirst")}
          </p>
        ) : null}

        {dataset.rules.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border bg-white px-3 py-2 text-[11px] text-muted-light">
            {t("bigScreen.fieldRulesEmpty")}
          </p>
        ) : (
          <div className="space-y-1.5">
            {dataset.rules.map((rule, position) => {
              const arrayTarget = rule.target.endsWith("[]");
              // The value column and the name column landing on the same field
              // is the one mistake this row invites, and it is invisible on the
              // wall until someone reads the numbers: every chart point comes
              // out carrying its own label as its value, so a bar chart of
              // channels renders four bars all named "douyin". Nothing about
              // the SQL looks wrong, so flag it where the choice was made.
              const selfLabelled = arrayTarget
                && rule.labelColumn !== undefined
                && rule.labelColumn !== ""
                && rule.labelColumn === rule.column;
              return (
                <div key={position} className="flex flex-wrap items-center gap-2">
                  <select
                    value={rule.column}
                    onChange={(event) => setRule(position, { column: event.target.value })}
                    title={t("bigScreen.columnHint")}
                    aria-invalid={selfLabelled}
                    className={`${fieldClass} w-[150px] ${selfLabelled ? "border-amber-400 bg-amber-50" : ""}`}
                  >
                    <option value="">{t("bigScreen.column")}</option>
                    {columnOptions.map((column) => (
                      <option key={column} value={column}>
                        {column}
                      </option>
                    ))}
                  </select>
                  <span className="text-muted-light">-&gt;</span>
                  <select
                    value={rule.target}
                    onChange={(event) => setRule(position, { target: event.target.value, ...(event.target.value.endsWith("[]") ? {} : { label: "" }) })}
                    className={`${fieldClass} w-[210px]`}
                  >
                    <option value="">{t("bigScreen.target")}</option>
                    {targetGroups.map((group) => (
                      <optgroup key={group.group} label={group.group}>
                        {group.fields.map((field) => (
                          <option key={field.target} value={field.target}>
                            {field.path}
                            {field.kind === "series" ? ` ${t("bigScreen.targetArray")}` : ""}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                  {arrayTarget ? (
                    // Two ways to name a row, and the column wins when both are
                    // set: a query that returns its own labels is always more
                    // current than a category name typed once into the editor.
                    <>
                      <input
                        value={rule.label ?? ""}
                        onChange={(event) => setRule(position, { label: event.target.value })}
                        placeholder={t("bigScreen.rowLabel")}
                        title={t("bigScreen.rowLabelHint")}
                        className={`${fieldClass} w-[150px]`}
                      />
                      <select
                        value={rule.labelColumn ?? ""}
                        onChange={(event) => setRule(position, { labelColumn: event.target.value })}
                        title={t("bigScreen.rowLabelColumnHint")}
                        className={`${fieldClass} w-[150px]`}
                      >
                        <option value="">{t("bigScreen.rowLabelColumn")}</option>
                        {columnOptions.map((column) => (
                          <option key={column} value={column}>
                            {column}
                          </option>
                        ))}
                      </select>
                    </>
                  ) : null}
                  <button
                    type="button"
                    className={smallActionClass}
                    onClick={() =>
                      onDatasetChange({
                        rules: dataset.rules.filter((_, at) => at !== position),
                      })
                    }
                  >
                    {t("common.delete")}
                  </button>
                  {selfLabelled ? (
                    <p className="w-full rounded-lg border border-dashed border-amber-300 bg-amber-50 px-2.5 py-1.5 text-[11px] leading-4 text-amber-900">
                      {t("bigScreen.valueEqualsNameColumn")}
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
      {datasources.length === 0 ? (
        <button type="button" onClick={onOpenDatasourceConfig} className={smallActionClass}>
          {t("bigScreen.openDatasourceConfig")}
        </button>
      ) : null}
    </div>
  );
}

function RefreshSection({
  draft,
  onDraftChange,
}: {
  draft: Draft;
  onDraftChange: (patch: Partial<Draft>) => void;
}) {
  const t = useT();
  return (
    <section className={cardClass}>
      <div className={eyebrowClass}>{t("bigScreen.refresh")}</div>
      <p className="mt-1 text-xs text-muted-light">{t("bigScreen.refreshHint")}</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="space-y-1">
          <span className="text-[11px] font-medium text-muted-light">{t("bigScreen.refreshHours")}</span>
          <input
            value={refreshMsToHours(draft.refreshMs)}
            inputMode="numeric"
            onChange={(event) =>
              onDraftChange({
                // Entered in hours, stored in milliseconds like every screen before.
                refreshMs:
                  clampInteger(
                    Number.parseInt(event.target.value.replace(/[^0-9]/g, ""), 10),
                    MIN_BIG_SCREEN_REFRESH_HOURS,
                    MAX_BIG_SCREEN_REFRESH_HOURS,
                    MIN_BIG_SCREEN_REFRESH_HOURS,
                  ) * HOUR_MS,
              })
            }
            className={fieldClass}
          />
          <span className="block text-[10px] text-muted-light">
            {t("bigScreen.refreshHoursHelp", {
              min: MIN_BIG_SCREEN_REFRESH_HOURS,
              max: MAX_BIG_SCREEN_REFRESH_HOURS,
            })}
          </span>
        </label>
        <label className="space-y-1">
          <span className="text-[11px] font-medium text-muted-light">
            {t("bigScreen.prefetchRows")}
          </span>
          <input
            value={draft.prefetchRows}
            inputMode="numeric"
            onChange={(event) =>
              onDraftChange({
                prefetchRows: clampInteger(
                  Number.parseInt(event.target.value.replace(/[^0-9]/g, ""), 10),
                  0,
                  MAX_BIG_SCREEN_PREFETCH_ROWS,
                  0,
                ),
              })
            }
            className={fieldClass}
          />
          <span className="block text-[10px] text-muted-light">{t("bigScreen.prefetchRowsHint")}</span>
        </label>
        <label className="space-y-1">
          <span className="text-[11px] font-medium text-muted-light">
            {t("bigScreen.visiblePoints")}
          </span>
          <input
            value={draft.visiblePoints}
            inputMode="numeric"
            onChange={(event) =>
              onDraftChange({
                visiblePoints: clampInteger(
                  Number.parseInt(event.target.value.replace(/[^0-9]/g, ""), 10),
                  1,
                  MAX_BIG_SCREEN_VISIBLE_POINTS,
                  DEFAULT_BIG_SCREEN_VISIBLE_POINTS,
                ),
              })
            }
            className={fieldClass}
          />
          <span className="block text-[10px] text-muted-light">
            {t("bigScreen.visiblePointsHint")}
          </span>
        </label>
      </div>
    </section>
  );
}

function DatasourceSection({
  datasources,
  draft,
  onDraftChange,
  onOpenDatasourceConfig,
}: {
  datasources: WorkspaceConfigItem[];
  draft: Draft;
  onDraftChange: (patch: Partial<Draft>) => void;
  onOpenDatasourceConfig: () => void;
}) {
  const t = useT();
  return (
    <section className={cardClass}>
      <div className={eyebrowClass}>{t("bigScreen.datasource")}</div>
      <p className="mt-1 text-xs text-muted-light">{t("bigScreen.datasourceHint")}</p>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={draft.datasourceId}
          onChange={(event) => onDraftChange({ datasourceId: event.target.value })}
          className={`${fieldClass} max-w-[320px]`}
        >
          <option value="">{t("bigScreen.useWorkspaceDefault")}</option>
          {datasources.map((datasource) => (
            <option key={datasource.id} value={datasource.id}>
              {datasource.name}
            </option>
          ))}
        </select>
        <button type="button" onClick={onOpenDatasourceConfig} className={smallActionClass}>
          {t("bigScreen.openDatasourceConfig")}
        </button>
      </div>
      {datasources.length === 0 ? (
        <p className="rounded-lg border border-dashed border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          {t("bigScreen.noDatasource")}
        </p>
      ) : null}
    </section>
  );
}

function Diagnostics({ preview }: { preview: BigScreenDataDto | null }) {
  const t = useT();
  return (
    <section className={cardClass}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className={eyebrowClass}>{t("bigScreen.diagnostics")}</div>
        {preview?.latencyMs !== undefined ? (
          <span className="text-[10px] text-muted-light">
            {t("bigScreen.latency", { ms: preview.latencyMs })}
          </span>
        ) : null}
      </div>
      {!preview ? (
        <p className="rounded-lg border border-dashed border-border bg-surface-subtle px-3 py-3 text-[11px] text-muted-light">
          {t("bigScreen.noDiagnostics")}
        </p>
      ) : (
        <div className="space-y-2">
          {preview.datasets.map((dataset) => (
            <div key={dataset.id} className="rounded-lg border border-border bg-white px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[11px] font-semibold text-slate-800">{dataset.id}</span>
                <span className="text-[10px] text-muted-light">
                  {t("bigScreen.rows", { count: dataset.rowCount })}
                  {" · "}
                  {t("bigScreen.elapsed", { ms: dataset.elapsedMs })}
                </span>
              </div>
              {dataset.error ? (
                <p className="mt-1 text-[11px] text-rose-700">{dataset.error}</p>
              ) : (
                <p className="mt-1 break-all font-mono text-[10px] text-muted-light">
                  {dataset.columns.join(", ")}
                </p>
              )}
            </div>
          ))}
          <pre className="max-h-56 overflow-auto rounded-lg bg-code-bg px-3 py-2 font-mono text-[10px] leading-5 text-slate-100">
            {JSON.stringify(preview.data, null, 2)}
          </pre>
        </div>
      )}
    </section>
  );
}

function BindingSummary({
  boundTargets,
  template,
}: {
  boundTargets: Set<string>;
  template: BigScreenTemplate | undefined;
}) {
  const t = useT();
  if (!template) return null;
  const bound = template.fields.filter((field) => boundTargets.has(field.target)).length;
  return (
    <section className={cardClass}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className={eyebrowClass}>{t("bigScreen.bindFields")}</div>
        <span className="text-[10px] text-muted-light">
          {bound} / {template.fields.length}
        </span>
      </div>
      <div className="flex flex-wrap gap-1">
        {template.fields.map((field) => (
          <span
            key={field.target}
            className={[
              "rounded-full border px-2 py-0.5 font-mono text-[10px]",
              boundTargets.has(field.target)
                ? "border-teal-200 bg-teal-50 text-teal-800"
                : "border-border bg-surface-subtle text-muted-light",
            ].join(" ")}
          >
            {field.path}
          </span>
        ))}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Shared bits                                                                 */
/* -------------------------------------------------------------------------- */

function PanelHeader({
  draft,
  loading,
  onBack,
  onRefresh,
}: {
  draft: Draft | null;
  loading: boolean;
  onBack: () => void;
  onRefresh: () => void;
}) {
  const t = useT();
  return (
    <div className="shrink-0 border-b border-border">
      <div className="flex h-16 items-center gap-3 px-4">
        <button
          type="button"
          onClick={onBack}
          aria-label={t(draft ? "bigScreen.backToLibrary" : "common.backToWorkspace")}
          title={t(draft ? "bigScreen.backToLibrary" : "common.backToWorkspace")}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-light transition hover:bg-surface-subtle hover:text-foreground"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="m14 6-6 6 6 6" />
          </svg>
        </button>
        <div className="min-w-0 flex-1">
          <h2 className={panelTitleClass}>{t("bigScreen.title")}</h2>
          <p className="truncate text-xs text-muted-light">
            {draft ? draft.name || draft.templateId : t("bigScreen.subtitle")}
          </p>
        </div>
        <button type="button" onClick={onRefresh} className={btnSecondaryClass}>
          {loading ? t("common.refreshing") : t("common.refresh")}
        </button>
      </div>
    </div>
  );
}

function Banner({ tone, text }: { tone: "ok" | "error"; text: string }) {
  return (
    <div
      className={[
        "mb-3 rounded-lg border px-3 py-2 text-xs",
        tone === "error"
          ? "border-rose-200 bg-rose-50 text-rose-800"
          : "border-emerald-200 bg-emerald-50 text-emerald-800",
      ].join(" ")}
    >
      {text}
    </div>
  );
}

function Chip({ text }: { text: string }) {
  return (
    <span className="rounded-full border border-border bg-white px-2 py-0.5 text-[10px] font-medium text-muted">
      {text}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** Local copy of the template grouping: the console needs group labels per dataset. */
function groupFields(
  template: BigScreenTemplate,
): Array<{ group: string; fields: BigScreenTemplate["fields"] }> {
  const groups = new Map<string, BigScreenTemplate["fields"]>();
  for (const field of template.fields) {
    const head = field.path.split(".")[0] ?? field.path;
    const bucket = groups.get(head) ?? [];
    bucket.push(field);
    groups.set(head, bucket);
  }
  return [...groups].map(([group, fields]) => ({ group, fields }));
}

/**
 * Column names per dataset, taken from the last run.
 *
 * Datasets are matched by position, not by id: the response echoes the id the
 * *backend* assigned, which for a renamed draft dataset is the previous one.
 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether a failed request means "no row under that id", rather than any other
 * error the save should surface.
 *
 * The API answers a PATCH of a missing resource with CONFIG_RESOURCE_NOT_FOUND
 * wrapped in a RESOURCE_NOT_FOUND envelope, and the client throws the envelope's
 * message. Matched on the code rather than the message so a localised or
 * reworded API error still reads as "missing".
 */
function isMissingResourceError(error: unknown): boolean {
  return /NOT_FOUND:big-screen:/u.test(errorText(error));
}

/* -------------------------------------------------------------------------- */
/* Upload Dialog                                                               */
/* -------------------------------------------------------------------------- */

function UploadTemplateDialog({
  onClose,
  onSuccess,
  onError,
}: {
  onClose: () => void;
  onSuccess: () => void;
  onError: (error: string) => void;
}) {
  const t = useT();
  const [templateId, setTemplateId] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [description, setDescription] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0];
    if (selectedFile) {
      setFile(selectedFile);
      // Auto-fill template ID from filename if empty
      if (!templateId) {
        const nameWithoutExt = selectedFile.name.replace(/\.zip$/i, '');
        setTemplateId(nameWithoutExt);
      }
      // Auto-fill template name from filename if empty
      if (!templateName) {
        const nameWithoutExt = selectedFile.name.replace(/\.zip$/i, '');
        setTemplateName(nameWithoutExt);
      }
    }
  };

  const handleSubmit = async () => {
    if (!file) {
      onError("请选择文件");
      return;
    }
    if (!templateId.trim()) {
      onError("请输入模板ID");
      return;
    }
    if (!templateName.trim()) {
      onError("请输入模板名称");
      return;
    }

    setUploading(true);

    try {
      // Create a FormData with metadata
      const formData = new FormData();
      formData.append('file', file);
      formData.append('id', templateId.trim());
      formData.append('name', templateName.trim());
      if (description.trim()) {
        formData.append('description', description.trim());
      }

      const result = await configApi.uploadBigScreenTemplate(file, {
        id: templateId.trim(),
        name: templateName.trim(),
        description: description.trim() || undefined,
      });

      if (result.ok) {
        onSuccess();
      } else {
        onError(result.message || "上传失败");
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : "上传失败");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-lg rounded-xl border border-border bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-foreground">上传页面模板</h3>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-light transition hover:bg-surface-subtle hover:text-foreground"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block space-y-1">
              <span className="text-sm font-medium text-foreground">选择文件 *</span>
              <input
                ref={fileInputRef}
                type="file"
                accept=".zip"
                onChange={handleFileChange}
                className="hidden"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className={smallActionClass}
                >
                  选择 ZIP 文件
                </button>
                {file ? (
                  <span className="flex items-center text-sm text-muted">{file.name}</span>
                ) : (
                  <span className="flex items-center text-sm text-muted-light">未选择文件</span>
                )}
              </div>
            </label>
          </div>

          <div>
            <label className="block space-y-1">
              <span className="text-sm font-medium text-foreground">模板 ID *</span>
              <input
                type="text"
                value={templateId}
                onChange={(e) => setTemplateId(e.target.value)}
                placeholder="例如: fqc-quality-screen"
                className={fieldClass}
              />
              <span className="text-xs text-muted-light">
                用于系统内部标识，建议使用小写字母和连字符
              </span>
            </label>
          </div>

          <div>
            <label className="block space-y-1">
              <span className="text-sm font-medium text-foreground">模板名称 *</span>
              <input
                type="text"
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
                placeholder="例如: FQC质量看板"
                className={fieldClass}
              />
              <span className="text-xs text-muted-light">
                显示在模板列表中的名称
              </span>
            </label>
          </div>

          <div>
            <label className="block space-y-1">
              <span className="text-sm font-medium text-foreground">描述信息</span>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="选填，描述此模板的用途和功能"
                rows={3}
                className={textareaClass}
              />
            </label>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={uploading}
              className={smallActionClass}
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={uploading || !file || !templateId.trim() || !templateName.trim()}
              className={primaryButtonClass}
            >
              {uploading ? "上传中..." : "上传"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The editor's view of an uploaded page, built from its upload manifest.
 *
 * The manifest records each top-level key and a rough kind, but it cannot see
 * inside an array: a scrolling table like `pdt` comes through as a single
 * `scalar`, though the page reads it as a list of row objects. Those keys get
 * one `key[].column` target per column the page renders, read from the page's
 * own documented contract, so each SQL column can be bound to its table column.
 */
const UPLOADED_ROW_COLUMNS: Record<string, string[]> = {
  pdt: ["time", "no", "project", "done"],
  ecr: ["id", "date", "model", "reason"],
  urgent: ["date", "arrive", "spec", "status"],
  unapproved: ["date", "arrive", "spec", "engineer", "status"],
};

function uploadedAsTemplate(uploaded: UploadedBigScreenTemplateDto | undefined): BigScreenTemplate | undefined {
  if (!uploaded) return undefined;
  const fields: BigScreenTemplate["fields"] = [];
  for (const field of uploaded.fields) {
    const columns = UPLOADED_ROW_COLUMNS[field.path];
    if (columns) {
      for (const column of columns) {
        fields.push({ path: `${field.path}[].${column}`, kind: "scalar", target: `${field.path}[].${column}` });
      }
    } else if (field.kind === "labels" || field.kind === "series") {
      fields.push({ path: field.path, kind: field.kind, target: `${field.path}[]` });
    } else {
      fields.push({ path: field.path, kind: "scalar", target: field.path });
    }
  }
  return {
    id: uploaded.id,
    name: uploaded.name,
    description: uploaded.description ?? "",
    dataFile: uploaded.dataFile ?? "",
    // A page's own window and cadence are not part of the registry row, and a
    // screen stores its own once it is saved; these only seed a brand-new draft.
    visiblePoints: DEFAULT_BIG_SCREEN_VISIBLE_POINTS,
    refreshMs: DEFAULT_BIG_SCREEN_REFRESH_MS,
    bindable: true,
    fields,
  } as BigScreenTemplate;
}
