package com.mentra.bluetoothsdk

object MentraBluetoothSdkDebug {
    @JvmStatic
    fun setOtaVersionUrl(
        sdk: MentraBluetoothSdk,
        otaVersionUrl: String,
    ) {
        sdk.setOtaVersionUrl(otaVersionUrl)
    }

    @JvmStatic
    fun getOtaVersionUrl(sdk: MentraBluetoothSdk): String = sdk.getOtaVersionUrl()
}
