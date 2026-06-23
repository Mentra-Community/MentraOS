/**
 * Map style for the navigation miniapp's Mapbox GL JS map.
 *
 * The Google-era "Retro" `styles[]` array (a paper-map aesthetic) was
 * defined but never actually applied to the map, so the migration drops it
 * rather than hand-converting 24 Google style rules to a Mapbox Style Spec
 * JSON. We use a stock Mapbox style here; to match the old Retro look,
 * author a custom style in Mapbox Studio and swap this URL for the
 * resulting `mapbox://styles/<user>/<id>` (the Studio style is the
 * equivalent of Google's `mapId`).
 *
 * `streets-v12` is the flat classic streets style, which reads cleaner for
 * a top-down nav map than the 3D-leaning `standard`.
 */
export const MAPBOX_STYLE_URL = "mapbox://styles/mapbox/streets-v12"
