package com.mentra.acsmeeting.source

/**
 * Checks that a SoftAP negotiation is actually staying on the SoftAP.
 *
 * The failure this exists to catch is silent. If the phone answers with a candidate on its cellular
 * or home-Wi-Fi interface, or the glasses offer one, ICE may still connect — over a path that
 * defeats the entire point of SoftAP and, in the cellular case, cannot work at all because the
 * glasses have no route to it. Media either never flows or flows the long way while the logs look
 * healthy. So both the offer we receive and the answer we send are asserted against the hotspot
 * subnet before either is used.
 *
 * The candidate classification deliberately matches
 * `com.mentra.asg_client.io.streaming.config.IcePostPolicy` on the glasses: any RFC1918 `typ host`
 * candidate counts, so a hotspot on a subnet other than the default 192.168.43/24 does not fail the
 * gate. The two cannot share code across the module boundary, so
 * [SoftApSdpGuardTest][com.mentra.acsmeeting.source.SoftApSdpGuardTest] pins the same cases the
 * glasses-side test pins.
 */
object SoftApSdpGuard {

  sealed interface Verdict {
    /** At least one usable hotspot host candidate. [routableCandidates] is non-fatal, see below. */
    data class Ok(val hostCandidates: List<String>, val routableCandidates: List<String>) : Verdict

    data class Rejected(val code: String, val detail: String) : Verdict
  }

  /** No `typ host` candidate on a private subnet: nothing here can cross the SoftAP link. */
  const val REASON_NO_HOST_CANDIDATE = "no_softap_host_candidate"

  /** Not SDP, or SDP with no media section. */
  const val REASON_MALFORMED = "malformed_sdp"

  /**
   * Candidates that are not host candidates on a private subnet — srflx, relay, or a host candidate
   * on a public address. In host-only mode none should appear; if they do, ICE could select one, so
   * they are reported for logging. They are not rejected on the offer side: the glasses may run an
   * older build that still gathers them, and dropping the call would be worse than a warning when a
   * valid hotspot candidate is also present.
   */
  fun inspect(sdp: String?): Verdict {
    if (sdp.isNullOrBlank()) return Verdict.Rejected(REASON_MALFORMED, "empty sdp")
    if (!sdp.contains("m=")) return Verdict.Rejected(REASON_MALFORMED, "no media section")

    val candidates = candidateLines(sdp)
    val host = candidates.filter { isSoftApHostCandidate(it) }
    val routable = candidates.filterNot { isSoftApHostCandidate(it) }

    if (host.isEmpty()) {
      return Verdict.Rejected(
        REASON_NO_HOST_CANDIDATE,
        if (candidates.isEmpty()) {
          "no candidates at all"
        } else {
          "only non-hotspot candidates: ${routable.joinToString("; ")}"
        },
      )
    }
    return Verdict.Ok(host, routable)
  }

  /** Every `a=candidate:` attribute, with the `a=` prefix stripped. */
  fun candidateLines(sdp: String): List<String> =
    sdp.lineSequence()
      .map { it.trim() }
      .filter { it.startsWith("a=candidate:") }
      .map { it.removePrefix("a=") }
      .toList()

  /**
   * A `typ host` candidate whose connection address is RFC1918.
   *
   * mDNS-obfuscated candidates (`<uuid>.local`) are rejected on purpose. libwebrtc emits them to
   * hide private addresses from remote peers, and the glasses cannot resolve them, so a negotiation
   * that only offers those is broken however healthy it looks. Seeing this fire means the answering
   * peer needs its mDNS obfuscation disabled.
   */
  fun isSoftApHostCandidate(candidate: String): Boolean {
    if (!candidate.contains("typ host")) return false
    return candidate.split(Regex("\\s+")).any { isPrivateIpv4(it) }
  }

  /** RFC1918: 10/8, 172.16/12, 192.168/16. Rejects loopback, link-local and public addresses. */
  fun isPrivateIpv4(token: String): Boolean {
    val octets = token.split('.')
    if (octets.size != 4) return false
    val values = octets.map { it.toIntOrNull() ?: return false }
    if (values.any { it < 0 || it > 255 }) return false
    return when {
      values[0] == 10 -> true
      values[0] == 172 && values[1] in 16..31 -> true
      else -> values[0] == 192 && values[1] == 168
    }
  }
}
