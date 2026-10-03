package com.mentra.glassesmedia.source

import com.mentra.glassesmedia.network.Ipv4Prefix

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
 * When the host can describe the network it joined, candidates are matched against that exact
 * prefix — the real invariant is "on the network we joined", and RFC1918 is only a stand-in for it.
 * Cellular carriers hand out 10/8 addresses, so the stand-in accepts precisely the interface this
 * gate exists to reject. Without a prefix (no scoped handle) the check falls back to RFC1918, which
 * deliberately matches `com.mentra.asg_client.io.streaming.config.IcePostPolicy` on the glasses. The
 * two cannot share code across the module boundary, so
 * [SoftApSdpGuardTest][com.mentra.glassesmedia.source.SoftApSdpGuardTest] pins the same cases the
 * glasses-side test pins.
 */
object SoftApSdpGuard {

  sealed interface Verdict {
    /** At least one usable hotspot host candidate. [routableCandidates] is non-fatal, see below. */
    data class Ok(val hostCandidates: List<String>, val routableCandidates: List<String>) : Verdict

    data class Rejected(val code: String, val detail: String) : Verdict
  }

  /**
   * No `typ host` candidate on the hotspot subnet, split by whether anything was gathered at all.
   *
   * One code covered both for a long time and it cost real debugging time: "nothing gathered" and
   * "gathered the wrong address" are different faults with different fixes, and the single code
   * made a run that had regressed from one to the other look unchanged.
   * [SoftApIceDiagnosis] narrows them further; these two are the coarse label.
   */
  const val REASON_NO_CANDIDATES = SoftApIceDiagnosis.CODE_NO_CANDIDATES

  /** See [REASON_NO_CANDIDATES]. Candidates exist, none of them on the hotspot. */
  const val REASON_ONLY_NON_HOTSPOT = SoftApIceDiagnosis.CODE_ONLY_NON_HOTSPOT

  /** Not SDP, or SDP with no media section. */
  const val REASON_MALFORMED = "malformed_sdp"

  /**
   * Candidates that are not host candidates on a private subnet — srflx, relay, or a host candidate
   * on a public address. In host-only mode none should appear; if they do, ICE could select one, so
   * they are reported for logging. They are not rejected on the offer side: the glasses may run an
   * older build that still gathers them, and dropping the call would be worse than a warning when a
   * valid hotspot candidate is also present.
   */
  fun inspect(sdp: String?, prefix: Ipv4Prefix? = null): Verdict {
    if (sdp.isNullOrBlank()) return Verdict.Rejected(REASON_MALFORMED, "empty sdp")
    if (!sdp.contains("m=")) return Verdict.Rejected(REASON_MALFORMED, "no media section")

    val candidates = candidateLines(sdp)
    val host = candidates.filter { isSoftApHostCandidate(it, prefix) }
    val routable = candidates.filterNot { isSoftApHostCandidate(it, prefix) }

    if (host.isEmpty()) {
      val scope = if (prefix != null) " (hotspot is $prefix)" else ""
      return if (candidates.isEmpty()) {
        Verdict.Rejected(REASON_NO_CANDIDATES, "no candidates at all$scope")
      } else {
        Verdict.Rejected(
          REASON_ONLY_NON_HOTSPOT,
          "only non-hotspot candidates$scope: ${routable.joinToString("; ")}",
        )
      }
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
   * A `typ host` candidate on the hotspot: inside [prefix] when we know it, RFC1918 otherwise.
   *
   * mDNS-obfuscated candidates (`<uuid>.local`) are rejected on purpose. libwebrtc emits them to
   * hide private addresses from remote peers, and the glasses cannot resolve them, so a negotiation
   * that only offers those is broken however healthy it looks. Seeing this fire means the answering
   * peer needs its mDNS obfuscation disabled.
   */
  fun isSoftApHostCandidate(candidate: String, prefix: Ipv4Prefix? = null): Boolean {
    if (!candidate.contains("typ host")) return false
    val onHotspot: (String) -> Boolean = if (prefix != null) prefix::contains else ::isPrivateIpv4
    return candidate.split(Regex("\\s+")).any(onHotspot)
  }

  /**
   * What [pinHostAddresses] did to one answer.
   *
   * [rewritten] is the host-candidate addresses that were off the hotspot and got replaced.
   * Empty means the gathered SDP already advertised the scoped IP, so signaling and native state
   * already match and nothing was edited.
   */
  data class PinResult(val sdp: String, val rewritten: List<String>)

  /**
   * Force every `typ host` candidate onto [scopedAddress].
   *
   * Needed because a bindable network handle marks the ICE sockets onto the SoftAP — which is what
   * actually delivers UDP — and then libwebrtc substitutes the phone's default-route address into
   * the candidate. The glasses have no route to that address. Replacing only the connection address
   * of host lines (field 5, not `raddr`) keeps srflx/relay untouched and leaves a candidate that
   * was already on the hotspot alone.
   *
   * The socket is still the marked one libwebrtc created. This only changes what the glasses are
   * told to send to, so it stays honest only when that socket is on [scopedAddress]'s network.
   */
  fun pinHostAddresses(sdp: String, scopedAddress: String, prefix: Ipv4Prefix): PinResult {
    val rewritten = mutableListOf<String>()
    val lines = sdp.split(Regex("(?<=\\r?\\n)", RegexOption.MULTILINE))
    val pinned =
      lines.joinToString("") { line ->
        val body = line.trimEnd('\r', '\n')
        if (!body.contains("candidate:") || !body.contains("typ host")) return@joinToString line
        val address = candidateAddress(body) ?: return@joinToString line
        if (prefix.contains(address) || address == scopedAddress) return@joinToString line
        rewritten += address
        line.replaceFirst(address, scopedAddress)
      }
    return PinResult(pinned, rewritten)
  }

  /**
   * The connection address of a candidate line, for attributing it to a real interface.
   *
   * Field 5 of `candidate:<foundation> <component> <transport> <priority> <address> <port> ...`,
   * per RFC 5245. Read positionally rather than by scanning for anything dotted-quad-shaped: a
   * `raddr` on an srflx line would otherwise win and point at the wrong interface.
   */
  fun candidateAddress(candidate: String): String? {
    val fields = candidate.trim().removePrefix("a=").split(Regex("\\s+"))
    return fields.getOrNull(4)?.takeIf { it.count { char -> char == '.' } == 3 }
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
