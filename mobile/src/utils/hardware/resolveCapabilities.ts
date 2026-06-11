import {Capabilities, DeviceTypes, getModelCapabilities} from "@/../../cloud/packages/types/src"
import {useGlassesStore} from "@/stores/glasses"

/**
 * The dev-only Remote Glasses (Harness) wearable (RemoteHarness.kt) proxies
 * REAL glasses held by the mentra-agent harness daemon. Its model name is not
 * in the capabilities table, so a naive lookup resolves to NONE and every
 * hardware gate fails even though working hardware is attached.
 */
export const REMOTE_HARNESS_WEARABLE = "Remote Glasses (Harness)"

/**
 * Resolve hardware capabilities for the paired wearable. For the harness
 * wearable, the driver reports the family it actually holds (g1/g2/live) via
 * the glasses store's deviceModel, so capabilities reflect the real remote
 * hardware; until the daemon reports, fall back to Simulated Glasses rather
 * than NONE so dev flows aren't gated.
 */
export function resolveWearableCapabilities(wearable: string): Capabilities {
  if (wearable === REMOTE_HARNESS_WEARABLE) {
    const live = useGlassesStore.getState().deviceModel
    return getModelCapabilities((live as DeviceTypes) || DeviceTypes.SIMULATED)
  }
  return getModelCapabilities(wearable as DeviceTypes)
}
