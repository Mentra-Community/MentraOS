package com.mentra.acsmeeting.source

import com.mentra.acsmeeting.network.Ipv4Prefix
import com.mentra.acsmeeting.network.ScopedNetworkChangeDetector.PublishedEntry

/**
 * Separates the causes of "the answer carried no hotspot candidate".
 *
 * That single symptom has been produced on device by four different faults, and a coarse error code
 * cannot tell them apart — which is how one of them was misattributed and "fixed" by a change that
 * created the next. Each fault is distinguished by state that only exists at the moment of
 * gathering, so it is captured there and reduced to a [Fault] rather than inferred from logs later:
 *
 *  - the hotspot address is not in the kernel's interface table, so nothing could have gathered it
 *  - the address is there but the inventory libwebrtc holds does not contain the hotspot, or two
 *    entries share a handle so one overwrote the other
 *  - both are fine and still nothing was gathered, which leaves the socket bind
 *  - candidates were gathered, none on the hotspot, so the wrong address is being advertised
 *
 * The [Fault] is a hypothesis narrowed by observation, not a proof; the raw fields travel with it so
 * a run can be re-read without trusting the classifier.
 */
object SoftApIceDiagnosis {

    /** The narrowed cause. Ordered from "cannot possibly work" to "worked, wrong answer". */
    enum class Fault {
        /** The scoped address is absent from `getifaddrs`. ICE has nothing to gather. */
        MISSING_INTERFACE,

        /** The hotspot is not in libwebrtc's inventory, or a handle collision dropped it. */
        ERASED_ENTRY,

        /** Address present, entry published, zero candidates: the socket could not bind. */
        FAILED_BINDING,

        /** Candidates gathered, none on the hotspot: a truthful port with the wrong address. */
        WRONG_ADDRESS,

        /** The observations do not narrow to one cause. */
        INDETERMINATE,
    }

    /** A gathered candidate reduced to the two things that matter: its address and whose it is. */
    data class CandidateFact(val address: String?, val owner: String?, val onHotspot: Boolean) {
        override fun toString(): String = "${address ?: "?"}@${owner ?: "ABSENT"}"
    }

    data class Diagnosis(
        val code: String,
        val fault: Fault,
        val scopedAddress: String?,
        val scopedOwner: String?,
        val scopedPrefix: Ipv4Prefix?,
        val published: List<PublishedEntry>,
        val candidates: List<CandidateFact>,
    ) {
        val scopedInTable: Boolean
            get() = scopedOwner != null

        val hotspotCandidates: List<CandidateFact>
            get() = candidates.filter { it.onHotspot }

        val offHotspot: List<CandidateFact>
            get() = candidates.filterNot { it.onHotspot }

        /**
         * Flattened for [SoftApTrace][com.mentra.acsmeeting.trace.SoftApTrace] and the analyzer.
         * Field names are the contract `softap-call-proof.mjs` reads, so they are stable.
         */
        fun fields(): Array<Pair<String, Any?>> =
            arrayOf(
                "code" to code,
                "fault" to fault.name,
                "scopedAddress" to (scopedAddress ?: "none"),
                "scopedOwner" to (scopedOwner ?: "ABSENT"),
                "scopedInTable" to scopedInTable,
                "scopedPrefix" to (scopedPrefix?.toString() ?: "unknown"),
                "publishedInventory" to
                    published.joinToString(",").ifEmpty { "none" },
                "publishedHotspot" to publishesHotspot(),
                "handleCollision" to hasHandleCollision(),
                "gathered" to candidates.size,
                "hotspotCandidates" to hotspotCandidates.size,
                "offHotspot" to offHotspot.joinToString(",").ifEmpty { "none" },
            )

        internal fun publishesHotspot(): Boolean =
            scopedAddress != null && published.any { scopedAddress in it.addresses }

        internal fun hasHandleCollision(): Boolean {
            val handles = published.map { it.handle }
            return handles.size != handles.distinct().size
        }
    }

    /** Coarse label: nothing was gathered at all. */
    const val CODE_NO_CANDIDATES = "no_candidates_gathered"

    /** Coarse label: candidates exist, but every one is off the hotspot. */
    const val CODE_ONLY_NON_HOTSPOT = "only_non_hotspot_candidates"

    /**
     * Classify a failed gathering pass.
     *
     * [scopedOwner] is the interface the kernel says owns [scopedAddress], normally from
     * `NetworkFacts.ownerOf`; null means the address is not in the table.
     */
    fun diagnose(
        scopedAddress: String?,
        scopedOwner: String?,
        scopedPrefix: Ipv4Prefix?,
        published: List<PublishedEntry>,
        candidates: List<CandidateFact>,
    ): Diagnosis {
        val code =
            if (candidates.isEmpty()) CODE_NO_CANDIDATES else CODE_ONLY_NON_HOTSPOT
        val partial =
            Diagnosis(
                code,
                Fault.INDETERMINATE,
                scopedAddress,
                scopedOwner,
                scopedPrefix,
                published,
                candidates,
            )
        return partial.copy(fault = classify(partial))
    }

    /**
     * Order is load-bearing. A missing interface also looks like a failed bind, and an erased entry
     * also looks like one, so the checks that rule those out have to come first — otherwise every
     * run is blamed on the socket and the actual cause is never seen.
     */
    private fun classify(diagnosis: Diagnosis): Fault =
        when {
            diagnosis.scopedAddress == null -> Fault.MISSING_INTERFACE
            !diagnosis.scopedInTable -> Fault.MISSING_INTERFACE
            !diagnosis.publishesHotspot() || diagnosis.hasHandleCollision() -> Fault.ERASED_ENTRY
            diagnosis.candidates.isEmpty() -> Fault.FAILED_BINDING
            diagnosis.hotspotCandidates.isEmpty() -> Fault.WRONG_ADDRESS
            else -> Fault.INDETERMINATE
        }
}
