/**
 * Shared types and constants across client/ and webview/.
 *
 * Plain TypeScript. No framework magic.
 */

/**
 * Approximate character width of the glasses HUD line.
 * Used to break captions into lines for both the glasses display
 * and the webview preview that mimics the HUD.
 *
 * Real apps tune this per glasses model. We use one value for the
 * example to keep the demo focused on the structural argument.
 */
export const CHARS_PER_LINE = 30

export interface AppState {
  /** Latest transcript text from the microphone. */
  transcript: string

  /** How many lines of captions to show on the HUD. 2 to 5. */
  displayLines: number

  /**
   * Formatted lines, ready to render. Same content goes to the glasses
   * HUD and the webview preview, so the preview always matches what the
   * user sees on the glasses.
   */
  preview: string[]
}
