/** One engine-owned notification policy: capture remains independent of presentation. */
import {Platform} from "react-native"
import {shallow} from "zustand/shallow"
import CrustModule from "@mentra/crust"
import BluetoothSdk from "@mentra/bluetooth-sdk/internal"
import type {PhoneNotificationEvent} from "@mentra/crust"

import {useSettingsStore, SETTINGS} from "../stores/settings"
import {useGlassesStore, isGlassesReady} from "../stores/glasses"
import {DeviceTypes} from "../types/enums"
import {getModelCapabilities} from "../types/hardware"
import {nativeNotificationConfig} from "./NativeNotificationPolicy"

let unsubscribers: Array<() => void> = []
let presentationActive = false

export function nativeNotificationCapabilities() {
  const supported = Boolean(
    getModelCapabilities(useGlassesStore.getState().deviceModel as DeviceTypes)?.hasNativeNotifications,
  )
  return {
    supported,
    source: Platform.OS === "ios" ? ("ancs" as const) : ("phone" as const),
    contentAccess:
      Platform.OS === "android" ? ("full" as const) : supported ? ("app_identity" as const) : ("unsupported" as const),
    perAppFiltering: Platform.OS === "android",
    removal: false, // The verified G2 protocol does not yet include a removal command.
  }
}

function desiredConfig() {
  const settings = useSettingsStore.getState()
  return nativeNotificationConfig({
    supported: nativeNotificationCapabilities().supported,
    selected: Boolean(settings.getSetting(SETTINGS.native_notifications_enabled.key)),
    presentationActive,
    sourceEnabled:
      Platform.OS !== "android" || Boolean(settings.getSetting(SETTINGS.android_notification_listener_enabled.key)),
    autoDisplay: Boolean(settings.getSetting(SETTINGS.native_notifications_auto_display.key)),
    durationSeconds: Number(settings.getSetting(SETTINGS.native_notifications_duration.key)),
    doNotDisturb: Boolean(settings.getSetting(SETTINGS.native_notifications_do_not_disturb.key)),
    blockedApps: Platform.OS === "android" ? settings.getSetting(SETTINGS.notifications_blocklist.key) : [],
  })
}

function pushNativeConfig(): void {
  if (!nativeNotificationCapabilities().supported) return
  void BluetoothSdk.configureNativeNotifications(desiredConfig()).catch((error: unknown) => {
    if (isGlassesReady(useGlassesStore.getState().connection)) {
      console.warn("PhoneNotificationsSync: native notification configuration failed", error)
    }
  })
}

/** Hosts activate their presentation owner (Notify in the Mentra App) through this seam. */
export function setPhoneNotificationPresentationActive(active: boolean): void {
  if (active === presentationActive) return
  presentationActive = active
  pushNativeConfig()
}

export function usesNativeNotificationPresentation(): boolean {
  return (
    nativeNotificationCapabilities().supported &&
    presentationActive &&
    Boolean(useSettingsStore.getState().getSetting(SETTINGS.native_notifications_enabled.key))
  )
}

/** Return true when the selected firmware presentation owns this event, including quiet/history mode. */
export async function presentNativePhoneNotification(event: PhoneNotificationEvent): Promise<boolean> {
  if (!usesNativeNotificationPresentation()) return false
  if (!desiredConfig().enabled) return true
  if (Platform.OS !== "android") return true // G2 receives ANCS directly; never upload metadata back.
  const blocked = useSettingsStore.getState().getSetting(SETTINGS.notifications_blocklist.key)
  if (Array.isArray(blocked) && blocked.includes(event.packageName)) return true
  if (!isGlassesReady(useGlassesStore.getState().connection)) return true
  await BluetoothSdk.sendPhoneNotification({
    notificationId: String(event.notificationId ?? ""),
    packageName: String(event.packageName ?? ""),
    appName: String(event.app ?? ""),
    title: String(event.title ?? ""),
    subtitle: "",
    body: String(event.content ?? ""),
    timestampMs: Number(event.timestamp ?? Date.now()),
    action: 0,
  })
  return true
}

function pushConfig(): void {
  const settings = useSettingsStore.getState()
  if (Platform.OS === "android") {
    const enabled = Boolean(settings.getSetting(SETTINGS.android_notification_listener_enabled.key))
    const blocklist = settings.getSetting(SETTINGS.notifications_blocklist.key)
    void CrustModule.setNotificationConfig(enabled, Array.isArray(blocklist) ? blocklist : []).catch((error: unknown) =>
      console.warn("PhoneNotificationsSync: listener configuration failed", error),
    )
  }
  pushNativeConfig()
}

export function startPhoneNotificationsSync(): void {
  if (unsubscribers.length) return
  pushConfig()
  unsubscribers = [
    useSettingsStore.subscribe(
      (state) =>
        [
          SETTINGS.android_notification_listener_enabled,
          SETTINGS.notifications_blocklist,
          SETTINGS.native_notifications_enabled,
          SETTINGS.native_notifications_auto_display,
          SETTINGS.native_notifications_duration,
          SETTINGS.native_notifications_do_not_disturb,
        ].map((setting) => state.getSetting(setting.key)),
      pushConfig,
      {equalityFn: shallow},
    ),
    useGlassesStore.subscribe((state) => ({model: state.deviceModel, connection: state.connection}), pushNativeConfig, {
      equalityFn: shallow,
    }),
  ]
}

export function stopPhoneNotificationsSync(): void {
  setPhoneNotificationPresentationActive(false)
  unsubscribers.forEach((unsubscribe) => unsubscribe())
  unsubscribers = []
}
