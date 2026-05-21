// Reexport the native module. On web, it will be resolved to BluetoothSdkModule.web.ts
// and on native platforms to BluetoothSdkModule.ts
export {default} from "./BluetoothSdkModule"
export * from "./BluetoothSdk.types"
