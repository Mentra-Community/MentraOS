/**
 * `@mentra/bluetooth-sdk/glasses-wifi`: the glasses Wi-Fi service for the Mentra engine's own
 * consumers (hotspot OTA, gallery sync, Mentra Call, the managed relay, miniapps' photos), which
 * hold the link and talk to the glasses over it. Apps use `BluetoothSdk.link` and
 * `openCamera` instead.
 */
// The service's own native requests, behind the link the service holds.
// eslint-disable-next-line no-restricted-imports
import {cancel, download, isScoped, onDownloadProgress, request} from "./native"

export {
  GlassesWifiError,
  holdGlassesWifi,
  type GlassesWifiBinding,
  type GlassesWifiEvent,
  type GlassesWifiHold,
  type GlassesWifiHoldOptions,
} from "./service"
export {createLink, linkState, onLinkChange, type GlassesLink, type LinkState} from "./link"
export {
  openCameraSession,
  type CameraSession,
  type ContinuousCapture,
  type HoldWarm,
} from "./camera-session"
export type {HotspotStatus} from "../BluetoothSdk.types"

/** Requests to the glasses over the glasses Wi-Fi link the service holds. */
export const glassesWifiLink = Object.freeze({isScoped, request, download, cancel, onDownloadProgress})
