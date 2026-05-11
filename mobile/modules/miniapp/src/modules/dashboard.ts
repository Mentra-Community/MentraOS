/**
 * @fileoverview DashboardAPI — noop surface in v1.
 *
 * Deferred per Phase 2.14. The cloud DashboardManager owns widget rendering
 * in OS-ranked rotation. Keeping the API shape so miniapps compile, but calls
 * are noop + console.warn.
 */

import {MiniappRequestType} from "../protocol"
import {MiniappSession} from "../session"

export type DashboardMode = "main" | "expanded" | "always_on"

export class DashboardAPI {
  private warned = false

  constructor(private readonly session: MiniappSession) {}

  setContent(mode: DashboardMode, content: string): void {
    if (!this.warned) {
      console.warn("[@mentra/miniapp] dashboard.setContent() is deferred in v1 (see Phase 2.14).")
      this.warned = true
    }
    // Still forward so the phone can log/ignore consistently.
    this.session.sendOneShot({
      type: MiniappRequestType.DASHBOARD_CONTENT_UPDATE,
      mode,
      content,
    })
  }
}
