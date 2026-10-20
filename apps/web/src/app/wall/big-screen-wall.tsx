"use client";

import { use, useEffect, useState } from "react";
import { useT } from "../../i18n/locale-context";
import type { BigScreenDto } from "../../lib/config-api";
import { configApi } from "../../lib/config-api";
import { BigScreenView } from "../bigscreen/components/BigScreenView";

/**
 * Full-bleed wall for one saved screen: `/wall/<id>`.
 *
 * The console can only show a wall in a box at the bottom of an editor pane,
 * which is not what a screen is for — it goes on a TV in the corner. This renders
 * the same `BigScreenView` the console previews with, with nothing around it, so
 * what an operator checks in the console is literally what the wall runs.
 *
 * Under `/wall` rather than `/bigscreen/wall`: `/bigscreen/[...path]` already
 * claims that prefix for template files, and two dynamic segments would both
 * match `/bigscreen/wall/<id>` — a route conflict Next resolves by refusing to
 * build.
 *
 * The screen is read from the list rather than through a `getBigScreen(id)`
 * endpoint, because there isn't one; adding an API route for a read the console
 * already performs on every open would be surface for its own sake.
 */
export function BigScreenWall({ id }: { id: string }) {
  const t = useT();
  const [screen, setScreen] = useState<BigScreenDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const screens = await configApi.listBigScreens();
        if (cancelled) return;
        setScreen(screens.find((entry) => entry.id === id) ?? null);
      } catch (loadError) {
        if (cancelled) return;
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  // `h-dvh`, not `h-screen`: a wall opened on a phone should not sit under the
  // browser chrome that `100vh` counts.
  if (screen) return <BigScreenView screen={screen} className="h-dvh w-full" />;

  return (
    <div className="flex h-dvh w-full items-center justify-center bg-[#070b16] px-6 text-center">
      <p className="text-sm text-slate-300">
        {loading
          ? t("bigScreen.loading")
          : error
            ? t("bigScreen.loadFailed", { message: error })
            : t("bigScreen.wallMissing", { id })}
      </p>
    </div>
  );
}

export function BigScreenWallRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <BigScreenWall id={id} />;
}
