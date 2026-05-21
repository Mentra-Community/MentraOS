/**
 * @fileoverview ImuModule — head position + motion events.
 *
 * Glasses' inertial measurement unit. V1 exposes head-up/down position only;
 * acceleration / orientation events are wire-protocol future work.
 */

import {MiniappStreamType} from "../protocol"
import {MiniappSession} from "../session"
import type {HeadPositionData, UnsubscribeFn} from "./events"

export class ImuModule {
  constructor(private readonly session: MiniappSession) {}

  onHeadPosition(handler: (data: HeadPositionData) => void): UnsubscribeFn {
    return this.session._subscribe(MiniappStreamType.HEAD_POSITION, handler as (data: unknown) => void)
  }
}
