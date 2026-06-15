import { User } from "../session/User";
import { broadcastChatEvent, clearPendingEvents } from "../api/chat";

/**
 * SessionManager — thin lookup for User objects.
 *
 * Just a Map<userId, User> with getOrCreate/get/remove.
 * All per-user state lives inside the User class itself.
 *
 * Supports a grace period on disconnect: softRemove() detaches the
 * glasses but keeps the User alive for 60s so a quick reconnect
 * preserves conversation history, photos, and all other state.
 */
export class SessionManager {
  private users: Map<string, User> = new Map();
  private pendingRemovals: Map<string, Timer> = new Map();

  /** Get an existing user or create a new one */
  getOrCreate(userId: string): User {
    let user = this.users.get(userId);
    if (!user) {
      user = new User(userId);
      this.users.set(userId, user);
      console.log(`[SessionManager] Created user: ${userId}`);
    }
    return user;
  }

  /** Get an existing user (undefined if not found) */
  get(userId: string): User | undefined {
    return this.users.get(userId);
  }

  /** Clean up and remove a user immediately (hard kill) */
  remove(userId: string): void {
    // Clear any pending grace period timer
    const existingTimer = this.pendingRemovals.get(userId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.pendingRemovals.delete(userId);
    }

    const user = this.users.get(userId);
    if (user) {
      user.cleanup();
      this.users.delete(userId);
      console.log(`[SessionManager] Removed user: ${userId}`);
    }
  }

  /**
   * Soft remove — detach glasses but keep User alive for a grace period.
   * If the user doesn't reconnect within gracePeriodMs, do a full cleanup.
   */
  softRemove(userId: string, gracePeriodMs: number = 60_000): void {
    const user = this.users.get(userId);
    if (!user) return;

    // Detach glasses (kills transcription listeners, nulls appSession)
    user.clearAppSession();

    // Clear any existing grace period timer (prevents stacking on rapid disconnects)
    const existingTimer = this.pendingRemovals.get(userId);
    if (existingTimer) clearTimeout(existingTimer);

    // Start grace period timer
    const timer = setTimeout(() => {
      this.pendingRemovals.delete(userId);

      // Grace period expired — broadcast session_ended and do full cleanup
      broadcastChatEvent(userId, {
        type: "session_ended",
        reason: "grace period expired",
        timestamp: new Date().toISOString(),
      });
      clearPendingEvents(userId);
      this.remove(userId);

      console.log(`[SessionManager] Grace period expired for ${userId}, session destroyed`);
    }, gracePeriodMs);

    this.pendingRemovals.set(userId, timer);
    console.log(`[SessionManager] Soft remove for ${userId}, grace period ${gracePeriodMs / 1000}s`);
  }

  /**
   * Cancel a pending grace period removal (called on reconnect).
   * Returns true if a pending removal was cancelled (= this is a reconnect).
   */
  cancelRemoval(userId: string): boolean {
    const timer = this.pendingRemovals.get(userId);
    if (timer) {
      clearTimeout(timer);
      this.pendingRemovals.delete(userId);
      console.log(`[SessionManager] Cancelled grace period for ${userId} (reconnected)`);
      return true;
    }
    return false;
  }
}

/** Singleton — import this everywhere */
export const sessions = new SessionManager();
