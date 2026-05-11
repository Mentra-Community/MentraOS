/**
 * @fileoverview useSafeArea — React hook exposing the host's safe-area insets
 * and the capsule menu rect to miniapp UIs.
 *
 * The host injects these via window.MentraOS before content loads. This hook
 * reads them once at mount — they don't currently change at runtime (the host
 * would have to force a reload to update them, e.g. on orientation change).
 */

import {useState} from "react"

import {
  getMentraOSGlobals,
  type MiniappCapsuleMenuRect,
  type MiniappSafeAreaInsets,
} from "../globals"

const EMPTY_INSETS: MiniappSafeAreaInsets = {top: 0, bottom: 0, left: 0, right: 0}

export interface UseSafeAreaResult {
  /** Pixel insets around the WebView content. Apply as padding on your root element. */
  insets: MiniappSafeAreaInsets
  /**
   * Bounding rect of the host's floating capsule menu (top-right overlay).
   * Null when the host doesn't render one (e.g. older builds). Use this to
   * avoid placing clickable content underneath the menu.
   */
  capsuleMenu: MiniappCapsuleMenuRect | null
}

export function useSafeArea(): UseSafeAreaResult {
  const [result] = useState<UseSafeAreaResult>(() => {
    const globals = getMentraOSGlobals()
    return {
      insets: globals.safeAreaInsets ?? EMPTY_INSETS,
      capsuleMenu: globals.capsuleMenu ?? null,
    }
  })
  return result
}
