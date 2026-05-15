/**
 * @fileoverview LedModule — glasses RGB LED control.
 *
 * API mirrors the cloud SDK's LED module. Colors are named strings
 * (the phone maps them to per-device LED indices). Actions are "on" / "off".
 */

import {MiniappRequestType} from "../protocol"
import {MiniappSession} from "../session"

export type LedColor = "red" | "green" | "blue" | "orange" | "white"

export interface LedControlOptions {
  color?: LedColor
  /** LED on duration in ms. */
  ontime?: number
  /** LED off duration in ms. */
  offtime?: number
  /** Number of on/off cycles. */
  count?: number
}

export class LedModule {
  constructor(private readonly session: MiniappSession) {}

  /** Turn an LED on with the given pattern. */
  async turnOn(options: LedControlOptions = {}): Promise<void> {
    this.session.sendOneShot({
      type: MiniappRequestType.RGB_LED,
      action: "on",
      color: options.color ?? "red",
      ontime: options.ontime ?? 1000,
      offtime: options.offtime ?? 0,
      count: options.count ?? 1,
    })
  }

  /** Turn all LEDs off. */
  async turnOff(): Promise<void> {
    this.session.sendOneShot({
      type: MiniappRequestType.RGB_LED,
      action: "off",
    })
  }

  /** Blink pattern — repeats `count` times with ontime/offtime. */
  async blink(color: LedColor, ontime: number, offtime: number, count: number): Promise<void> {
    return this.turnOn({color, ontime, offtime, count})
  }

  /** Solid LED for a fixed duration. */
  async solid(color: LedColor, duration: number): Promise<void> {
    return this.turnOn({color, ontime: duration, offtime: 0, count: 1})
  }
}
