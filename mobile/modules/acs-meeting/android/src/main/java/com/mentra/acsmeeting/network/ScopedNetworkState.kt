package com.mentra.acsmeeting.network

/**
 * Pure lifecycle state machine for a scoped SoftAP network join.
 *
 * Split from the Android shell so the awkward parts — duplicate callbacks, callbacks arriving after
 * a cancel, a timeout racing a late `onAvailable` — are unit testable without a device. The shell
 * ([ScopedSoftApNetwork]) owns `ConnectivityManager` and forwards raw callbacks in here.
 *
 * `ConnectivityManager` gives no ordering or at-most-once guarantee: `onAvailable` can fire more
 * than once, `onCapabilitiesChanged` fires repeatedly, and callbacks from a request that was already
 * unregistered can still land. Every transition below is therefore idempotent and generation-guarded.
 */
class ScopedNetworkState {

    enum class Phase {
        /** No request outstanding. */
        IDLE,

        /** `requestNetwork` issued, waiting for a usable network. */
        REQUESTING,

        /** Network joined and usable. */
        AVAILABLE,

        /** Terminal for this generation: released, lost, timed out, or failed. */
        LOST,
    }

    /** Why a join ended without producing a usable network. */
    enum class Failure {
        NONE,
        TIMEOUT,
        UNAVAILABLE,
        LOST,
        PERMISSION_DENIED,
        REQUEST_FAILED,
    }

    var phase: Phase = Phase.IDLE
        private set

    var failure: Failure = Failure.NONE
        private set

    /** Incremented on every new request so late callbacks from an old one can be rejected. */
    var generation: Int = 0
        private set

    val isActive: Boolean
        get() = phase == Phase.REQUESTING || phase == Phase.AVAILABLE

    /**
     * Begin a new join. Any in-flight generation is abandoned, so its callbacks become stale.
     *
     * @return the generation for this request; pass it back to every callback
     */
    fun startRequest(): Int {
        generation += 1
        phase = Phase.REQUESTING
        failure = Failure.NONE
        return generation
    }

    /** True when a callback belongs to the current, still-active generation. */
    fun accepts(callbackGeneration: Int): Boolean = callbackGeneration == generation && isActive

    /**
     * A usable network arrived.
     *
     * @return true if this transitioned the machine; false when stale or already available
     */
    fun onAvailable(callbackGeneration: Int): Boolean {
        if (!accepts(callbackGeneration)) return false
        if (phase == Phase.AVAILABLE) return false // duplicate onAvailable
        phase = Phase.AVAILABLE
        return true
    }

    /** The request timed out before a usable network arrived. Ignored once available. */
    fun onTimeout(callbackGeneration: Int): Boolean {
        if (callbackGeneration != generation) return false
        if (phase != Phase.REQUESTING) return false
        phase = Phase.LOST
        failure = Failure.TIMEOUT
        return true
    }

    /** The framework reported the network cannot be provided. */
    fun onUnavailable(callbackGeneration: Int): Boolean {
        if (!accepts(callbackGeneration)) return false
        phase = Phase.LOST
        failure = Failure.UNAVAILABLE
        return true
    }

    /** The joined network went away. This is the one the call path must react to. */
    fun onLost(callbackGeneration: Int): Boolean {
        if (!accepts(callbackGeneration)) return false
        phase = Phase.LOST
        failure = Failure.LOST
        return true
    }

    /** `requestNetwork` threw, or the local-network permission was denied. */
    fun onRequestFailed(callbackGeneration: Int, permissionDenied: Boolean): Boolean {
        if (callbackGeneration != generation) return false
        if (!isActive) return false
        phase = Phase.LOST
        failure = if (permissionDenied) Failure.PERMISSION_DENIED else Failure.REQUEST_FAILED
        return true
    }

    /** Caller-initiated teardown. Not a failure. */
    fun release(): Boolean {
        if (!isActive) return false
        phase = Phase.LOST
        failure = Failure.NONE
        return true
    }

    /** Return to IDLE so the same instance can be reused for the next call. */
    fun reset() {
        phase = Phase.IDLE
        failure = Failure.NONE
    }
}
