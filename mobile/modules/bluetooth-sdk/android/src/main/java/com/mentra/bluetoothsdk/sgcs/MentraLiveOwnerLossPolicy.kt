package com.mentra.bluetoothsdk.sgcs

import android.bluetooth.BluetoothDevice

/**
 * Decides when this phone has stopped being the owner of secure-pairing Mentra Live glasses.
 *
 * Entering pairing mode forgets the previous owner on the glasses (pairing spec R4), and outside
 * the window the glasses reject non-owners at connect time with HCI Authentication Failure.
 *
 * A single rejection is only a hint: a glasses reboot, a stale bond, or a radio hiccup can
 * produce one. Only secure-pairing firmware ever rejects a non-owner on purpose, and only a
 * rejection that repeats across automatic reconnects ([OwnerRejectionStreak]) is treated as
 * owner loss. The firmware's own `entering_pairing_mode` event is explicit and needs no streak.
 */
internal object MentraLiveOwnerLossPolicy {
    /** Matches the glasses' absolute pairing window cap; the idle timer can be held that long. */
    const val PAIRING_WINDOW_ABSOLUTE_MS = 300_000L
    private const val PAIRING_WINDOW_MIN_MS = 5_000L

    /** A bond the glasses dropped surfaces within a few seconds of the reconnect link. */
    const val BOND_REMOVED_AFTER_RECONNECT_MS = 15_000L

    /** Consecutive automatic-reconnect rejections before this phone stands down. */
    const val REJECTIONS_TO_STAND_DOWN = 3

    /** The rejections must keep arriving for about this long, so a glasses reboot is not owner loss. */
    const val MIN_REJECTION_SPAN_MS = 45_000L

    /** A gap this long between rejections means they are unrelated, not one streak. */
    const val REJECTION_STREAK_GAP_MS = 90_000L

    /** One failed attempt can report twice (bond removed, then GATT disconnect). Count it once. */
    const val SAME_ATTEMPT_MS = 2_000L

    /** HCI 0x05 Authentication Failure / 0x0F Unacceptable BD_ADDR from a connect-time rejection. */
    fun isOwnerRejectionStatus(status: Int): Boolean = status == 0x05 || status == 0x0F

    /**
     * A connect-time rejection of saved secure glasses. Legacy firmware never rejects a
     * non-owner on purpose, and during an explicit pairing attempt the user is pairing anew.
     * This is one observation; [OwnerRejectionStreak] decides when it adds up to owner loss.
     */
    fun isOwnerRejectionOnGattError(
            status: Int,
            manualPairing: Boolean,
            secureFirmware: Boolean,
    ): Boolean = secureFirmware && !manualPairing && isOwnerRejectionStatus(status)

    /**
     * Android deletes its BLE keys when the glasses answer an encryption request without them.
     * Right after an automatic reconnect that can mean the glasses forgot this phone. Like
     * [isOwnerRejectionOnGattError] this is one observation, not yet owner loss.
     */
    fun isOwnerRejectionOnBondRemoved(
            previousBondState: Int,
            bondState: Int,
            killed: Boolean,
            unpairInProgress: Boolean,
            manualPairing: Boolean,
            msSinceAutoReconnectLink: Long?,
            secureFirmware: Boolean,
    ): Boolean {
        if (!secureFirmware || killed || unpairInProgress || manualPairing) return false
        if (previousBondState != BluetoothDevice.BOND_BONDED ||
                        bondState != BluetoothDevice.BOND_NONE
        ) {
            return false
        }
        val since = msSinceAutoReconnectLink ?: return false
        return since in 0..BOND_REMOVED_AFTER_RECONNECT_MS
    }

    /**
     * Tracks rejections across automatic reconnects. Owner loss needs [REJECTIONS_TO_STAND_DOWN]
     * attempts in a row that span at least [MIN_REJECTION_SPAN_MS]. Any successful ready session
     * calls [reset].
     */
    class OwnerRejectionStreak {
        private var count = 0
        private var firstAtMs = 0L
        private var lastAtMs = 0L

        /** Records one rejection and returns true once the streak means owner loss. */
        @Synchronized
        fun record(nowMs: Long): Boolean {
            if (count > 0 && nowMs - lastAtMs <= SAME_ATTEMPT_MS) {
                return reached(nowMs)
            }
            if (count > 0 && nowMs - lastAtMs > REJECTION_STREAK_GAP_MS) {
                count = 0
            }
            if (count == 0) firstAtMs = nowMs
            count++
            lastAtMs = nowMs
            return reached(nowMs)
        }

        @Synchronized
        fun reset() {
            count = 0
            firstAtMs = 0L
            lastAtMs = 0L
        }

        private fun reached(nowMs: Long): Boolean =
                count >= REJECTIONS_TO_STAND_DOWN && nowMs - firstAtMs >= MIN_REJECTION_SPAN_MS
    }

    /** Stay out for the whole window, not just its idle timeout. */
    fun yieldMs(windowMs: Long): Long =
            maxOf(windowMs, PAIRING_WINDOW_ABSOLUTE_MS)
                    .coerceIn(PAIRING_WINDOW_MIN_MS, PAIRING_WINDOW_ABSOLUTE_MS)

    /**
     * Ownership transfer (pairing spec T1): when the glasses kept the previous owner while they
     * opened the window (`owner_retained`), that owner's phone yields for the window instead of
     * standing down. Absent/false keeps the 3.3 stand-down. Mirrors iOS
     * `MentraLiveConnectionAttemptPolicy.shouldYieldOnEnteringPairingMode`.
     */
    fun shouldYieldOnEnteringPairingMode(ownerRetained: Boolean): Boolean = ownerRetained

    /**
     * A connect rejection while this phone is yielding is the glasses refusing the retained
     * owner on purpose (T2), not owner loss, so it never enters the [OwnerRejectionStreak].
     */
    fun shouldRecordOwnerRejection(yieldActive: Boolean): Boolean = !yieldActive

    /**
     * While the glasses report `awaiting_confirm` the user is on the replace-owner confirm
     * screen and no bond can follow until `confirm_replace_owner` succeeds. The secure-bond
     * wait must not start (or must not fail the pair) in that state. A confirm result with
     * `ok == true` re-arms it, because the bond follows. Mirrors iOS
     * `MentraLiveConnectionAttemptPolicy.shouldRunSecurePairingWait`.
     */
    fun shouldRunSecureBondWait(awaitingConfirm: Boolean): Boolean = !awaitingConfirm

    /** The `confirm_replace_owner_result` outcome that lets the bond wait run again. */
    fun shouldRearmSecureBondWaitAfterConfirm(ok: Boolean): Boolean = ok

    /**
     * `secure_pairing_capable` only means the firmware can do secure pairing. Ownership is the
     * separate `owner_committed` bit the glasses set after the BLE bond. Mirrors iOS
     * `MentraLiveConnectionAttemptPolicy.pairingInfoConfirmsOwner`.
     */
    fun pairingInfoConfirmsOwner(ownerCommitted: Boolean): Boolean = ownerCommitted

    /**
     * Secure glasses commit an owner only on a BLE bond, and announce it with `pairing_info`
     * `owner_committed`. A stale BOND_BONDED (or a Classic-only bond on the same public address)
     * does not prove the glasses committed this phone, so readiness inside the open window needs
     * both the bond and the owner commit. Callers apply this only to explicit pairing attempts;
     * non-secure (legacy) targets are never gated.
     */
    fun shouldDeferReadyForBond(
            securePairingTarget: Boolean,
            bondState: Int?,
            ownerCommitted: Boolean,
    ): Boolean =
            securePairingTarget &&
                    (bondState != BluetoothDevice.BOND_BONDED ||
                            !pairingInfoConfirmsOwner(ownerCommitted))

    /** How long an explicit secure pair may wait for a bond result before the attempt fails. */
    const val SECURE_BOND_WAIT_MS = 40_000L

    /**
     * Classic audio can come up before the BLE bond or the owner commit. During an explicit
     * secure pair that must not save this phone. A reconnect of an already-paired phone can still
     * mark ready.
     */
    fun shouldMarkReadyFromAudio(
            explicitPairing: Boolean,
            securePairingTarget: Boolean,
            bondState: Int?,
            ownerCommitted: Boolean,
    ): Boolean =
            !explicitPairing ||
                    !shouldDeferReadyForBond(securePairingTarget, bondState, ownerCommitted)
}
