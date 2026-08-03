/**
 * permissions facade — `engine.permissions`: the raw OS-permission ops the runtime
 * needs, mapped from feature keys to react-native-permissions. This is the LEAN
 * surface (check/request/openSettings/requirementsForMiniapp) — the host keeps its
 * own UI helpers (rationale dialogs, denied-warnings) on top; engine stays free of
 * i18n/theme/AlertUtils.
 */
import {Platform, Linking, PermissionsAndroid, type Permission as AndroidPermission} from "react-native"
import {check, request, PERMISSIONS, RESULTS, type Permission} from "react-native-permissions"

import appRegistry from "../services/AppRegistry"
import type {AppletPermission} from "../types"

/** OEM-facing feature keys (mapped to OS permissions per platform). */
export const PermissionFeatures = {
  MICROPHONE: "microphone",
  CAMERA: "camera",
  CALENDAR: "calendar",
  LOCATION: "location",
  LOCAL_WIFI: "local_wifi",
  BACKGROUND_LOCATION: "background_location",
  BLUETOOTH: "bluetooth",
  PHONE_STATE: "phone_state",
  POST_NOTIFICATIONS: "post_notifications",
} as const

const ANDROID = PermissionsAndroid.PERMISSIONS
const apiLevel = typeof Platform.Version === "number" ? Platform.Version : parseInt(String(Platform.Version), 10)
const requiresSeparateAndroidBackgroundLocation = apiLevel >= 29

export function localWifiPermissionForAndroid(
  androidApiLevel: number,
  androidPermissions: typeof PermissionsAndroid.PERMISSIONS = ANDROID,
): AndroidPermission {
  return androidApiLevel >= 33 ? androidPermissions.NEARBY_WIFI_DEVICES : androidPermissions.ACCESS_FINE_LOCATION
}

async function areAndroidPermissionsGranted(perms: AndroidPermission[]): Promise<boolean> {
  for (const p of perms) {
    if (!(await PermissionsAndroid.check(p))) return false
  }
  return true
}

async function requestAndroidPermissions(perms: AndroidPermission[]): Promise<boolean> {
  const results = await PermissionsAndroid.requestMultiple(perms)
  return perms.every((p) => results[p] === PermissionsAndroid.RESULTS.GRANTED)
}

async function checkAndroidBackgroundLocation(): Promise<boolean> {
  const hasForegroundLocation = await areAndroidPermissionsGranted([ANDROID.ACCESS_FINE_LOCATION])
  if (!hasForegroundLocation || !requiresSeparateAndroidBackgroundLocation) return hasForegroundLocation

  return PermissionsAndroid.check(ANDROID.ACCESS_BACKGROUND_LOCATION)
}

async function requestAndroidBackgroundLocation(): Promise<boolean> {
  const hasForegroundLocation = await requestAndroidPermissions([ANDROID.ACCESS_FINE_LOCATION])
  if (!hasForegroundLocation || !requiresSeparateAndroidBackgroundLocation) return hasForegroundLocation

  if (await PermissionsAndroid.check(ANDROID.ACCESS_BACKGROUND_LOCATION)) return true

  const result = await PermissionsAndroid.request(ANDROID.ACCESS_BACKGROUND_LOCATION)
  return result === PermissionsAndroid.RESULTS.GRANTED
}

function iosPerms(feature: string): Permission[] {
  switch (feature) {
    case PermissionFeatures.MICROPHONE:
      return [PERMISSIONS.IOS.MICROPHONE]
    case PermissionFeatures.CAMERA:
      return [PERMISSIONS.IOS.CAMERA]
    case PermissionFeatures.CALENDAR:
      return [PERMISSIONS.IOS.CALENDARS]
    case PermissionFeatures.LOCATION:
      return [PERMISSIONS.IOS.LOCATION_WHEN_IN_USE]
    case PermissionFeatures.LOCAL_WIFI:
      return []
    case PermissionFeatures.BACKGROUND_LOCATION:
      // iOS won't grant ALWAYS without WHEN_IN_USE first — request both (matches
      // the host PermissionsUtils mapping), else a cold request can't escalate.
      return [PERMISSIONS.IOS.LOCATION_WHEN_IN_USE, PERMISSIONS.IOS.LOCATION_ALWAYS]
    case PermissionFeatures.BLUETOOTH:
      return [PERMISSIONS.IOS.BLUETOOTH]
    default:
      return []
  }
}

function androidPerms(feature: string): AndroidPermission[] {
  switch (feature) {
    case PermissionFeatures.MICROPHONE:
      return [ANDROID.RECORD_AUDIO]
    case PermissionFeatures.CAMERA:
      return [ANDROID.CAMERA]
    case PermissionFeatures.CALENDAR:
      // Expo Calendar requires both grants on Android, including for read APIs.
      // The miniapp-facing calendar API remains read-only.
      return [ANDROID.READ_CALENDAR, ANDROID.WRITE_CALENDAR]
    case PermissionFeatures.LOCATION:
    case PermissionFeatures.BACKGROUND_LOCATION:
      return [ANDROID.ACCESS_FINE_LOCATION]
    case PermissionFeatures.LOCAL_WIFI:
      return [localWifiPermissionForAndroid(apiLevel)]
    case PermissionFeatures.PHONE_STATE:
      return [ANDROID.READ_PHONE_STATE]
    case PermissionFeatures.BLUETOOTH:
      return apiLevel >= 31 ? [ANDROID.BLUETOOTH_SCAN, ANDROID.BLUETOOTH_CONNECT, ANDROID.BLUETOOTH_ADVERTISE] : []
    case PermissionFeatures.POST_NOTIFICATIONS:
      return apiLevel >= 33 ? [ANDROID.POST_NOTIFICATIONS] : []
    default:
      return []
  }
}

export const permissions = {
  /** Is the given feature's OS permission currently granted? */
  async check(feature: string): Promise<boolean> {
    if (Platform.OS === "android") {
      if (feature === PermissionFeatures.BACKGROUND_LOCATION) return checkAndroidBackgroundLocation()

      const perms = androidPerms(feature)
      if (perms.length === 0) return true // nothing to ask on this OS/version
      // Every permission in the group must be granted (e.g. bluetooth =
      // scan+connect+advertise, calendar = read+write) — matches the iOS branch.
      return areAndroidPermissionsGranted(perms)
    }
    const perms = iosPerms(feature)
    if (perms.length === 0) return true
    for (const p of perms) {
      const status = await check(p)
      if (status !== RESULTS.GRANTED && status !== RESULTS.LIMITED) return false
    }
    return true
  },

  /** Request the given feature's OS permission. Resolves to whether it's granted. */
  async request(feature: string): Promise<boolean> {
    if (Platform.OS === "android") {
      if (feature === PermissionFeatures.BACKGROUND_LOCATION) return requestAndroidBackgroundLocation()

      const perms = androidPerms(feature)
      if (perms.length === 0) return true
      // Granted only when EVERY permission in the group was granted.
      return requestAndroidPermissions(perms)
    }
    const perms = iosPerms(feature)
    if (perms.length === 0) return true
    let granted = true
    for (const p of perms) {
      const result = await request(p)
      if (result !== RESULTS.GRANTED && result !== RESULTS.LIMITED) granted = false
    }
    return granted
  },

  /** Open the OS settings app (so the user can grant a blocked permission). */
  openSettings: (): Promise<void> => Linking.openSettings(),

  /** The permissions a given installed miniapp declares it needs. */
  async requirementsForMiniapp(packageName: string): Promise<AppletPermission[]> {
    const apps = await appRegistry.getInstalledMiniapps()
    return apps.find((a) => a.packageName === packageName)?.permissions ?? []
  },
}
