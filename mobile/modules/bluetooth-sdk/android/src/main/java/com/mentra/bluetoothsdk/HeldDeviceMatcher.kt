package com.mentra.bluetoothsdk

/**
 * Pure matcher deciding whether a GATT-connected peripheral (as enumerated by
 * `BluetoothManager.getConnectedDevices`) is plausibly the glasses a scan for a
 * given [DeviceModel] was looking for.
 *
 * Kept free of Android framework types so the logic is unit-testable on the
 * JVM (see `HeldDeviceMatcherTest`).
 */
internal object HeldDeviceMatcher {

    /**
     * True when the candidate peripheral either matches the saved default
     * device for the scanned [model] (by exact name, or by address ignoring
     * case, since stored addresses can arrive lowercase) or carries a
     * known advertised-name prefix for that model.
     *
     * [defaultDevice] only counts when its model equals the scanned [model];
     * a saved Mentra Live cannot explain an empty Nex scan. [DeviceModel.SIMULATED]
     * never matches anything.
     */
    fun matches(
        model: DeviceModel,
        defaultDevice: Device?,
        candidateName: String?,
        candidateAddress: String?,
    ): Boolean {
        if (model == DeviceModel.SIMULATED) return false
        val matchesDefault =
            defaultDevice != null &&
                defaultDevice.model == model &&
                (
                    (candidateName != null && candidateName == defaultDevice.name) ||
                        (
                            defaultDevice.address != null &&
                                candidateAddress != null &&
                                candidateAddress.equals(defaultDevice.address, ignoreCase = true)
                        )
                )
        return matchesDefault || (candidateName != null && matchesModelNamePrefix(model, candidateName))
    }

    /**
     * Per-model advertised/bonded-name filters, mirroring the scan filters the
     * SGCs apply: MentraLive.kt (`Xy_A`, `XyBLE_`, `MENTRA_LIVE_BLE`,
     * `MENTRA_LIVE_BT`, lowercase `mentra_live`) and MentraNex.kt (`Nex1-`,
     * `MENTRA_DISPLAY_`). Models without a Mentra-branded advertised name
     * (G1, G2, Nimo, Ar99, ...) have no prefix entry here and are detected
     * only through the saved-default match above.
     */
    private fun matchesModelNamePrefix(
        model: DeviceModel,
        name: String,
    ): Boolean =
        when (model) {
            DeviceModel.MENTRA_LIVE ->
                name == "Xy_A" ||
                    name.startsWith("XyBLE_") ||
                    name.startsWith("MENTRA_LIVE_BLE") ||
                    name.startsWith("MENTRA_LIVE_BT") ||
                    name.lowercase().startsWith("mentra_live")
            DeviceModel.MENTRA_NEX ->
                name.startsWith("Nex1-") ||
                    name.startsWith("MENTRA_DISPLAY_")
            else -> false
        }
}
