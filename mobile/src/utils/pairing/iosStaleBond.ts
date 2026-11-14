import {DeviceTypes} from "@mentra/engine"

/** The route of the "Forget the old pairing" screen. */
export const FORGET_IOS_PAIRING_ROUTE = "/pairing/forget-ios-pairing"

/** Where that screen goes once the person is done: Home when not given. */
export type ForgetIosPairingThen = "home" | "sign-in"

/**
 * After Unpair or sign-out on iOS and the Mac, the bond outlives the app's pairing: show the screen
 * that asks the person to forget the glasses in Settings. Android removes the bond itself.
 *
 * Glasses that keep former owners' keys (`glassesKeepKeys`, from `pairing_info.former_owner_keys`)
 * take this phone back later with the bond it has, so nothing needs forgetting. Read it before
 * unpairing: forgetting the glasses clears it.
 */
export function askToForgetIosPairing(
  platform: string,
  model: string,
  deviceName: string,
  then: ForgetIosPairingThen,
  glassesKeepKeys: boolean,
) {
  return platform === "ios" && model === DeviceTypes.LIVE && !glassesKeepKeys
    ? {route: FORGET_IOS_PAIRING_ROUTE, params: {deviceModel: model, deviceName, then}}
    : null
}
