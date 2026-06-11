/**
 * @fileoverview ImuModule — head position + motion events.
 *
 * Glasses' inertial measurement unit. Exposes head-up/down position and a
 * raw accelerometer stream (`onAccel`). Gyroscope / magnetometer / fused
 * orientation are future work — when added they'll surface as a combined IMU
 * event rather than extending this single-sensor accel stream.
 */

import {MiniappRequestType, MiniappStreamType} from "../protocol"
import {MiniappSession} from "../session"
import type {AccelData, HeadPositionData, UnsubscribeFn} from "./events"

export class ImuModule {
  constructor(private readonly session: MiniappSession) {}

  onHeadPosition(handler: (data: HeadPositionData) => void): UnsubscribeFn {
    return this.session._subscribe(MiniappStreamType.HEAD_POSITION, handler as (data: unknown) => void)
  }

  /**
   * Subscribe to raw accelerometer readings (`{x, y, z}` in g) from the
   * glasses IMU. G2 only today; on glasses without an exposed IMU stream the
   * subscription succeeds but no events fire.
   */
  onAccel(handler: (data: AccelData) => void): UnsubscribeFn {
    return this.session._subscribe(MiniappStreamType.ACCEL_DATA, handler as (data: unknown) => void)
  }

  /**
   * Explicitly enable or disable raw accelerometer streaming on the glasses.
   *
   * Subscribing via `onAccel` already auto-enables the sensor and unsubscribing
   * disables it, so most callers don't need this. Use it when you want to drive
   * the IMU directly — e.g. a diagnostic toggle. G2 only today; a no-op on
   * glasses without an exposed IMU stream.
   */
  setEnabled(enabled: boolean): Promise<void> {
    return this.session.sendRequest<void>({
      type: MiniappRequestType.IMU_SET_ENABLED,
      enabled,
    })
  }
}
