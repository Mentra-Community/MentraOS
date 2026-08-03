/**
 * notifications facade — `engine.notifications`: inbound alerts engine→host. The
 * OEM subscribes and renders them however it likes (modal, toast, banner). Today:
 * miniapp crashloop; version-incompatible miniapp and persistent connection loss
 * land as their detectors are wired into the emitter.
 */
import {islandNotifications, type IslandNotification} from "../services/NotificationsEmitter"

export type {IslandNotification, IslandNotificationKind} from "../services/NotificationsEmitter"

export const notifications = {
  /** Subscribe to engine-raised notifications; returns an unsubscribe. */
  onNotification: (cb: (notification: IslandNotification) => void): (() => void) =>
    islandNotifications.subscribe(cb),
}
