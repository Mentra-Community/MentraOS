/**
 * @fileoverview InputModule — physical control events on the glasses.
 *
 * Combines button + touch surfaces. Future input modes (gesture, voice
 * command, eye tracking) will extend this module rather than spawning new
 * top-level modules.
 *
 * Touch overloads mirror cloud SDK v3's `device.onTouchEvent`:
 *
 *   session.input.onTouch(handler)
 *   session.input.onTouch("click", handler)
 *   session.input.onTouch(["scroll_top", "scroll_bottom"], handler)
 *
 * Per-gesture filtering rides on `touch_event:<gesture>` stream variants
 * the phone runtime fans out alongside the bare `touch_event` stream.
 */

import {MiniappStreamType} from "../protocol"
import {MiniappSession} from "../session"
import type {ButtonPressData, TouchData, UnsubscribeFn} from "./events"

export class InputModule {
  constructor(private readonly session: MiniappSession) {}

  onButtonPress(handler: (data: ButtonPressData) => void): UnsubscribeFn {
    return this.session._subscribe(MiniappStreamType.BUTTON_PRESS, handler as (data: unknown) => void)
  }

  /**
   * Subscribe to touch events.
   *
   *   onTouch(handler)             — all touch events
   *   onTouch("click", handler)    — only "click"
   *   onTouch(["a","b"], handler)  — multiple gestures, single subscription
   */
  onTouch(handler: (data: TouchData) => void): UnsubscribeFn
  onTouch(gesture: string, handler: (data: TouchData) => void): UnsubscribeFn
  onTouch(gestures: string[], handler: (data: TouchData) => void): UnsubscribeFn
  onTouch(
    gestureOrHandler: string | string[] | ((data: TouchData) => void),
    maybeHandler?: (data: TouchData) => void,
  ): UnsubscribeFn {
    // Plain handler — subscribe to all touches.
    if (typeof gestureOrHandler === "function") {
      return this.session._subscribe(
        MiniappStreamType.TOUCH_EVENT,
        gestureOrHandler as (data: unknown) => void,
      )
    }

    const handler = maybeHandler!
    const gestures = Array.isArray(gestureOrHandler) ? gestureOrHandler : [gestureOrHandler]
    if (gestures.length === 0) return () => {}

    const unsubs: UnsubscribeFn[] = []
    for (const g of gestures) {
      unsubs.push(
        this.session._subscribe(`${MiniappStreamType.TOUCH_EVENT}:${g}`, handler as (data: unknown) => void),
      )
    }
    return () => {
      for (const u of unsubs) {
        try {
          u()
        } catch {
          /* ignore */
        }
      }
    }
  }
}
