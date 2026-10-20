"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../../i18n/locale-context";
import type { BigScreenDto } from "../../../lib/config-api";
import { configApi } from "../../../lib/config-api";
import {
  EMPTY_BIG_SCREEN_FETCH_STATE,
  type BigScreenFetchState,
  applyBigScreenFetchResult,
  isLatestBigScreenRequest,
  nextBigScreenPollAt,
  resolveBigScreenRefreshMs,
} from "../../data-tasks/big-screen-data-loop";
import {
  BIG_SCREEN_BRIDGE_PAYLOAD,
  BIG_SCREEN_BRIDGE_READY,
  buildBigScreenBridgeMessage,
  isBigScreenBridgeRequest,
  withEmbedParam,
} from "../../data-tasks/big-screen-runtime";
import {
  getBigScreenTemplate,
  DEFAULT_BIG_SCREEN_REFRESH_MS,
  HOUR_MS,
  refreshMsToHours,
} from "../../data-tasks/big-screen-templates";
import { panelShellClass } from "../../data-tasks/ui-tokens";

type BigScreenViewProps = {
  screen: BigScreenDto;
  /** Overrides the screen's own cadence, e.g. zero while the editor is typing. */
  refreshMs?: number;
  /** Held false while the definition is unsaved, so the wall keeps its last good data. */
  live?: boolean;
  className?: string;
};

/**
 * Renders a saved big screen and keeps it fed.
 *
 * The template runs in a sandboxed iframe and never talks to the API: it asks
 * for its data file over `postMessage`, and this component answers with the
 * payload the backend built from the screen's SQL. That keeps a template
 * openable as a plain file when the console is not running, and keeps the
 * datasource — and every other screen's data — unreachable from inside the frame.
 *
 * Polling pauses while the tab is hidden, so a wall left open overnight does not
 * keep querying a datasource nobody is watching.
 */
export function BigScreenView({
  screen,
  refreshMs,
  live = true,
  className,
}: BigScreenViewProps) {
  const t = useT();
  const template = useMemo(() => getBigScreenTemplate(screen.templateId), [screen.templateId]);
  const [state, setState] = useState<BigScreenFetchState>(EMPTY_BIG_SCREEN_FETCH_STATE);
  const [visible, setVisible] = useState(true);
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  // Windows this component's frame has appeared as. A message can only be answered
  // if its `source` is one of them, but `source` is not guaranteed to be the same
  // object as a fresh `contentWindow` read — some engines hand back a new proxy per
  // access, and an identity test against it then rejects the frame's own traffic.
  // Membership in this set is the same check without that assumption.
  const frameWindows = useRef(new WeakSet<Window>());

  // Serialized payload last pushed into the frame. Declared here because the
  // bridge handler below clears it when the frame reboots.
  const pushedJsonRef = useRef<string | null>(null);

  // Latest state, for the message handler: a frame can ask for data at any time,
  // and re-subscribing that listener on every poll would miss requests that land
  // in the gap.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Which poll is newest, and which screen it belongs to. Held in refs because a
  // late response has to be judged against the request it answers rather than
  // against a re-rendered closure.
  const requestSeq = useRef(0);
  const screenKey = `${screen.ownerId ?? ""}:${screen.id}:${screen.revision}`;
  const screenKeyRef = useRef(screenKey);

  const post = useCallback((message: unknown) => {
    // `*` because the frame is same-origin in the console and opaque-origin when
    // a template is opened on its own; the payload is the screen's own data.
    frameRef.current?.contentWindow?.postMessage(message, "*");
  }, []);

  // Resolves to how long the server keeps sharing this answer (`refreshInMs`).
  const fetchData = useCallback(async (): Promise<number | undefined> => {
    if (!live) return undefined;
    const seq = ++requestSeq.current;
    const key = screenKey;

    try {
      const payload = screen.publicDataUrl
        ? await fetch(screen.publicDataUrl, {cache:"no-store"}).then(async response => {
          const envelope=await response.json();
          if(!response.ok || !envelope.success)throw new Error(envelope.error?.message ?? "读取大屏数据失败");
          return envelope.data as import("../../../lib/config-api").BigScreenDataDto;
        })
        : await configApi.getBigScreenData(screen.id);
      // A slower earlier poll must not roll the wall backwards, and a response
      // for a screen the user has since switched away from must not land at all.
      if (!isLatestBigScreenRequest(seq, requestSeq.current) || screenKeyRef.current !== key) return undefined;
      setState((previous) => applyBigScreenFetchResult(previous, { ok: true, payload }, Date.now()));
      return payload.refreshInMs;
    } catch (error) {
      if (!isLatestBigScreenRequest(seq, requestSeq.current) || screenKeyRef.current !== key) return undefined;
      const message = error instanceof Error ? error.message : String(error);
      setState((previous) =>
        applyBigScreenFetchResult(previous, { ok: false, error: message }, Date.now()),
      );
      return undefined;
    }
  }, [live, screen.id, screenKey, screen.publicDataUrl]);

  // Answer the template's data requests — the only data path it has.
  useEffect(() => {
    // The frame may already be mounted (this effect can run after its load event),
    // so seed the set before listening.
    const seed = frameRef.current?.contentWindow;
    if (seed) frameWindows.current.add(seed);

    const onMessage = (event: MessageEvent) => {
      // Same-origin console plus any frame the user may have open elsewhere:
      // only this frame's traffic is ours to answer.
      if (!frameWindows.current.has(event.source as Window)) return;

      if ((event.data as { type?: string } | null)?.type === BIG_SCREEN_BRIDGE_READY) {
        // The frame booted; its fetch is already parked. Poll now so the first
        // paint carries live numbers rather than waiting out a full cadence.
        // A freshly booted frame is back on its demo data, so the answer is
        // pushed even when it matches what the previous load was given.
        pushedJsonRef.current = null;
        void fetchData();
        return;
      }

      if (!isBigScreenBridgeRequest(event.data)) return;

      const { requestId } = event.data;
      const current = stateRef.current;
      post(
        current.error != null
          ? buildBigScreenBridgeMessage(requestId, { ok: false, error: current.error })
          : buildBigScreenBridgeMessage(requestId, { ok: true, payload: current.data }),
      );
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [fetchData, post]);

  // The stored value is read on the same whole-hour grid the API runs SQL on. A
  // screen saved under the old millisecond bounds (e.g. 300000) would otherwise
  // poll every five minutes, re-pushing the same answer and restarting every
  // table's scroll, while the server only reruns its SQL once an hour.
  const cadence = resolveBigScreenRefreshMs(
    refreshMs,
    screen.refreshMs === undefined ? undefined : refreshMsToHours(screen.refreshMs) * HOUR_MS,
    DEFAULT_BIG_SCREEN_REFRESH_MS,
  );

  // Switching screens (or reloading an edited one) starts clean: the old data
  // belongs to a different SQL definition.
  useEffect(() => {
    screenKeyRef.current = screenKey;
    requestSeq.current += 1;
    stateRef.current = EMPTY_BIG_SCREEN_FETCH_STATE;
    setState(EMPTY_BIG_SCREEN_FETCH_STATE);
  }, [screenKey]);

  useEffect(() => {
    if (!visible || !live) return;
    // A timer longer than 2^31-1 ms (about 24.8 days) overflows and fires at
    // once, over and over — a monthly screen would query nonstop. Long intervals
    // are therefore walked in capped steps against the real due time.
    const MAX_TIMER_MS = 2_147_483_647;
    let cancelled = false;
    let dueAt = Date.now() + cadence;
    let timer: number;
    const poll = async () => {
      const refreshInMs = await fetchData();
      if (!cancelled) dueAt = nextBigScreenPollAt(refreshInMs, cadence, Date.now());
    };
    // Waking the tab asks straight away; the server answers from its cache when
    // the interval has not lapsed, so this costs no query.
    void poll();
    const arm = () => {
      timer = window.setTimeout(() => {
        if (Date.now() >= dueAt) {
          dueAt = Date.now() + cadence;
          void poll();
        }
        arm();
      }, Math.min(Math.max(dueAt - Date.now(), 1000), MAX_TIMER_MS));
    };
    arm();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [cadence, fetchData, live, visible]);

  // A bound template — one that keeps its data in a page global rather than
  // fetching a data file — gets the payload pushed at it. It already received the
  // first one through its parked fetch; every later poll lands here, so the screen
  // keeps advancing instead of freezing on the frame it booted with. Templates
  // without a binding ignore this: their bridge only resolves request ids they
  // minted themselves.
  //
  // An uploaded page is not in the bundled registry, so `template` is undefined
  // for it — yet it is exactly the case that needs the push: it has no data file
  // to park a fetch on, and its binding comes from the upload manifest the
  // serving route injected into the frame. A frame without a binding drops the
  // push, so sending it to any page outside the registry is safe.
  //
  // Only new data is pushed. Waking the tab or a poll inside the server's shared
  // interval hands back the answer the frame already shows, and re-applying it
  // would restart a table that had scrolled to its end and stopped.
  const pushedRef = useRef<BigScreenFetchState>(EMPTY_BIG_SCREEN_FETCH_STATE);
  useEffect(() => {
    if (template != null && template.binding == null) return;
    if (state.updatedAt == null || state.error != null) return;
    if (state.updatedAt === pushedRef.current.updatedAt) return;
    pushedRef.current = state;
    const json = JSON.stringify(state.data);
    if (json === pushedJsonRef.current) return;
    pushedJsonRef.current = json;
    post({ type: BIG_SCREEN_BRIDGE_PAYLOAD, payload: state.data });
  }, [post, state, template]);

  // Switching or re-saving the screen reloads the frame onto its demo data, so
  // the next answer must be pushed even if it is unchanged.
  useEffect(() => {
    pushedJsonRef.current = null;
  }, [screenKey]);

  useEffect(() => {
    const onVisibility = () => setVisible(document.visibilityState !== "hidden");
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // A failure is only worth surfacing once something has been shown: before the
  // first success the wall is still on the template's bundled demo data, which
  // is not the same claim as "this is stale".
  const stale = state.error != null && state.updatedAt != null;
  const status = stale
    ? t("bigScreen.stale")
    : state.updatedAt == null
      ? t("bigScreen.loading")
      : t("bigScreen.updatedAt", {
          time: new Date(state.updatedAt).toLocaleTimeString(),
        });
  // The poll can succeed while an individual query fails, and that category then
  // quietly renders the template's bundled demo numbers. Name the broken ones
  // rather than let a wall of half-real data look healthy.
  const failedDatasets = state.failedDatasets;

  return (
    <div className={className ?? panelShellClass}>
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <span className="text-sm font-semibold text-foreground">
          {screen.title || screen.name}
        </span>
        <div className="flex items-center gap-2">
          {failedDatasets.length > 0 ? (
            <span
              className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800"
              title={failedDatasets
                .map((dataset) => `${dataset.id}: ${dataset.error}`)
                .join("\n")}
            >
              {t("bigScreen.partialData", { count: failedDatasets.length })}
            </span>
          ) : null}
          <span className="text-[11px] text-muted-light" title={state.error ?? undefined}>
            {status}
          </span>
        </div>
      </div>
      <iframe
        ref={(node) => {
          frameRef.current = node;
          // Registered synchronously at commit. A ref callback runs before the
          // browser can load the frame's document, so the window is already a
          // member by the time the template posts its first message.
          const win = node?.contentWindow;
          if (win) frameWindows.current.add(win);
        }}
        src={withEmbedParam(
          screen.publicPageUrl ?? (template ? `/bigscreen/${screen.templateId}/index.html` : `/bigscreen/${screen.templateId}`),
          screen.id
        )}
        title={screen.title || screen.name}
        // The template is a self-contained chart page, so it needs scripts.
        // `allow-same-origin` keeps its relative asset and data URLs working;
        // it cannot reach the API without credentials, which it has none of.
        sandbox="allow-scripts allow-same-origin"
        className="h-full w-full border-0 bg-[#070b16]"
      />
    </div>
  );
}
