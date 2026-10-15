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
     * standing down. Absent/false stands the previous owner down for that pairing mode only.
     * The next pairing mode lifts the rejection. Mirrors iOS
     * `MentraLiveConnectionAttemptPolicy.shouldYieldOnEnteringPairingMode`.
     */
    fun shouldYieldOnEnteringPairingMode(ownerRetained: Boolean): Boolean = ownerRetained

    /**
     * `pairing_info.retained_owner_link`: this phone is the owner the glasses kept. An
     * automatic reconnect that lands here means the glasses are in pairing mode and this
     * phone missed the notice, so it stands down for the window. An explicit pair is never
     * blocked: the glasses let the owner back in and close the window, so whichever phone
     * gets there first wins. Mirrors iOS
     * `MentraLiveConnectionAttemptPolicy.shouldYieldForRetainedOwnerLink`.
     */
    fun shouldYieldForRetainedOwnerLink(retainedOwnerLink: Boolean, explicitPairing: Boolean): Boolean =
            retainedOwnerLink && !explicitPairing

    /**
     * Automatic reconnect must not take the single BLE slot while the glasses are still in
     * pairing mode. An explicit pairing attempt (the new phone, or Pair again) still connects.
     * Mirrors iOS `MentraLiveConnectionAttemptPolicy.shouldStandDownInsteadOfReconnect`.
     */
    fun shouldStandDownInsteadOfReconnect(
            pairingMode: Boolean,
            savedGlasses: Boolean,
            explicitPairing: Boolean,
    ): Boolean = pairingMode && savedGlasses && !explicitPairing

    /**
     * Remaining yield after a process restart. A missing, expired, or implausible deadline
     * returns 0 so the phone reconnects. Mirrors iOS
     * `MentraLiveConnectionAttemptPolicy.persistedYieldRemainingMs`.
     */
    fun persistedYieldRemainingMs(untilWallMs: Long, nowWallMs: Long): Long {
        if (untilWallMs <= 0L) return 0L
        val remaining = untilWallMs - nowWallMs
        if (remaining <= 0L || remaining > PAIRING_WINDOW_ABSOLUTE_MS) return 0L
        return remaining
    }

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
     * How long a link may stay up after the glasses ask for `confirm_replace_owner`.
     * If the phone never confirms, both sides drop the connection. Matches the
     * glasses `LXY_PAIRING_CONFIRM_IGNORE_MS`.
     */
    const val CONFIRM_IGNORE_MS = 20_000L

    /** `glasses_ready` must not become a connected session while replace-owner is unanswered. */
    fun shouldAcceptReadyWhileAwaitingConfirm(awaitingConfirm: Boolean): Boolean = !awaitingConfirm

    /**
     * An explicit secure pair must not call `createBond` until `pairing_info` says the transfer
     * gate is open. Starting SMP while the glasses still require `confirm_replace_owner` makes
     * them reject the pair and drop the link.
     */
    fun shouldDeferCtkdBond(
            explicitPairing: Boolean,
            secureTarget: Boolean,
            bondState: Int,
            pairingInfoSeen: Boolean,
            awaitingConfirm: Boolean,
    ): Boolean =
            explicitPairing &&
                    secureTarget &&
                    bondState != BluetoothDevice.BOND_BONDED &&
                    (!pairingInfoSeen || awaitingConfirm)

    /**
     * The retained owner's link normally encrypts with the phone's saved key and the glasses
     * reclaim ownership on their own. A phone that has no key left (user forgot it, Pair again)
     * must start SMP itself; the glasses accept it from the retained owner's address.
     */
    fun shouldStartBondForRetainedOwner(
            retainedOwnerLink: Boolean,
            explicitPairing: Boolean,
            bondState: Int,
    ): Boolean =
            retainedOwnerLink && explicitPairing && bondState == BluetoothDevice.BOND_NONE

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

/**
 * The first pairing mode stands the previous owner's phone down so it does not fight a new
 * phone for the BLE slot. That rejection ends when pairing mode is entered again.
 *
 * The stand-down happens while the first window is already advertising, so those advertisements
 * are not a second entry. The watch starts inside that window. A later rising edge (the pairing
 * flag dropped, or advertisements went quiet, then pairing mode is on again) is the next entry.
 * A changed [pairingGeneration] is also a new entry, even when the flag never dropped.
 */
internal class PreviousOwnerRejectionWatch {
    enum class Phase {
        IDLE,
        INSIDE_FIRST,
        WAITING_FOR_NEXT,
    }

    companion object {
        /** Advertisements this quiet mean the first window stopped. Not itself a reconnect. */
        const val QUIET_MS = 8_000L
    }

    var phase: Phase = Phase.IDLE
        private set

    private var stoodDownGeneration: Int? = null

    val isActive: Boolean
        get() = phase != Phase.IDLE

    val isInsideFirst: Boolean
        get() = phase == Phase.INSIDE_FIRST

    /** Generation seen in the first window, if the advertisement carried one. */
    val rememberedGeneration: Int?
        get() = stoodDownGeneration

    /** First pairing-mode entry. Starts inside that window. */
    fun beginFirstWindow() {
        phase = Phase.INSIDE_FIRST
        stoodDownGeneration = null
    }

    /**
     * A previous process already rejected this phone. The next pairing-mode advertisement
     * lifts it. Does nothing when a window is already being watched.
     */
    fun resumeWaitingForNext(generation: Int? = null) {
        if (phase != Phase.IDLE) return
        phase = Phase.WAITING_FOR_NEXT
        stoodDownGeneration = generation
    }

    /** Restore a watch that survived the process. */
    fun restore(phase: Phase, generation: Int?) {
        this.phase = phase
        stoodDownGeneration = generation
    }

    /** Pairing-mode advertisements stopped, so the next one is a new entry. */
    fun noteQuiet() {
        if (phase == Phase.INSIDE_FIRST) phase = Phase.WAITING_FOR_NEXT
    }

    /**
     * @return true when this observation is a later pairing mode and the rejection ends.
     */
    fun onAdvertisement(pairingMode: Boolean, pairingGeneration: Int?): Boolean {
        if (phase == Phase.IDLE) return false
        if (pairingMode && pairingGeneration != null) {
            val previous = stoodDownGeneration
            if (previous == null && phase == Phase.INSIDE_FIRST) {
                stoodDownGeneration = pairingGeneration
            } else if (previous != null && pairingGeneration != previous) {
                clear()
                return true
            }
        }
        if (!pairingMode) {
            if (phase == Phase.INSIDE_FIRST) phase = Phase.WAITING_FOR_NEXT
            return false
        }
        if (phase == Phase.WAITING_FOR_NEXT) {
            clear()
            return true
        }
        return false
    }

    /** A later `entering_pairing_mode` while already rejected is the next entry. */
    fun onEnteringPairingModeAgain(): Boolean {
        if (phase == Phase.IDLE) return false
        clear()
        return true
    }

    fun clear() {
        phase = Phase.IDLE
        stoodDownGeneration = null
    }
}
