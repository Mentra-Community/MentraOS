import {G1_PROFILE} from "./g1"
import type {DisplayProfile} from "./types"

/**
 * G2 uses G1's font metrics, but its retained-container display exposes a
 * 576x288 drawable canvas and a hardware-calibrated 40px text line height.
 */
export const G2_PROFILE: DisplayProfile = {
  ...G1_PROFILE,
  id: "even-realities-g2",
  name: "Even Realities G2",
  displayHeightPx: 288,
  maxLines: 8,
  lineHeightPx: 40,
}
