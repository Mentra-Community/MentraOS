package com.mentra.bluetoothsdk.sgcs

import android.bluetooth.BluetoothDevice

/**
 * Decides when this phone has stopped being the owner of secure-pairing Mentra Live glasses.
 *
 * Entering pairing mode forgets the previous owner on the glasses (pairing spec R4), and outside
 * the window the glasses reject non-owners at connect time with HCI Authentication Failure.
 */
internal object MentraLiveOwnerLossPolicy {
    /** Matches the glasses' absolute pairing window cap; the idle timer can be held that long. */
    const val PAIRING_WINDOW_ABSOLUTE_MS = 300_000L
    private const val PAIRING_WINDOW_MIN_MS = 5_000L

    /** A bond the glasses dropped surfaces within a few seconds of the reconnect link. */
    const val BOND_REMOVED_AFTER_RECONNECT_MS = 15_000L

    /** HCI 0x05 Authentication Failure / 0x0F Unacceptable BD_ADDR from a connect-time rejection. */
    fun isOwnerRejectionStatus(status: Int): Boolean = status == 0x05 || status == 0x0F

    /**
     * A rejection while reconnecting to saved glasses means the glasses no longer admit this phone.
     * During an explicit pairing attempt the user is pairing anew, so it is not owner loss.
     */
    fun shouldStandDownOnGattError(status: Int, manualPairing: Boolean): Boolean =
            !manualPairing && isOwnerRejectionStatus(status)

    /**
     * Android deletes its BLE keys when the glasses answer an encryption request without them.
     * Right after an automatic reconnect that means the glasses forgot this phone; continuing
     * would start a fresh bond and prompt the user on a phone that is no longer the owner.
     */
    fun shouldStandDownOnBondRemoved(
            previousBondState: Int,
            bondState: Int,
            killed: Boolean,
            unpairInProgress: Boolean,
            manualPairing: Boolean,
            msSinceAutoReconnectLink: Long?,
    ): Boolean {
        if (killed || unpairInProgress || manualPairing) return false
        if (previousBondState != BluetoothDevice.BOND_BONDED ||
                        bondState != BluetoothDevice.BOND_NONE
        ) {
            return false
        }
        val since = msSinceAutoReconnectLink ?: return false
        return since in 0..BOND_REMOVED_AFTER_RECONNECT_MS
    }

    /** Stay out for the whole window, not just its idle timeout. */
    fun yieldMs(windowMs: Long): Long =
            maxOf(windowMs, PAIRING_WINDOW_ABSOLUTE_MS)
                    .coerceIn(PAIRING_WINDOW_MIN_MS, PAIRING_WINDOW_ABSOLUTE_MS)

    /**
     * Secure glasses commit an owner only on a BLE bond. Until Android reports it, GATT readiness
     * inside the open window does not mean the phone paired.
     */
    fun shouldDeferReadyForBond(securePairingTarget: Boolean, bondState: Int?): Boolean =
            securePairingTarget && bondState != BluetoothDevice.BOND_BONDED
}
