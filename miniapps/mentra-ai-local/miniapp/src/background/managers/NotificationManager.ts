/**
 * NotificationManager — stores recent phone notifications for AI context.
 *
 * Fed by session.phone.notifications. Keeps a short, age-bounded window that
 * QueryProcessor formats into the prompt.
 */

const MAX_NOTIFICATIONS = 20
const MAX_NOTIFICATION_AGE_MS = 5 * 60 * 1000 // 5 minutes

interface StoredNotification {
  data: unknown
  timestamp: number
}

export class NotificationManager {
  private notifications: StoredNotification[] = []

  /** Add a notification (called when the SDK pushes one). */
  addNotification(notification: unknown): void {
    this.notifications.push({data: notification, timestamp: Date.now()})
    if (this.notifications.length > MAX_NOTIFICATIONS) {
      this.notifications = this.notifications.slice(-MAX_NOTIFICATIONS)
    }
  }

  /** Recent notifications, age-filtered, most recent last. */
  getRecentNotifications(limit = 5): unknown[] {
    const now = Date.now()
    return this.notifications
      .filter((n) => now - n.timestamp < MAX_NOTIFICATION_AGE_MS)
      .slice(-limit)
      .map((n) => n.data)
  }

  /** Format notifications for prompt context. Structure is provider-defined, so JSON. */
  formatForPrompt(limit = 5): string {
    const recent = this.getRecentNotifications(limit)
    if (recent.length === 0) return "No recent notifications."
    try {
      return `Recent notifications:\n${JSON.stringify(recent, null, 2)}`
    } catch {
      return "Unable to format notifications."
    }
  }

  hasNotifications(): boolean {
    const now = Date.now()
    return this.notifications.some((n) => now - n.timestamp < MAX_NOTIFICATION_AGE_MS)
  }

  clear(): void {
    this.notifications = []
  }

  destroy(): void {
    this.clear()
  }
}
