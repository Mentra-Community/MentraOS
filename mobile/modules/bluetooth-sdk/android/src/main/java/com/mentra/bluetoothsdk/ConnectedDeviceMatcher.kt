package com.mentra.bluetoothsdk

/**
 * Pure matcher deciding whether a GATT-connected peripheral (as enumerated by
 * `BluetoothManager.getConnectedDevices`) is plausibly the glasses a scan for a
 * given [DeviceModel] was looking for. This is a name/address heuristic, not
 * proof of device identity or connection ownership.
 *
 * Kept free of Android framework types so the logic is unit-testable on the
 * JVM (see `ConnectedDeviceMatcherTest`).
 */
internal object ConnectedDeviceMatcher {

    /**
     * True when the candidate peripheral either matches the saved default
     * device for the scanned [model] (by address ignoring case when both
     * addresses exist, otherwise by a nonblank exact name) or carries a
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
        val matchesDefault = if (defaultDevice?.model == model) {
            val savedAddress = defaultDevice.address?.takeIf { it.isNotBlank() }
            val address = candidateAddress?.takeIf { it.isNotBlank() }
            if (savedAddress != null && address != null) {
                address.equals(savedAddress, ignoreCase = true)
            } else {
                sameSavedName(model, defaultDevice.name, candidateName)
            }
        } else {
            false
        }
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

    /**
     * Saved-name equality, plus the generic factory fallback that moved from
     * `XyBLE_3008` / `XyBT_3008` to `Mentra_Live_3008`. Unique shipped names
     * such as `XyBLE_1234` stay exact. Address matching remains the primary
     * identity check when both sides have an address.
     */
    fun sameSavedName(model: DeviceModel, saved: String?, advertised: String?): Boolean {
        if (saved.isNullOrBlank() || advertised.isNullOrBlank()) return false
        if (saved == advertised) return true
        if (model != DeviceModel.MENTRA_LIVE) return false
        val generic = setOf("XyBLE_3008", "XyBT_3008", "Mentra_Live_3008")
        return saved in generic && advertised in generic
    }
}
