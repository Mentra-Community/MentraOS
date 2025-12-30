/**
 * Settings API routes for Line Width Debug Tool
 *
 * Placeholder for future settings functionality.
 * Currently minimal since this is a debug tool.
 */

export const settingsRoutes = {
  // Placeholder settings endpoint
  "/api/settings": {
    async GET(_req: Request) {
      return Response.json({
        maxPixelWidth: 428,
        defaultGlyphWidth: 5,
        formula: "(glyph_width + 1) * 2",
      })
    },
  },
}
