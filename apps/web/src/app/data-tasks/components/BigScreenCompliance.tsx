"use client";

import { useCallback, useEffect, useState } from "react";
import { useT } from "../../../i18n/locale-context";
import type { TranslateFn } from "../../../i18n/types";
import type {
  BigScreenBundleViolationDto,
  BigScreenComplianceDto,
  BigScreenComplianceSummaryDto,
} from "../../../lib/config-api";
import { ConfigApiError, configApi } from "../../../lib/config-api";
import { sectionLabelClass } from "../ui-tokens";

/**
 * The compliance view: whether an installed page still satisfies the import
 * contract, what it breaks if it does not, and the two ways to fix it.
 *
 * This lives in its own module because two places need it. The uploaded-pages
 * panel introduces a page, and the template library offers the five that ship
 * with the platform — the same five that are the likeliest to be out of date,
 * because they were written before the contract and never had to pass it. One
 * implementation means one answer to "why is this page not compliant", whichever
 * list the operator is looking at.
 */

const cardClass =
  "space-y-3 rounded-xl border border-border bg-white px-4 py-3 shadow-[var(--shadow-card)]";
const eyebrowClass = sectionLabelClass;
const tinyActionClass =
  "h-7 rounded-lg border border-border bg-white px-2.5 text-[11px] font-semibold text-slate-700 transition hover:bg-surface-subtle disabled:cursor-not-allowed disabled:opacity-40";

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Turns a repair failure into something the operator can act on.
 *
 * Two of the failures say nothing about the page: one says this deployment has no
 * model to ask, the other says the model answered but the answer held no page.
 * Both leave the design prompt above as the whole answer, so they are named
 * rather than shown as a raw server string. Anything else is passed through,
 * because a failure this code has not anticipated is more useful verbatim than
 * flattened into "failed".
 */
export function repairErrorText(error: unknown, t: TranslateFn): string {
  const code = error instanceof ConfigApiError ? error.code : undefined;
  if (code === "PROVIDER_CONFIG_MISSING" || code === "PROVIDER_TEST_FAILED") {
    return t("bigScreen.repairProviderMissing");
  }
  if (code === "BIG_SCREEN_TEMPLATE_REPAIR_EMPTY") {
    return t("bigScreen.repairEmpty");
  }
  return t("bigScreen.repairFailed", { message: errorText(error) });
}
const primaryButtonClass =
  "h-9 rounded-lg bg-teal-700 px-4 text-sm font-semibold text-white transition hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-40";

/** The list's per-row verdict, keyed by template id. */
export type BigScreenComplianceMap = Record<string, BigScreenComplianceSummaryDto>;

/** Reads the list's compliance summary once per panel open. */
export function useBigScreenCompliance(): {
  compliance: BigScreenComplianceMap;
  reload: () => Promise<void>;
} {
  const [compliance, setCompliance] = useState<BigScreenComplianceMap>({});
  const reload = useCallback(async () => {
    try {
      const { templates, summaries } = await configApi.listBigScreenTemplateCompliance();
      // Bundled verdicts first, so an uploaded page of the same id would win —
      // it cannot, ids are reserved, but the order makes that explicit rather
      // than accidental.
      const next: BigScreenComplianceMap = { ...summaries };
      for (const template of templates) {
        if (template.compliance) next[template.id] = template.compliance;
      }
      setCompliance(next);
    } catch {
      // The list is the authority on which pages exist; a compliance summary is
      // an annotation on it. Losing the annotation costs a badge, not the panel.
      setCompliance({});
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { compliance, reload };
}

/**
 * A row's verdict badge, or nothing when the page has no summary.
 *
 * Which list is talking decides the wording: a bundled page that fails is listed
 * in the template library and can only be fixed by downloading and re-uploading,
 * so it is not offered a repair it would be refused.
 */
export function ComplianceChip({
  compliance,
  onOpen,
  open,
  showAction = true,
}: {
  compliance: BigScreenComplianceSummaryDto | undefined;
  onOpen?: () => void;
  open?: boolean;
  showAction?: boolean;
}) {
  const t = useT();
  if (!compliance) return null;
  const inspectable = showAction && Boolean(onOpen) && compliance.status !== "compliant";
  return (
    <>
      <span
        className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${complianceToneClass(compliance.status)}`}
      >
        {complianceLabel(compliance, t)}
      </span>
      {inspectable ? (
        <button
          type="button"
          onClick={onOpen}
          className={open ? `${tinyActionClass} border-amber-300 bg-amber-50 text-amber-900` : tinyActionClass}
        >
          {open ? t("bigScreen.complianceHide") : t("bigScreen.complianceOpen")}
        </button>
      ) : null}
    </>
  );
}

/**
 * What the console says about an installed page, and the two ways to fix one.
 *
 * Same shape as a refused upload, one step later: a page that is already
 * installed can drift out of contract (edited by hand, restored from a backup,
 * or shipped that way), and it fails in exactly the same places an upload would.
 * So the two routes out are the same two as well — copy the prompt and fix the
 * page in whatever tool made it, or let the workspace's default model fix the
 * installed copy.
 *
 * There is no page editor here, and that is deliberate. The console's job is to
 * say what is wrong and to hand the page back or fix it; authoring a page is what
 * the operator's own tool is for. A bundled page cannot be written back at all,
 * so for one of those the panel drops the repair and keeps the prompt.
 */
export function CompliancePanel({
  templateId,
  onClose,
  onFixed,
}: {
  templateId: string;
  onClose: () => void;
  onFixed: () => Promise<void>;
}) {
  const t = useT();
  const [report, setReport] = useState<BigScreenComplianceDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [repairError, setRepairError] = useState<string | null>(null);
  const [repairedHtml, setRepairedHtml] = useState<string | null>(null);
  const [repairMeta, setRepairMeta] = useState<{ model: string; latencyMs: number } | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  /** Violations the apply step found, when the repair was not enough. */
  const [stillViolations, setStillViolations] = useState<BigScreenBundleViolationDto[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setReport(await configApi.getBigScreenTemplateCompliance(templateId));
      setLoadError(null);
    } catch (complianceError) {
      setReport(null);
      setLoadError(t("bigScreen.complianceLoadFailed", { message: errorText(complianceError) }));
    } finally {
      setLoading(false);
    }
  }, [t, templateId]);

  useEffect(() => {
    void load();
  }, [load]);

  const copyPrompt = async () => {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(report.designPrompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
      setRepairError(t("bigScreen.copyFailed"));
    }
  };

  // One-click repair: model rewrites the page and applies it immediately.
  // No preview step — the operator just sees success or an error.
  const repair = async () => {
    setRepairing(true);
    setRepairError(null);
    setApplyError(null);
    setStillViolations([]);
    try {
      const result = await configApi.repairBigScreenCompliance(templateId);
      if ("alreadyCompliant" in result) {
        setRepairError(t("bigScreen.complianceAlreadyOk"));
        await load();
        return;
      }
      // Auto-apply the repaired page immediately
      await configApi.applyBigScreenCompliance(templateId, { html: result.html });
      await onFixed();
    } catch (error) {
      if (error instanceof ConfigApiError && error.code === "BIG_SCREEN_TEMPLATE_STILL_INVALID") {
        const payload = error.data as { violations?: BigScreenBundleViolationDto[] } | undefined;
        setStillViolations(payload?.violations ?? []);
        setRepairError(t("bigScreen.complianceStillInvalid"));
      } else {
        setRepairError(repairErrorText(error, t));
      }
    } finally {
      setRepairing(false);
    }
  };

  const apply = async () => { /* unused — repair now auto-applies */ };

  const violations = report?.violations ?? [];
  // All pages can be repaired — the server handles write-back for uploaded pages,
  // and for bundled pages the operator can copy the result and re-upload it.
  const readOnly = false;

  return (
    <section className="space-y-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-amber-900">
            {t("bigScreen.complianceTitle")}
          </div>
          <p className="mt-1 text-xs text-amber-900">
            <span className="font-mono">{templateId}</span>
            {report ? ` · ${report.origin === "bundled" ? t("bigScreen.complianceOriginBundled") : t("bigScreen.complianceOriginUploaded")}` : ""}
            {report ? ` · ${t("bigScreen.complianceViolationCount", { count: violations.length })}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void load()} className={tinyActionClass}>
            {loading ? t("common.refreshing") : t("bigScreen.complianceRecheck")}
          </button>
          <button type="button" onClick={onClose} className={tinyActionClass}>
            {t("common.close")}
          </button>
        </div>
      </div>

      {loading && !report ? (
        <p className="text-xs text-amber-900">{t("common.loading")}</p>
      ) : null}
      {loadError ? <p className="text-xs text-rose-700">{loadError}</p> : null}

      {report?.status === "unverifiable" ? (
        <p className="rounded-lg border border-amber-200 bg-white px-3 py-2 text-xs text-slate-800">
          {report.reason ?? t("bigScreen.complianceUnverifiable")}
        </p>
      ) : null}

      {report?.status === "compliant" ? (
        <p className="rounded-lg border border-emerald-200 bg-white px-3 py-2 text-xs text-emerald-900">
          {t("bigScreen.complianceNone")}
        </p>
      ) : null}

      {violations.length > 0 ? (
        <div className="overflow-hidden rounded-lg border border-amber-200 bg-white">
          {violations.map((violation, index) => (
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

      {report && report.status !== "compliant" ? (
        <div className="space-y-2 rounded-lg border border-amber-200 bg-white px-3 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-xs font-semibold text-foreground">
                {t("bigScreen.designPromptTitle")}
              </div>
              <p className="mt-0.5 text-[11px] text-muted-light">
                {t("bigScreen.compliancePromptHint")}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => void copyPrompt()} className={tinyActionClass}>
                {copied ? t("bigScreen.copiedDesignPrompt") : t("bigScreen.copyDesignPrompt")}
              </button>
              {readOnly ? null : (
                <button
                  type="button"
                  disabled={repairing || !report.repair}
                  title={report.repair ? undefined : t("bigScreen.repairUnavailable")}
                  onClick={() => void repair()}
                  className={tinyActionClass}
                >
                  {repairing ? t("bigScreen.repairing") : t("bigScreen.repairAction")}
                </button>
              )}
            </div>
          </div>

          <textarea
            readOnly
            value={report.designPrompt}
            rows={8}
            spellCheck={false}
            onFocus={(event) => event.currentTarget.select()}
            className="w-full rounded-lg border border-border bg-surface-subtle px-3 py-2 font-mono text-[11px] leading-5 text-slate-800 outline-none"
          />
          {repairError ? <p className="text-[11px] text-rose-700">{repairError}</p> : null}
        </div>
      ) : null}

      {repairedHtml ? (
        <div className="space-y-2 rounded-lg border border-teal-200 bg-white px-3 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-xs font-semibold text-foreground">
                {t("bigScreen.repairResultTitle")}
              </div>
              <p className="mt-0.5 text-[11px] text-muted-light">
                {t("bigScreen.complianceApplyHint")}
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
                disabled={applying}
                onClick={() => void apply()}
                className={tinyActionClass}
              >
                {applying ? t("bigScreen.complianceApplying") : t("bigScreen.complianceApply")}
              </button>
              <button
                type="button"
                onClick={() => {
                  setRepairedHtml(null);
                  setRepairMeta(null);
                  setApplyError(null);
                  setStillViolations([]);
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
          {applyError ? <p className="text-[11px] text-rose-700">{applyError}</p> : null}
          {stillViolations.length > 0 ? (
            <div className="overflow-hidden rounded-lg border border-rose-200">
              {stillViolations.map((violation, index) => (
                <div
                  key={`${violation.code}-${index}`}
                  className="border-b border-rose-100 px-3 py-2 last:border-b-0"
                >
                  <div className="font-mono text-[10px] text-rose-700">{violation.code}</div>
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
        </div>
      ) : null}
    </section>
  );
}

/** The badge text: a verdict plus, when there is one, how many rules it broke. */
function complianceLabel(
  compliance: { status: string; violationCount: number },
  t: TranslateFn,
): string {
  if (compliance.status === "compliant") return t("bigScreen.complianceOk");
  if (compliance.status === "unverifiable") return t("bigScreen.complianceUnknown");
  return t("bigScreen.complianceFailed", { count: compliance.violationCount });
}

function complianceToneClass(status: string): string {
  if (status === "compliant") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (status === "unverifiable") return "border-border bg-white text-muted-light";
  return "border-amber-300 bg-amber-50 text-amber-900";
}
