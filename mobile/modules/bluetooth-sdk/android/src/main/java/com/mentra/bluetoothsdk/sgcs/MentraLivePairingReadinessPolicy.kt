package com.mentra.bluetoothsdk.sgcs

/**
 * Pure rules for when an explicit Mentra Live pair reports ready, and for the saved secure
 * firmware memory. [MentraLive] feeds them the selected scan row, this GATT session's
 * `pairing_info` and the bond state. Readiness never waits without a deadline: the owner-commit
 * wait has [MentraLiveOwnerLossPolicy.SECURE_BOND_WAIT_MS], the unknown-capability wait has
 * [UNKNOWN_CAPABILITY_PAIRING_INFO_WAIT_MS].
 */
internal object MentraLivePairingReadinessPolicy {
    /**
     * How long an explicit pair to glasses of unknown secure capability waits after
     * `glasses_ready` for `pairing_info` before treating them as legacy firmware.
     */
    const val UNKNOWN_CAPABILITY_PAIRING_INFO_WAIT_MS = 5_000L

    /** A ready session without `pairing_info` within this time means the glasses are not secure firmware. */
    const val SECURE_FIRMWARE_REFRESH_MS = 15_000L

    enum class Readiness {
        /** Report the glasses ready now. */
        READY,
        /** The selected glasses' capability is unknown and no `pairing_info` has arrived yet. */
        AWAIT_PAIRING_INFO,
        /** Secure target: wait for the BLE bond and `pairing_info.owner_committed`. */
        AWAIT_OWNER_COMMIT,
    }

    /**
     * Whether an explicit pair targets secure-pairing firmware. The selected scan row's
     * capability decides, never an address or name seen earlier; when the row did not know it,
     * this session's `pairing_info` does.
     *
     * @param selectedCapability `pending_device_secure_pairing_capable`, null when unknown
     * @param sessionPairingInfoSecure `secure_pairing_capable` from this session's `pairing_info`,
     *   null before one arrives
     */
    fun isSecurePairingTarget(selectedCapability: Boolean?, sessionPairingInfoSecure: Boolean?): Boolean =
            selectedCapability ?: (sessionPairingInfoSecure == true)

    /**
     * Readiness after `glasses_ready`. Automatic reconnects are never gated. An explicit pair to
     * glasses of unknown capability waits for `pairing_info` until [unknownCapabilityWaitExpired];
     * a secure one then follows the owner-commit rule, a legacy one (or none) is ready.
     */
    fun readiness(
            explicitPairing: Boolean,
            selectedCapability: Boolean?,
            sessionPairingInfoSecure: Boolean?,
            unknownCapabilityWaitExpired: Boolean,
            bondState: Int?,
            ownerCommitted: Boolean,
    ): Readiness {
        if (!explicitPairing) return Readiness.READY
        if (selectedCapability == null &&
                        sessionPairingInfoSecure == null &&
                        !unknownCapabilityWaitExpired
        ) {
            return Readiness.AWAIT_PAIRING_INFO
        }
        val secure = isSecurePairingTarget(selectedCapability, sessionPairingInfoSecure)
        return if (MentraLiveOwnerLossPolicy.shouldDeferReadyForBond(secure, bondState, ownerCommitted)) {
            Readiness.AWAIT_OWNER_COMMIT
        } else {
            Readiness.READY
        }
    }

    /**
     * `mentra_live_secure_firmware` once a ready session's [SECURE_FIRMWARE_REFRESH_MS] has
     * passed: false when no `pairing_info` arrived, so glasses rolled back to old firmware stop
     * counting as secure. Null leaves the value a `pairing_info` already wrote.
     */
    fun secureFirmwareAfterReadySession(pairingInfoSeen: Boolean): Boolean? =
            if (pairingInfoSeen) null else false
}

/**
 * Addresses advertising the secure-pairing trailer in the current scan. It starts empty with each
 * scan, so glasses rolled back to old firmware stop counting as secure on the next scan. It is a
 * hint for automatic sessions only; an explicit pair uses the selected row's capability
 * ([MentraLivePairingReadinessPolicy.isSecurePairingTarget]).
 */
internal class MentraLiveSecureTrailerScanMemory {
    private val addresses: MutableSet<String> = java.util.Collections.synchronizedSet(mutableSetOf())

    fun onScanStart() = addresses.clear()

    fun noteSecureTrailer(address: String) {
        addresses.add(address)
    }

    fun contains(address: String?): Boolean = address != null && addresses.contains(address)
}
