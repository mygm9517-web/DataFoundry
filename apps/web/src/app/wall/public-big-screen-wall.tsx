"use client";
import type { BigScreenDto } from "../../lib/config-api";
import { BigScreenView } from "../bigscreen/components/BigScreenView";
import { LocaleProvider } from "../../i18n/locale-context";
export function PublicBigScreenWall({screen}:{screen:BigScreenDto}) {
  return <LocaleProvider><BigScreenView screen={screen} className="h-dvh w-full" /></LocaleProvider>;
}
