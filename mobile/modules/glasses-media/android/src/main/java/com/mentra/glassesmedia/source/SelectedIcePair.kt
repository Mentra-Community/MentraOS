package com.mentra.glassesmedia.source

import com.mentra.glassesmedia.network.Ipv4Prefix

/**
 * Reads the path media is *actually* taking out of a WebRTC stats sample.
 *
 * The SDP guard checks what each side offered. That is necessary and not sufficient: an answer can
 * carry a perfectly good hotspot candidate and ICE can still select a different pair, at which point
 * the SoftAP call is running over an interface that either cannot reach the glasses or defeats the
 * whole point of the transport. The only honest question is which pair got nominated.
 *
 * ## Why the selection is followed rather than inferred
 *
 * This used to pick "a nominated succeeded pair, else any succeeded pair, else whichever pair has
 * the most received bytes". None of those identify the current path. A succeeded pair is only a pair
 * that once passed a connectivity check, and historical bytes belong to a pair that may have been
 * replaced. Using it as acceptance evidence meant a run could be graded on a pair that was not
 * carrying the call.
 *
 * The transport's `selectedCandidatePairId` is the specification's answer to exactly this question,
 * so it is read and followed. When it is not available the verdict is [IcePathVerdict.Unknown] —
 * insufficient evidence, never a pass.
 *
 * Kept free of `org.webrtc` types so the decision is unit testable; [LocalWhipIngestSource] adapts
 * `RTCStatsReport` into these shapes.
 */
data class IceCandidatePairStats(
  val id: String,
  /** `succeeded`, `in-progress`, `failed`, … as libwebrtc spells it. */
  val state: String?,
  val nominated: Boolean,
  val localCandidateId: String?,
  val remoteCandidateId: String?,
  val bytesReceived: Long,
)

data class IceCandidateStats(
  val id: String,
  val address: String?,
  val candidateType: String?,
)

/** The transport entry, for the one field that names the pair in use. */
data class IceTransportStats(val id: String, val selectedCandidatePairId: String?)

sealed interface IcePathVerdict {
  /**
   * Media is on the network we joined.
   *
   * [pairId] and [iceGeneration] are carried so two samples can be compared as the same path. Byte
   * growth across a pair change says nothing, and comparing it anyway is how an idle path could
   * read as a flowing one.
   */
  data class OnHotspot(
    val pairId: String,
    val iceGeneration: Int,
    val local: String,
    val remote: String?,
    val bytesReceived: Long,
  ) : IcePathVerdict

  /** A pair was selected and it is not on the hotspot. This is the silent failure worth killing. */
  data class OffHotspot(val pairId: String, val local: String?, val prefix: String) : IcePathVerdict

  /** Not enough information to judge. Never a pass, and never on its own a reason to fail a call. */
  data class Unknown(val reason: String) : IcePathVerdict
}

object SelectedIcePair {

  /**
   * The pair the transport says is selected, or null with the reason it could not be identified.
   *
   * Deliberately no fallback. Every fallback that was here answered a different question than
   * "which pair is carrying this call".
   */
  fun selected(
    transports: List<IceTransportStats>,
    pairs: List<IceCandidatePairStats>,
  ): Result<IceCandidatePairStats> {
    if (transports.isEmpty()) return Result.failure(Missing("no_transport_stats"))
    val selectedId =
      transports.firstNotNullOfOrNull { it.selectedCandidatePairId }
        ?: return Result.failure(Missing("no_selected_pair"))
    val pair =
      pairs.firstOrNull { it.id == selectedId }
        ?: return Result.failure(Missing("selected_pair_absent_from_report"))
    return Result.success(pair)
  }

  /** Carries the reason a selection could not be identified, for the trace. */
  class Missing(val reason: String) : Exception(reason)

  fun verdict(
    transports: List<IceTransportStats>,
    pairs: List<IceCandidatePairStats>,
    candidates: Map<String, IceCandidateStats>,
    prefix: Ipv4Prefix?,
    iceGeneration: Int,
  ): IcePathVerdict {
    val pair =
      selected(transports, pairs).getOrElse { error ->
        return IcePathVerdict.Unknown((error as? Missing)?.reason ?: "selection_failed")
      }
    // No prefix means the host could not describe the network it joined. Reporting that as
    // "off hotspot" would fail healthy calls on any host whose LinkProperties read came back empty.
    if (prefix == null) return IcePathVerdict.Unknown("no_scoped_prefix")
    val local = pair.localCandidateId?.let { candidates[it] }?.address
      ?: return IcePathVerdict.Unknown("no_local_candidate")
    val remote = pair.remoteCandidateId?.let { candidates[it] }?.address
    if (!prefix.contains(local)) return IcePathVerdict.OffHotspot(pair.id, local, prefix.toString())
    return IcePathVerdict.OnHotspot(pair.id, iceGeneration, local, remote, pair.bytesReceived)
  }

  /** Outcome of comparing two samples. Only [Flow.Compared] says anything about media. */
  sealed interface Flow {
    data class Compared(val before: Long, val after: Long) : Flow {
      val flowing: Boolean
        get() = after > before
    }

    /** The samples are not the same path, so growth between them is not evidence either way. */
    data class NotComparable(val reason: String) : Flow
  }

  /**
   * Compare byte counters only when both samples are the same pair on the same ICE generation.
   *
   * The previous check compared two numbers with no pair identity at all, which a renomination or a
   * session restart silently invalidated.
   */
  fun flow(first: IcePathVerdict, second: IcePathVerdict.OnHotspot): Flow {
    val before = first as? IcePathVerdict.OnHotspot ?: return Flow.NotComparable("first_sample_unusable")
    if (before.iceGeneration != second.iceGeneration) return Flow.NotComparable("ice_generation_changed")
    if (before.pairId != second.pairId) return Flow.NotComparable("pair_changed")
    return Flow.Compared(before.bytesReceived, second.bytesReceived)
  }
}
