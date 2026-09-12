/**
 * Which miniapp stream subscriptions claim the glasses' double-tap gesture.
 *
 * Double-tap is shared between miniapps and the glasses' native dashboard
 * shortcut (G2 opens its dashboard on double-tap when `use_native_dashboard`
 * is on). A miniapp that listens for touches — every gesture via the bare
 * `touch_event` stream, or `double_tap` via its per-gesture stream — owns the
 * gesture while subscribed; the runtime pushes that claim to native so the
 * shortcut decision stays on the glasses side. Pure so it can be tested apart
 * from the runtime.
 */
import {MiniappStreamType} from "@mentra/miniapp"

export const DOUBLE_TAP_STREAM = `${MiniappStreamType.TOUCH_EVENT}:double_tap`

export function claimsDoubleTap(subscribedStreams: Iterable<string>): boolean {
  for (const stream of subscribedStreams) {
    if (stream === MiniappStreamType.TOUCH_EVENT || stream === DOUBLE_TAP_STREAM) return true
  }
  return false
}
