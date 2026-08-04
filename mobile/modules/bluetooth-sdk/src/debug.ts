import PrivateBluetoothSdkModule from "./_private/BluetoothSdkModule"

export function setOtaVersionUrl(otaVersionUrl: string): void {
  PrivateBluetoothSdkModule.setOtaVersionUrl(otaVersionUrl)
}

export function getOtaVersionUrl(): string {
  return PrivateBluetoothSdkModule.getOtaVersionUrl()
}
