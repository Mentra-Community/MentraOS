package com.mentra.acsmeeting.source

/**
 * Where the meeting's glasses video comes from, as sent by the host.
 *
 * A sealed type rather than a nullable URL because the two transports need different inputs and
 * have no meaningful intersection: WHEP needs a URL it is given, while SoftAP produces one only
 * after binding a listener. Modelling it as `whepUrl: String?` invites the exact bug this replaces
 * — an empty string reaching the WHEP subscriber and failing several seconds later as an opaque
 * HTTP error.
 */
sealed interface MeetingVideoSourceSpec {

  val kind: SourceKind

  /** Subscribe to a Cloudflare WHEP endpoint. */
  data class Whep(val url: String) : MeetingVideoSourceSpec {
    override val kind = SourceKind.WHEP
  }

  /**
   * Serve a WHIP endpoint on the glasses hotspot.
   *
   * @param bindAddress the phone's own IPv4 on the hotspot. The orchestrator joins the network and
   *   supplies this; it cannot be known before the join completes.
   */
  data class SoftAp(val bindAddress: String?) : MeetingVideoSourceSpec {
    override val kind = SourceKind.SOFTAP
  }

  /** Locally generated frames, for the synthetic diagnostic arm. */
  data object Synthetic : MeetingVideoSourceSpec {
    override val kind = SourceKind.DIRECT
  }

  fun toConfig(): SourceConfig = when (this) {
    is Whep -> SourceConfig(url, SourceKind.WHEP)
    is SoftAp -> SourceConfig("", SourceKind.SOFTAP, bindAddress)
    Synthetic -> SourceConfig("", SourceKind.DIRECT)
  }

  companion object {
    const val TYPE_WHEP = "whep"
    const val TYPE_SOFTAP = "softap"

    /**
     * Parses the `videoSource` map from the JS bridge, falling back to a bare `whepUrl` so a host
     * that predates the union keeps working.
     *
     * Throws rather than defaulting. A malformed source must fail at the bridge, where the message
     * names the field, instead of surfacing later as a call that joins and shows nothing.
     */
    fun parse(videoSource: Map<*, *>?, legacyWhepUrl: String?): MeetingVideoSourceSpec {
      if (videoSource == null) {
        val url = legacyWhepUrl?.trim().orEmpty()
        require(url.isNotEmpty()) { "videoSource or whepUrl is required" }
        return Whep(url)
      }

      return when (val type = (videoSource["type"] as? String)?.trim()?.lowercase()) {
        TYPE_WHEP -> {
          val url = (videoSource["url"] as? String)?.trim() ?: legacyWhepUrl?.trim().orEmpty()
          require(url.isNotEmpty()) { "videoSource.url is required for a whep source" }
          Whep(url)
        }

        TYPE_SOFTAP -> SoftAp((videoSource["bindAddress"] as? String)?.trim()?.ifEmpty { null })

        else -> throw IllegalArgumentException("unsupported videoSource.type: $type")
      }
    }
  }
}
