/**
 * @fileoverview DashboardAPI — deferred dashboard rendering surface.
 *
 * setContent warns once per instance and sends a fire-and-forget message.
 * The local runtime does not implement dashboard rendering. It sends no reply
 * without a request ID; requests with an ID receive NOT_IMPLEMENTED.
 */

import {MiniappRequestType} from "../protocol"
import {MiniappSession} from "../session"

export type DashboardMode = "main" | "expanded" | "always_on"

export class DashboardAPI {
  private warned = false

  constructor(private readonly session: MiniappSession) {}

  setContent(mode: DashboardMode, content: string): void {
    if (!this.warned) {
      console.warn("[@mentra/miniapp] dashboard.setContent() is deferred in v1.")
      this.warned = true
    }
    // No request ID: the runtime ignores this update without sending a result.
    this.session.sendOneShot({
      type: MiniappRequestType.DASHBOARD_CONTENT_UPDATE,
      mode,
      content,
    })
  }
}
