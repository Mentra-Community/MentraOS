package com.mentra.bluetoothsdk.sgcs

/**
 * Public Mentra Live pairing state (`MentraLivePairingState` in BluetoothSdk.types.ts).
 * Mirrors iOS `MentraLivePairingState`.
 */
internal sealed class MentraLivePairingState {
    object Normal : MentraLivePairingState()

    /** The glasses opened a pairing window. Automatic reconnect waits until [endsAtMs] (wall clock). */
    data class PairingMode(val windowId: Int, val endsAtMs: Long) : MentraLivePairingState()

    /** The glasses no longer accept this phone. Only an explicit pair or a forget clears it. */
    object Rejected : MentraLivePairingState()

    fun toMap(): Map<String, Any> =
            when (this) {
                Normal -> mapOf("state" to "normal")
                is PairingMode ->
                        mapOf("state" to "pairing_mode", "windowId" to windowId, "endsAtMs" to endsAtMs)
                Rejected -> mapOf("state" to "pairing_rejected")
            }
}

/** What the connection manager must do after a [MentraLivePairingStateMachine] input. */
internal enum class MentraLivePairingEffect {
    NONE,
    /** Leave the link and make no automatic connection until resumed. */
    PAUSE,
    /** The window is over: reconnect to the saved glasses. */
    RESUME,
    /** Stop reconnecting. The glasses belong to another phone. */
    REJECT,
}

internal data class MentraLivePairingTransition(
        val effect: MentraLivePairingEffect,
        val stateChanged: Boolean,
        val note: String,
)

/**
 * Pairing-mode pause/resume, takeover detection and rejection detection for one saved Mentra Live
 * (pairing spec "Ownership transfer v4"). Pure and clock-free: every input carries `nowMs`
 * (wall clock, because the pause deadline survives a process restart). Mirrors iOS
 * `MentraLivePairingStateMachine` input for input.
 */
internal class MentraLivePairingStateMachine {
    companion object {
        /** Glasses flag-clear advertisements seen this soon after the notice can predate the window. */
        const val FLAG_CLEAR_GRACE_MS = 3_000L

        /** A pairing-mode advertisement this recent still means the glasses are in pairing mode. */
        const val PAIRING_ADVERT_FRESH_MS = 10_000L

        /** Window id used when protocol-3 firmware sends `owner_retained` without `window_id`. */
        const val UNKNOWN_WINDOW_ID = -1

        const val KEY_DEVICE_ID = "pairing_v4_device_id"
        const val KEY_STATE = "pairing_v4_state"
        const val KEY_WINDOW_ID = "pairing_v4_window_id"
        const val KEY_ENDS_AT_MS = "pairing_v4_ends_at_ms"
        const val KEY_PAUSE_MS = "pairing_v4_pause_ms"
        const val KEY_ENDED_WINDOW_ID = "pairing_v4_ended_window_id"
        const val KEY_VERIFIED_WINDOW_ID = "pairing_v4_verified_window_id"
        val KEYS =
                listOf(
                        KEY_DEVICE_ID,
                        KEY_STATE,
                        KEY_WINDOW_ID,
                        KEY_ENDS_AT_MS,
                        KEY_PAUSE_MS,
                        KEY_ENDED_WINDOW_ID,
                        KEY_VERIFIED_WINDOW_ID,
                )

        /** Pre-v4 stand-down phase. Its presence migrates to [MentraLivePairingState.Rejected]. */
        const val LEGACY_REJECTION_PHASE_KEY = "previous_owner_rejection_phase"
        val LEGACY_KEYS =
                listOf(
                        LEGACY_REJECTION_PHASE_KEY,
                        "previous_owner_rejection_generation",
                        "pairing_yield_until_wall_ms",
                )

        private const val STATE_PAIRING_MODE = "pairing_mode"
        private const val STATE_REJECTED = "pairing_rejected"

        private fun intValue(value: Any?): Int? = (value as? Number)?.toInt()

        private fun longValue(value: Any?): Long? = (value as? Number)?.toLong()
    }

    var state: MentraLivePairingState = MentraLivePairingState.Normal
        private set

    /** Saved glasses this record belongs to. Empty until known. */
    var deviceId: String = ""
        private set

    /** The next connection attempt is the one verification after an `OWNER_CHANGED` advertisement. */
    var verificationArmed: Boolean = false
        private set

    /** The window this phone paused for and that has ended. Read against `OWNER_CHANGED`. */
    var endedWindowId: Int? = null
        private set

    private var pauseMs = 0L
    private var pausedAtMs: Long? = null
    private var verifiedWindowId: Int? = null
    private var lastPairingAdvertAtMs: Long? = null
    private var takeoverAdvertRead = false
    private val streak = MentraLiveOwnerLossPolicy.OwnerRejectionStreak()

    val allowsAutomaticReconnect: Boolean
        get() = state == MentraLivePairingState.Normal

    /**
     * A window this phone paused for has ended and no post-window advertisement has been read,
     * so a reconnect should scan first instead of dialing the saved address directly.
     */
    val awaitingTakeoverCheck: Boolean
        get() = state == MentraLivePairingState.Normal && endedWindowId != null && !takeoverAdvertRead

    val isPaused: Boolean
        get() = state is MentraLivePairingState.PairingMode

    fun remainingPauseMs(nowMs: Long): Long =
            (state as? MentraLivePairingState.PairingMode)?.let { maxOf(0L, it.endsAtMs - nowMs) } ?: 0L

    /**
     * Rebuild from persisted values. Unknown keys and malformed values are ignored. A record for
     * other glasses, or a pause whose deadline passed or is implausible, does not survive.
     */
    fun restore(values: Map<String, *>, savedDeviceId: String, nowMs: Long): MentraLivePairingTransition {
        resetInMemory()
        state = MentraLivePairingState.Normal
        deviceId = values[KEY_DEVICE_ID] as? String ?: ""
        endedWindowId = intValue(values[KEY_ENDED_WINDOW_ID])
        verifiedWindowId = intValue(values[KEY_VERIFIED_WINDOW_ID])
        if (savedDeviceId.isNotEmpty() && deviceId.isNotEmpty() && deviceId != savedDeviceId) {
            clearRecord()
            deviceId = savedDeviceId
            return none("record belongs to other glasses")
        }
        when (values[KEY_STATE] as? String) {
            STATE_REJECTED -> {
                state = MentraLivePairingState.Rejected
                return MentraLivePairingTransition(MentraLivePairingEffect.REJECT, true, "restored rejected")
            }
            STATE_PAIRING_MODE -> {
                val windowId = intValue(values[KEY_WINDOW_ID])
                val endsAtMs = longValue(values[KEY_ENDS_AT_MS]) ?: 0L
                val pause =
                        longValue(values[KEY_PAUSE_MS])
                                ?: MentraLiveOwnerLossPolicy.yieldMs(
                                        MentraLiveOwnerLossPolicy.DEFAULT_PAIRING_WINDOW_MS
                                )
                val remaining = MentraLiveOwnerLossPolicy.persistedYieldRemainingMs(endsAtMs, nowMs, pause)
                if (windowId != null && remaining > 0L) {
                    state = MentraLivePairingState.PairingMode(windowId, endsAtMs)
                    pauseMs = pause
                    return MentraLivePairingTransition(
                            MentraLivePairingEffect.PAUSE,
                            true,
                            "restored pairing_mode window=$windowId remaining=${remaining}ms",
                    )
                }
                if (windowId != null) endedWindowId = windowId
                return none("persisted pause ended while the app was away")
            }
        }
        if (values[LEGACY_REJECTION_PHASE_KEY] is String) {
            state = MentraLivePairingState.Rejected
            return MentraLivePairingTransition(MentraLivePairingEffect.REJECT, true, "migrated legacy stand-down")
        }
        return none("restored normal")
    }

    /** The current record, keyed by [KEYS]. */
    fun persisted(): Map<String, Any> {
        val values = mutableMapOf<String, Any>()
        if (deviceId.isNotEmpty()) values[KEY_DEVICE_ID] = deviceId
        when (val current = state) {
            is MentraLivePairingState.PairingMode -> {
                values[KEY_STATE] = STATE_PAIRING_MODE
                values[KEY_WINDOW_ID] = current.windowId
                values[KEY_ENDS_AT_MS] = current.endsAtMs
                values[KEY_PAUSE_MS] = pauseMs
            }
            MentraLivePairingState.Rejected -> values[KEY_STATE] = STATE_REJECTED
            MentraLivePairingState.Normal -> Unit
        }
        endedWindowId?.let { values[KEY_ENDED_WINDOW_ID] = it }
        verifiedWindowId?.let { values[KEY_VERIFIED_WINDOW_ID] = it }
        return values
    }

    /** An automatic connect to [id]. A record for other glasses no longer applies. */
    fun bindDevice(id: String): MentraLivePairingTransition {
        if (id.isEmpty() || id == deviceId) return none("same glasses")
        val hadRecord = deviceId.isNotEmpty()
        val wasNormal = state == MentraLivePairingState.Normal
        if (hadRecord) clearRecord()
        deviceId = id
        return MentraLivePairingTransition(
                MentraLivePairingEffect.NONE,
                hadRecord && !wasNormal,
                if (hadRecord) "record moved to other glasses" else "bound",
        )
    }

    /**
     * `entering_pairing_mode`. Protocol 4 (`window_id`) pauses this phone for the window plus a
     * margin. Firmware without ownership transfer forgets this phone on entry (pairing spec R4),
     * so a notice without `window_id` or `owner_retained` means the glasses dropped it.
     */
    fun onEnteringPairingMode(
            windowMs: Long?,
            windowId: Int?,
            ownerRetained: Boolean,
            explicitAttempt: Boolean,
            deviceId: String,
            nowMs: Long,
    ): MentraLivePairingTransition {
        if (deviceId.isNotEmpty()) this.deviceId = deviceId
        if (explicitAttempt) return none("notice during an explicit attempt")
        if (windowId == null && !ownerRetained) return reject("forget_on_entry")
        val id = windowId ?: UNKNOWN_WINDOW_ID
        val current = state
        if (current is MentraLivePairingState.PairingMode && current.windowId == id) {
            return none("duplicate notice for window $id")
        }
        val pause = MentraLiveOwnerLossPolicy.yieldMs(windowMs ?: 0L)
        state = MentraLivePairingState.PairingMode(id, nowMs + pause)
        pauseMs = pause
        pausedAtMs = nowMs
        endedWindowId = null
        verificationArmed = false
        streak.reset()
        return MentraLivePairingTransition(
                MentraLivePairingEffect.PAUSE,
                true,
                "pairing_mode window=$id pause=${pause}ms",
        )
    }

    /**
     * `pairing_mode_ended`. Only a connected phone receives it, so the glasses still admit this
     * phone and there is no takeover to check.
     */
    fun onPairingModeEnded(reason: String?, windowId: Int?): MentraLivePairingTransition {
        val current = state as? MentraLivePairingState.PairingMode ?: return none("not paused")
        if (windowId != null && current.windowId != UNKNOWN_WINDOW_ID && windowId != current.windowId) {
            return none("ended window $windowId is not ${current.windowId}")
        }
        state = MentraLivePairingState.Normal
        pausedAtMs = null
        endedWindowId = null
        return MentraLivePairingTransition(
                MentraLivePairingEffect.RESUME,
                true,
                "pairing_mode_ended reason=${reason ?: ""}",
        )
    }

    /**
     * An advertisement from the saved glasses carrying the secure trailer. A cleared pairing flag
     * ends the pause early. After the window this phone paused for, `OWNER_CHANGED` for that
     * window arms exactly one verification attempt.
     */
    fun onAdvertisement(
            pairingMode: Boolean,
            ownerChanged: Boolean,
            generation: Int?,
            nowMs: Long,
    ): MentraLivePairingTransition {
        lastPairingAdvertAtMs = if (pairingMode) nowMs else null
        var effect = MentraLivePairingEffect.NONE
        var changed = false
        val notes = mutableListOf<String>()
        val current = state
        if (current is MentraLivePairingState.PairingMode && !pairingMode) {
            val sincePause = pausedAtMs?.let { nowMs - it } ?: Long.MAX_VALUE
            if (sincePause >= FLAG_CLEAR_GRACE_MS) {
                state = MentraLivePairingState.Normal
                pausedAtMs = null
                endedWindowId = current.windowId
                effect = MentraLivePairingEffect.RESUME
                changed = true
                notes += "pairing flag cleared"
            }
        }
        if (state == MentraLivePairingState.Normal && !pairingMode && endedWindowId != null) {
            takeoverAdvertRead = true
            if (ownerChanged &&
                            generation != null &&
                            generation == endedWindowId &&
                            verifiedWindowId != generation
            ) {
                verificationArmed = true
                verifiedWindowId = generation
                notes += "owner_changed for window $generation — one verification attempt"
            }
        }
        return MentraLivePairingTransition(effect, changed, notes.joinToString("; ").ifEmpty { "advert" })
    }

    /** The pause deadline may have passed. */
    fun onTick(nowMs: Long): MentraLivePairingTransition {
        val current = state as? MentraLivePairingState.PairingMode ?: return none("not paused")
        if (nowMs < current.endsAtMs) return none("pause continues")
        state = MentraLivePairingState.Normal
        pausedAtMs = null
        endedWindowId = current.windowId
        takeoverAdvertRead = false
        return MentraLivePairingTransition(MentraLivePairingEffect.RESUME, true, "pause deadline passed")
    }

    /**
     * One authentication-type failure (Android HCI 0x05/0x0F or bond removed, iOS CBError 14 or
     * insufficient authentication/encryption). The intentional disconnect at window entry, the
     * glasses' 0x14 refusals and anything while pairing mode is in effect never count.
     */
    fun onAuthRejection(
            secureFirmware: Boolean,
            explicitAttempt: Boolean,
            nowMs: Long,
    ): MentraLivePairingTransition {
        if (!secureFirmware) return none("legacy firmware")
        if (explicitAttempt) return none("explicit attempt")
        when (state) {
            is MentraLivePairingState.PairingMode -> return none("pairing_mode in effect")
            MentraLivePairingState.Rejected -> return none("already rejected")
            MentraLivePairingState.Normal -> Unit
        }
        if (advertShowsPairingMode(nowMs)) return none("advertisement shows pairing mode")
        if (verificationArmed) {
            return reject("owner_changed_verification_failed")
        }
        if (!streak.record(nowMs)) return none("counted toward the rejection streak")
        return reject("auth_rejection_streak")
    }

    /** The verification attempt ended without an authentication verdict. */
    fun onConnectAttemptFailed(): MentraLivePairingTransition {
        if (!verificationArmed) return none("no verification")
        verificationArmed = false
        return none("verification attempt failed without an auth verdict")
    }

    /** A session reached ready. An explicit pair clears [MentraLivePairingState.Rejected]. */
    fun onSessionReady(explicitAttempt: Boolean): MentraLivePairingTransition {
        streak.reset()
        verificationArmed = false
        endedWindowId = null
        lastPairingAdvertAtMs = null
        val current = state
        val clear =
                current is MentraLivePairingState.PairingMode ||
                        (explicitAttempt && current == MentraLivePairingState.Rejected)
        if (!clear) return none("ready")
        state = MentraLivePairingState.Normal
        pausedAtMs = null
        return MentraLivePairingTransition(
                MentraLivePairingEffect.NONE,
                true,
                if (explicitAttempt) "explicit pair succeeded" else "glasses admitted this phone",
        )
    }

    fun onForget(): MentraLivePairingTransition {
        val changed = state != MentraLivePairingState.Normal
        clearRecord()
        deviceId = ""
        return MentraLivePairingTransition(MentraLivePairingEffect.NONE, changed, "forget")
    }

    private fun advertShowsPairingMode(nowMs: Long): Boolean =
            lastPairingAdvertAtMs?.let { nowMs - it in 0..PAIRING_ADVERT_FRESH_MS } == true

    private fun reject(reason: String): MentraLivePairingTransition {
        state = MentraLivePairingState.Rejected
        pausedAtMs = null
        endedWindowId = null
        verificationArmed = false
        streak.reset()
        return MentraLivePairingTransition(MentraLivePairingEffect.REJECT, true, reason)
    }

    private fun clearRecord() {
        resetInMemory()
        state = MentraLivePairingState.Normal
        endedWindowId = null
        verifiedWindowId = null
    }

    private fun resetInMemory() {
        pauseMs = 0L
        pausedAtMs = null
        verificationArmed = false
        lastPairingAdvertAtMs = null
        takeoverAdvertRead = false
        streak.reset()
    }

    private fun none(note: String) = MentraLivePairingTransition(MentraLivePairingEffect.NONE, false, note)
}
