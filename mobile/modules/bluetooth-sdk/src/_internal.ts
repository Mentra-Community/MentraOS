/**
 * MentraOS-only compatibility entrypoint.
 *
 * Apps should import from `@mentra/bluetooth-sdk`. This file is not a
 * package export; MentraOS resolves it through its local
 * `@mentra/bluetooth-sdk-internal` alias while the app is migrated onto the
 * public SDK surface.
 */
export {default} from "./_private/BluetoothSdkModule"
export type {BluetoothSdkInternalModule} from "./_private/BluetoothSdkModule"
export * from "./BluetoothSdk.types"
