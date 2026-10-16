package com.mentra.bluetoothsdk.sgcs

import android.bluetooth.BluetoothDevice

/**
 * Pure predicates behind Mentra Live pairing-mode pauses and rejection detection (pairing spec
 * "Ownership transfer v4"). [MentraLivePairingStateMachine] owns the state; this object holds
 * the per-signal rules both use. Mirrors iOS `MentraLiveConnectionAttemptPolicy`.
 *
 * Outside a pairing window the glasses reject a phone they no longer bond with at connect time
 * (HCI Authentication Failure). A single rejection is only a hint: a glasses reboot, a stale
 * bond, or a radio hiccup can produce one. Only secure-pairing firmware rejects on purpose, and
 * only a rejection that repeats across automatic reconnects ([OwnerRejectionStreak]) counts.
 */
internal object MentraLiveOwnerLossPolicy {
    /** `entering_pairing_mode.window_ms` when the glasses omit it. */
    const val DEFAULT_PAIRING_WINDOW_MS = 120_000L

    /** Covers the glasses' bounded close deferral (30 s) after the window timer. */
    const val PAIRING_RESUME_MARGIN_MS = 30_000L

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

    /**
     * HCI 0x05 Authentication Failure / 0x0F Unacceptable BD_ADDR from a connect-time rejection.
     * The glasses refuse the previous owner during a window with 0x14, which never counts.
     */
    fun isOwnerRejectionStatus(status: Int): Boolean = status == 0x05 || status == 0x0F

    /**
     * A connect-time rejection of saved secure glasses. Legacy firmware never rejects a
     * non-owner on purpose, and during an explicit pairing attempt the user is pairing anew.
     * This is one observation; [MentraLivePairingStateMachine.onAuthRejection] decides what it adds up to.
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

    /**
     * How long automatic reconnect pauses for a window: the window plus the close-deferral
     * margin. No floor beyond a missing value and no upper clamp; the glasses own the window.
     */
    fun yieldMs(windowMs: Long): Long =
            (if (windowMs > 0L) windowMs else DEFAULT_PAIRING_WINDOW_MS) + PAIRING_RESUME_MARGIN_MS

    /**
     * Remaining pause after a process restart. A missing, expired, or implausible deadline (more
     * than the pause that was persisted with it) returns 0 so the phone reconnects. Mirrors iOS
     * `MentraLiveConnectionAttemptPolicy.persistedYieldRemainingMs`.
     */
    fun persistedYieldRemainingMs(untilWallMs: Long, nowWallMs: Long, pauseMs: Long): Long {
        if (untilWallMs <= 0L || pauseMs <= 0L) return 0L
        val remaining = untilWallMs - nowWallMs
        if (remaining <= 0L || remaining > pauseMs) return 0L
        return remaining
    }

    /**
     * Automatic reconnect must not take the single BLE slot while the saved glasses advertise
     * pairing mode. An explicit pairing attempt (the new phone, or Pair Again) still connects.
     * Mirrors iOS `MentraLiveConnectionAttemptPolicy.shouldStandDownInsteadOfReconnect`.
     */
    fun shouldStandDownInsteadOfReconnect(
            pairingMode: Boolean,
            savedGlasses: Boolean,
            explicitPairing: Boolean,
    ): Boolean = pairingMode && savedGlasses && !explicitPairing

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
     * Readiness parked by [shouldDeferReadyForBond] always has a deadline: an explicit secure
     * attempt arms the bond wait, so a missing bond broadcast or owner commit fails the pair
     * instead of leaving it loading. Mirrors iOS `shouldRunSecurePairingWait`.
     */
    fun shouldRunSecureBondWait(explicitPairing: Boolean, securePairingTarget: Boolean): Boolean =
            explicitPairing && securePairingTarget

    /**
     * An explicit secure pair must not call `createBond` before `pairing_info` arrives: the
     * glasses ask for security themselves once they know the link, and an early SMP races it.
     */
    fun shouldDeferCtkdBond(
            explicitPairing: Boolean,
            secureTarget: Boolean,
            bondState: Int,
            pairingInfoSeen: Boolean,
    ): Boolean =
            explicitPairing &&
                    secureTarget &&
                    bondState != BluetoothDevice.BOND_BONDED &&
                    !pairingInfoSeen

    /**
     * `pair_select` tells the glasses this link is the user's explicit choice (pairing spec V4).
     * It goes out once per GATT session, only on an explicit attempt to secure glasses, never on
     * an automatic reconnect. Legacy firmware has no use for it.
     */
    fun shouldSendPairSelect(explicitPairing: Boolean, securePairingTarget: Boolean): Boolean =
            explicitPairing && securePairingTarget

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
