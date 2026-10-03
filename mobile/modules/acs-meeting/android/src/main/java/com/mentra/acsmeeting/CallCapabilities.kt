package com.mentra.acsmeeting

/**
 * One ACS participant capability, as reported to the host.
 *
 * [allowed] is nullable on purpose. "Denied" and "not known yet" are different facts and the UI has
 * to treat them differently: a denied End must be hidden, while an unknown one is what every call
 * looks like for the moment between joining and the first capabilities event.
 */
data class CapabilityStatus(val allowed: Boolean? = null, val reason: String? = null) {
    fun toMap(): Map<String, Any?> = mapOf("allowed" to allowed, "reason" to reason)
}

/**
 * Whether an End-for-everyone attempt should be made at all.
 *
 * Teams only lets a presenter end a meeting for everyone, and ACS surfaces that as the runtime
 * capability `HANG_UP_FOR_EVERYONE`. Refusing a known-denied End locally is better than sending it:
 * ACS rejects it with an opaque error, and the wearer would have watched a confirm sheet for
 * nothing. An *unknown* capability is not a refusal — it is the ordinary state before the first
 * capabilities event lands, and letting the service decide is more honest than guessing.
 */
object EndForEveryonePolicy {

    const val REFUSED_PREFIX = "hang_up_for_everyone_not_allowed"

    /** The refusal to report, or null when the End should be attempted. */
    fun refusalFor(status: CapabilityStatus): String? {
        if (status.allowed != false) return null
        val reason = status.reason?.takeIf { it.isNotBlank() } ?: "unknown"
        return "$REFUSED_PREFIX:$reason"
    }
}
