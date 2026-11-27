/**
 * The one choice of what to install from a miniapp URL: the URL updater, the Fleet reconciler's resolution and
 * `installMiniapp` all make it here, so a pin holds whichever of them reads the URL.
 */
import {
  selectMiniappTarget,
  type MiniappBuild,
  type MiniappPin,
  type MiniappPinUnmetReason,
  type ServedMiniappManifest,
} from "@mentra/cloud-protocol/miniapp-url"

import {miniappPins, type MiniappPinReader} from "./miniappPins"

export type MiniappInstallTarget =
  /**
   * The build to hold. `pinned`: a pin chose it, from `versions`. The served file's top-level fields
   * (`minHostVersion`, `minApiLevel`, `hardwareRequirements`) describe the latest build, not this one, so a pinned
   * build's compatibility is known only from its ZIP's own `miniapp.json`, which the installer checks.
   */
  | {ok: true; build: MiniappBuild; pinned: boolean}
  /** The pin can't be met: nothing installs, and what is installed stays. */
  | {ok: false; reason: MiniappPinUnmetReason; pin: MiniappPin}

/**
 * The build `packageName` should hold, from what its URL serves now: `bundle`, or with a pin, the pinned version's
 * `versions` entry while its hash is the pin's (`selectMiniappTarget`, where the seal is checked). The build's `url`
 * is as served: relative to where `miniapp.json` was served from, or absolute. Pass no reader where a pin has no
 * effect.
 */
export function selectInstallTarget(
  packageName: string,
  served: Pick<ServedMiniappManifest, "version" | "bundle" | "versions">,
  pinFor: MiniappPinReader | null = miniappPins.pinFor,
): MiniappInstallTarget {
  const pin = pinFor?.(packageName) ?? null
  const selection = selectMiniappTarget(served, pin)
  if (!selection.ok) return {ok: false, reason: selection.reason, pin: pin!}
  return {ok: true, build: selection.target, pinned: pin !== null}
}
