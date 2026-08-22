/**
 * G2 native-notification bridge - engine-owned. Pushes captured phone notifications into the
 * G2's OWN notification centre via the bluetooth-sdk's `sendPhoneNotification` seam.
 *
 * Runs in parallel with the normal flow (miniapp forwarding, plus a
 * locally drawn card and speech when Notify is running). Both subscribe to the same native `phone_notification`
 * event independently, so turning this off changes nothing about it.
 *
 * Gated on: Android (capture is the NotificationListenerService; iOS glasses use ANCS), the
 * `g2_native_notifications` toggle, and a connected G2. Deliberately NOT gated on Notify
 * running, on connection state (native drops it), or on a whitelist. The per-app blocklist is
 * honoured for free — the native listener applies it before emitting.
 *
 * Started by `engine.start()`. Idempotent.
 */
import {Platform} from "react-native"
import CrustModule from "@mentra/crust"
import type {PhoneNotificationEvent} from "@mentra/crust"
import BluetoothSdk from "@mentra/bluetooth-sdk/internal"

import {useSettingsStore, SETTINGS} from "../stores/settings"
import {useGlassesStore} from "../stores/glasses"
import {DeviceTypes} from "../types/enums"

let subscription: {remove: () => void} | null = null

function shouldPush(): boolean {
  if (Platform.OS !== "android") return false
  if (!useSettingsStore.getState().getSetting(SETTINGS.g2_native_notifications.key)) return false
  return useGlassesStore.getState().deviceModel === DeviceTypes.G2
}

function forward(event: PhoneNotificationEvent): void {
  if (!shouldPush()) return

  void Promise.resolve(
    BluetoothSdk.sendPhoneNotification({
      notificationId: String(event.notificationId ?? ""),
      packageName: String(event.packageName ?? ""),
      appName: String(event.app ?? ""),
      title: String(event.title ?? ""),
      // Empty until the native listener reads `android.subText` — a listener change, not a
      // protocol one. The glasses' schema has the field, so it stays in the payload.
      subtitle: "",
      body: String(event.content ?? ""),
      timestampMs: Number(event.timestamp ?? Date.now()),
      // 0 = posted. Dismissals would map to a non-zero action; not wired yet.
      action: 0,
    }),
  ).catch((err: unknown) =>
    // Never log the notification text.
    console.warn(`G2NotificationBridge: sendPhoneNotification failed: ${(err as Error)?.message ?? err}`),
  )
}

export function startG2NotificationBridge(): void {
  if (subscription) return
  // Subscribe unconditionally on Android; the toggle is read per-notification instead, so
  // flipping it takes effect immediately with no resubscribe and no stale-listener window.
  if (Platform.OS !== "android") return
  subscription = CrustModule.addListener("phone_notification", forward)
}

export function stopG2NotificationBridge(): void {
  subscription?.remove()
  subscription = null
}
