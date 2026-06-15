/**
 * NotificationManager - Handles phone notifications for context
 *
 * Stores recent notifications from the user's phone
 * that can be passed to the AI for context.
 */

import type { User } from "../session/User";

/**
 * Maximum number of notifications to keep
 */
const MAX_NOTIFICATIONS = 20;

/**
 * Maximum age of notifications (5 minutes)
 */
const MAX_NOTIFICATION_AGE_MS = 5 * 60 * 1000;

/**
 * A stored notification
 */
interface StoredNotification {
  data: unknown;  // Raw notification data from SDK (structure unknown)
  timestamp: number;
}

/**
 * NotificationManager — stores and manages phone notifications for a single user.
 */
export class NotificationManager {
  private notifications: StoredNotification[] = [];

  constructor(private user: User) {}

  /**
   * Add a notification (or array of notifications)
   * Called when SDK pushes phone notifications
   */
  addNotification(notification: unknown): void {
    const stored: StoredNotification = {
      data: notification,
      timestamp: Date.now(),
    };

    this.notifications.push(stored);

    // Trim to max size
    if (this.notifications.length > MAX_NOTIFICATIONS) {
      this.notifications = this.notifications.slice(-MAX_NOTIFICATIONS);
    }

    console.log(`📱 Notification received for ${this.user.userId} (${this.notifications.length} stored)`);
  }

  /**
   * Add multiple notifications at once
   */
  addNotifications(notifications: unknown[]): void {
    for (const notification of notifications) {
      this.addNotification(notification);
    }
  }

  /**
   * Get recent notifications (filtered by age)
   * @param limit Maximum number to return
   */
  getRecentNotifications(limit: number = 5): unknown[] {
    const now = Date.now();

    // Filter by age and get most recent
    const recent = this.notifications
      .filter(n => (now - n.timestamp) < MAX_NOTIFICATION_AGE_MS)
      .slice(-limit)
      .map(n => n.data);

    return recent;
  }

  /**
   * Format notifications for prompt context
   * Uses JSON.stringify since notification structure is unknown
   */
  formatForPrompt(limit: number = 5): string {
    const recent = this.getRecentNotifications(limit);

    if (recent.length === 0) {
      return "No recent notifications.";
    }

    try {
      return `Recent notifications:\n${JSON.stringify(recent, null, 2)}`;
    } catch {
      return "Unable to format notifications.";
    }
  }

  /**
   * Check if there are any recent notifications
   */
  hasNotifications(): boolean {
    const now = Date.now();
    return this.notifications.some(n => (now - n.timestamp) < MAX_NOTIFICATION_AGE_MS);
  }

  /**
   * Clear old notifications (housekeeping)
   */
  cleanupOld(): void {
    const now = Date.now();
    const before = this.notifications.length;
    this.notifications = this.notifications.filter(
      n => (now - n.timestamp) < MAX_NOTIFICATION_AGE_MS
    );
    const removed = before - this.notifications.length;
    if (removed > 0) {
      console.log(`🗑️ Cleaned up ${removed} old notifications for ${this.user.userId}`);
    }
  }

  /**
   * Clear all notifications
   */
  clear(): void {
    this.notifications = [];
  }

  /**
   * Clean up (called on session end)
   */
  destroy(): void {
    this.clear();
    console.log(`🗑️ NotificationManager cleaned up for ${this.user.userId}`);
  }
}
