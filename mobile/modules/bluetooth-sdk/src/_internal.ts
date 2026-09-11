/**
 * MentraOS-only compatibility entrypoint.
 *
 * Apps should import from `@mentra/bluetooth-sdk`. This is exported as
 * `@mentra/bluetooth-sdk/internal` only for MentraOS packages that still need
 * the compatibility surface while the app is migrated onto the public SDK
 * surface.
 */
export {default} from "./_private/BluetoothSdkModule"
export type {BluetoothSdkInternalModule} from "./_private/BluetoothSdkModule"
export * from "./BluetoothSdk.types"
export {default as MentraLocalNetwork} from "./_private/MentraLocalNetworkModule"
export * from "./_private/MentraLocalNetworkModule"
export {default as MentraOtaServer} from "./ota-server"
export * from "./ota-server/MentraOtaServer.types"
export {BLUETOOTH_SDK_VERSION, sdkPinnedOtaManifestUrl} from "./_private/sdkOtaManifest"
