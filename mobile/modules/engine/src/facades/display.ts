/**
 * display facade — `engine.display`: the host/OEM display surface. `mirror`
 * exposes the mirrored-view read-model; `text`/`clear` are raw passthroughs to the
 * glasses display for dev tools and escape-hatch use (normal rendering goes through
 * the engine DisplayProcessor / layout system, not these).
 */
import BluetoothSdk from "@mentra/bluetooth-sdk"
import {displayMirror} from "./displayMirror"

export const display = {
  /** Mirrored-view read-model (current/onMirror/view/setView). */
  mirror: displayMirror,
  /** Write raw text to the glasses display at (x, y) with a font size. */
  text: (...args: Parameters<typeof BluetoothSdk.displayText>) => BluetoothSdk.displayText(...args),
  /** Clear the glasses display. */
  clear: (): Promise<void> => BluetoothSdk.clearDisplay(),
}
