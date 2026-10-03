package com.mentra.glassesmedia.network

/**
 * Decides when a joined scoped network is actually ready for ICE to gather on.
 *
 * `onAvailable` is not that moment. Android's own guidance is to wait for `onLinkPropertiesChanged`
 * and `onCapabilitiesChanged` rather than reading properties synchronously inside `onAvailable`, and
 * on device the consequence was concrete: the hotspot address can land in the kernel's interface
 * table *after* `onAvailable` returns, and libwebrtc gathers from that table. Starting ingest on
 * `onAvailable` therefore raced the address into existence, and losing that race is indistinguishable
 * from the wiring bugs it was mistaken for.
 *
 * Readiness needs agreement from three places, so all three are recorded separately and the missing
 * one is named. The kernel table is the odd one out: it has no callback, so the shell polls it and
 * feeds the answer in through [onInterfaceTable].
 *
 * Pure and mutable-but-self-contained, so the awkward orderings are unit testable without a device.
 */
class ScopedNetworkReadiness {

    /** What each source has reported so far. Null means "not yet", not "absent". */
    data class Observations(
        val available: Boolean = false,
        val capabilities: Boolean = false,
        val linkInterface: String? = null,
        val linkAddress: String? = null,
        val tableOwner: String? = null,
    )

    sealed interface Verdict {
        /**
         * [owner] is the interface the kernel says holds [address]. It can differ from
         * [interfaceName], which is what `LinkProperties` claimed — a disagreement worth logging,
         * not worth blocking on, since ICE only ever uses the address.
         */
        data class Ready(
            val address: String,
            val interfaceName: String?,
            val owner: String,
        ) : Verdict

        /** [missing] names the one source still to report, for the timeout message. */
        data class Waiting(val missing: String) : Verdict
    }

    @Volatile
    var observations = Observations()
        private set

    private val lock = Any()

    fun onAvailable() = update { it.copy(available = true) }

    fun onCapabilities() = update { it.copy(capabilities = true) }

    /**
     * Taken verbatim: `LinkProperties` carries the network's whole current state, so a later
     * callback without an address means the address is gone, not that the old one still holds.
     */
    fun onLinkProperties(interfaceName: String?, address: String?) =
        update { it.copy(linkInterface = interfaceName, linkAddress = address) }

    /** Seed from the synchronous read in `onAvailable`; never clears what a callback reported. */
    fun seedLinkProperties(interfaceName: String?, address: String?) =
        update {
            if (address == null) it else it.copy(linkInterface = interfaceName, linkAddress = address)
        }

    fun onInterfaceTable(owner: String?) = update { it.copy(tableOwner = owner) }

    fun reset() = update { Observations() }

    fun verdict(): Verdict = verdictOf(observations)

    /** True once everything with a callback has reported, so only the table poll is left. */
    fun callbacksSatisfied(): Boolean = callbacksSatisfiedBy(observations)

    private inline fun update(transform: (Observations) -> Observations) {
        synchronized(lock) { observations = transform(observations) }
    }

    companion object {
        fun callbacksSatisfiedBy(observations: Observations): Boolean =
            observations.available && observations.capabilities && observations.linkAddress != null

        /** Ordered so the named blocker is the earliest unmet one, which is the useful one. */
        fun verdictOf(observations: Observations): Verdict =
            when {
                !observations.available -> Verdict.Waiting("onAvailable")
                !observations.capabilities -> Verdict.Waiting("onCapabilitiesChanged")
                observations.linkAddress == null ->
                    Verdict.Waiting("an IPv4 address from onLinkPropertiesChanged")
                observations.tableOwner == null ->
                    Verdict.Waiting("the kernel interface table to carry ${observations.linkAddress}")
                else ->
                    Verdict.Ready(
                        observations.linkAddress,
                        observations.linkInterface,
                        observations.tableOwner,
                    )
            }
    }
}
