import {SETTINGS, engine} from "@mentra/engine"

import {shouldHideMiniapp as shouldHideByPolicy} from "@/constants/miniapps"

/** Read on every decision so installation and debug UI changes share one policy. */
export const shouldHideMiniapp = (packageName: string): boolean =>
  shouldHideByPolicy(packageName, undefined, engine.settings.get(SETTINGS.show_mentra_call_ios.key) === true)
