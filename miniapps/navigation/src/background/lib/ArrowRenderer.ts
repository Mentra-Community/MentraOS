/**
 * ArrowRenderer — rasterizes a turn-direction arrow into a 1-bit BMP for the
 * glasses HUD's left "arrow" slot.
 *
 * Dependency-free (runs in the background JSContext). Draws a canonical
 * up-pointing arrow (filled shaft + head) and rotates it to the maneuver
 * direction by sampling each output pixel in arrow-local space. Polarity
 * matches MinimapRenderer: feature = 255 (BOLD), background = 0, so it survives
 * the phone's invert + dither the same way the minimap does.
 */

import {encodeBmpBase64} from "./bmp"

const BG = 0
const INK = 255

/**
 * Clockwise angle (radians, 0 = up) for a maneuver. Accepts either the arrow
 * glyph the HUD already computes (↑ ↗ → …) or a Mapbox-style maneuver string
 * ("turn-left", "TURN_RIGHT", "uturn", "slight left", …). Unknown → straight up.
 */
export function maneuverAngleRad(maneuver: string | null | undefined): number {
  const deg = maneuverAngleDeg(maneuver)
  return (deg * Math.PI) / 180
}

function maneuverAngleDeg(maneuver: string | null | undefined): number {
  if (!maneuver) return 0
  const m = maneuver.toLowerCase()

  // Arrow glyphs the HUD already uses.
  if (maneuver.includes("↑")) return 0
  if (maneuver.includes("↗")) return 45
  if (maneuver.includes("→")) return 90
  if (maneuver.includes("↘")) return 135
  if (maneuver.includes("↓")) return 180
  if (maneuver.includes("↙")) return 225
  if (maneuver.includes("←")) return 270
  if (maneuver.includes("↖")) return 315
  if (maneuver.includes("↩") || maneuver.includes("⤵")) return 180 // u-turn

  // Text maneuver descriptors.
  if (m.includes("uturn") || m.includes("u-turn")) return 180
  const slight = m.includes("slight")
  const sharp = m.includes("sharp")
  if (m.includes("left")) return slight ? 315 : sharp ? 225 : 270
  if (m.includes("right")) return slight ? 45 : sharp ? 135 : 90
  return 0 // straight / depart / continue / arrive
}

/** Is (lx, ly) inside the canonical up-pointing arrow drawn in an S×S box? */
function insideUpArrow(lx: number, ly: number, s: number): boolean {
  const tipY = -0.42 * s // arrowhead tip (up)
  const headBaseY = -0.04 * s // where the head meets the shaft
  const headHalf = 0.3 * s // half-width of the head at its base
  const shaftHalf = 0.11 * s
  const shaftTopY = -0.12 * s
  const shaftBotY = 0.42 * s

  // Head: triangle tapering from the base up to the tip.
  if (ly >= tipY && ly <= headBaseY) {
    const t = (ly - tipY) / (headBaseY - tipY) // 0 at tip → 1 at base
    if (Math.abs(lx) <= headHalf * t) return true
  }
  // Shaft: rectangle.
  if (ly >= shaftTopY && ly <= shaftBotY && Math.abs(lx) <= shaftHalf) return true
  return false
}

/**
 * Render a `size`×`size` arrow BMP pointing in the maneuver's direction.
 * Returns a base64 BMP for a `session.display.render()` image element.
 */
export function renderManeuverArrowBmp(maneuver: string | null | undefined, size = 40): string {
  const s = Math.max(8, Math.round(size))
  const gray = new Uint8Array(s * s).fill(BG)
  const c = (s - 1) / 2
  const theta = maneuverAngleRad(maneuver)
  const cosT = Math.cos(theta)
  const sinT = Math.sin(theta)

  for (let py = 0; py < s; py++) {
    for (let px = 0; px < s; px++) {
      const dx = px - c
      const dy = py - c
      // Rotate the sample point by -theta into arrow-local space (y-down screen
      // coords): theta measured clockwise from up, so theta=90 points right.
      const lx = dx * cosT + dy * sinT
      const ly = -dx * sinT + dy * cosT
      if (insideUpArrow(lx, ly, s)) gray[py * s + px] = INK
    }
  }
  return encodeBmpBase64(gray, s, s)
}
