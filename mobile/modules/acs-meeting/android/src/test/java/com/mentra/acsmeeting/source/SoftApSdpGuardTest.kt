package com.mentra.acsmeeting.source

import com.mentra.acsmeeting.network.Ipv4Prefix
import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

/**
 * Pins the candidate classification the SoftAP path depends on.
 *
 * The cases here deliberately mirror
 * `com.mentra.asg_client.io.streaming.config.IcePostPolicyTest` on the glasses. The two
 * implementations cannot share code across the module boundary, and if they disagree the symptom is
 * a call that negotiates and then carries nothing: one side posts an offer it considers ready while
 * the other rejects it, or worse, both accept a candidate pair that cannot actually reach across
 * the hotspot.
 */
class SoftApSdpGuardTest {

  private val hostCandidate =
    "a=candidate:1 1 udp 2122260223 192.168.43.20 51234 typ host generation 0"
  private val srflxCandidate =
    "a=candidate:2 1 udp 1686052607 203.0.113.7 51234 typ srflx raddr 192.168.43.20 rport 51234"

  private fun sdp(vararg lines: String) =
    (listOf("v=0", "m=video 9 UDP/TLS/RTP/SAVPF 96") + lines).joinToString("\r\n")

  // -----------------------------------------------------------------
  // Accepting a usable negotiation
  // -----------------------------------------------------------------

  @Test
  fun `an sdp with a hotspot host candidate is accepted`() {
    val verdict = SoftApSdpGuard.inspect(sdp(hostCandidate))

    assertThat(verdict).isInstanceOf(SoftApSdpGuard.Verdict.Ok::class.java)
    val ok = verdict as SoftApSdpGuard.Verdict.Ok
    assertThat(ok.hostCandidates).hasSize(1)
    assertThat(ok.routableCandidates).isEmpty()
  }

  /**
   * Not a rejection. A stale glasses build may still gather srflx candidates, and dropping the call
   * over it would be worse than a warning when a usable hotspot candidate is also present — but it
   * is reported, because ICE could otherwise select it.
   */
  @Test
  fun `a stray srflx candidate is reported but does not reject`() {
    val verdict = SoftApSdpGuard.inspect(sdp(hostCandidate, srflxCandidate))

    val ok = verdict as SoftApSdpGuard.Verdict.Ok
    assertThat(ok.hostCandidates).hasSize(1)
    assertThat(ok.routableCandidates).hasSize(1)
    assertThat(ok.routableCandidates.single()).contains("typ srflx")
  }

  @Test
  fun `any rfc1918 subnet counts, not just the default hotspot range`() {
    // A hotspot on a non-default subnet must not silently fail the gate.
    for (address in listOf("192.168.1.5", "10.0.0.9", "172.16.4.4", "172.31.255.254")) {
      val verdict = SoftApSdpGuard.inspect(
        sdp("a=candidate:1 1 udp 2122260223 $address 51234 typ host generation 0"),
      )

      assertThat(verdict)
        .describedAs(address)
        .isInstanceOf(SoftApSdpGuard.Verdict.Ok::class.java)
    }
  }

  // -----------------------------------------------------------------
  // Rejecting an unusable negotiation
  // -----------------------------------------------------------------

  @Test
  fun `an sdp with only a srflx candidate is rejected`() {
    val verdict = SoftApSdpGuard.inspect(sdp(srflxCandidate))

    val rejected = verdict as SoftApSdpGuard.Verdict.Rejected
    assertThat(rejected.code).isEqualTo(SoftApSdpGuard.REASON_ONLY_NON_HOTSPOT)
    assertThat(rejected.detail).contains("typ srflx")
  }

  @Test
  fun `an sdp with no candidates at all is rejected and says so`() {
    val verdict = SoftApSdpGuard.inspect(sdp())

    val rejected = verdict as SoftApSdpGuard.Verdict.Rejected
    assertThat(rejected.code).isEqualTo(SoftApSdpGuard.REASON_NO_CANDIDATES)
    assertThat(rejected.detail).isEqualTo("no candidates at all")
  }

  /** Public and loopback host candidates are unreachable from the glasses. */
  @Test
  fun `a host candidate on a public or loopback address is rejected`() {
    for (address in listOf("203.0.113.7", "127.0.0.1", "8.8.8.8", "172.32.0.1", "192.169.0.1")) {
      val verdict = SoftApSdpGuard.inspect(
        sdp("a=candidate:1 1 udp 2122260223 $address 51234 typ host generation 0"),
      )

      assertThat(verdict)
        .describedAs(address)
        .isInstanceOf(SoftApSdpGuard.Verdict.Rejected::class.java)
    }
  }

  /**
   * A link-local address means the interface never got a DHCP lease from the glasses. ICE would
   * gather it and connect to nothing.
   */
  @Test
  fun `a link local host candidate is rejected`() {
    val verdict = SoftApSdpGuard.inspect(
      sdp("a=candidate:1 1 udp 2122260223 169.254.10.20 51234 typ host generation 0"),
    )

    assertThat(verdict).isInstanceOf(SoftApSdpGuard.Verdict.Rejected::class.java)
  }

  /**
   * libwebrtc emits these to hide private addresses from remote peers. The glasses cannot resolve
   * them, so a negotiation carrying only mDNS candidates is broken however healthy it looks.
   */
  @Test
  fun `an mdns obfuscated candidate is rejected`() {
    val verdict = SoftApSdpGuard.inspect(
      sdp(
        "a=candidate:1 1 udp 2122260223 " +
          "b8e7c1f2-0000-4000-8000-000000000000.local 51234 typ host generation 0",
      ),
    )

    val rejected = verdict as SoftApSdpGuard.Verdict.Rejected
    assertThat(rejected.code).isEqualTo(SoftApSdpGuard.REASON_ONLY_NON_HOTSPOT)
  }

  @Test
  fun `an ipv6 host candidate does not satisfy the gate`() {
    // The SoftAP link is IPv4 only, so an IPv6 candidate cannot carry this media.
    val verdict = SoftApSdpGuard.inspect(
      sdp("a=candidate:1 1 udp 2122260223 fe80::1 51234 typ host generation 0"),
    )

    assertThat(verdict).isInstanceOf(SoftApSdpGuard.Verdict.Rejected::class.java)
  }

  @Test
  fun `empty and non sdp input is malformed rather than candidate-less`() {
    for (input in listOf(null, "", "   ", "v=0\r\no=- 0 0 IN IP4 0.0.0.0")) {
      val verdict = SoftApSdpGuard.inspect(input)

      assertThat((verdict as SoftApSdpGuard.Verdict.Rejected).code)
        .describedAs(input.orEmpty())
        .isEqualTo(SoftApSdpGuard.REASON_MALFORMED)
    }
  }

  // -----------------------------------------------------------------
  // Parsing details
  // -----------------------------------------------------------------

  @Test
  fun `candidate extraction strips the attribute prefix and ignores other lines`() {
    val candidates = SoftApSdpGuard.candidateLines(
      sdp("a=mid:0", hostCandidate, "a=sendrecv", srflxCandidate),
    )

    assertThat(candidates).hasSize(2)
    assertThat(candidates).allSatisfy { assertThat(it).startsWith("candidate:") }
  }

  @Test
  fun `candidate extraction tolerates trailing whitespace and lone newlines`() {
    val candidates = SoftApSdpGuard.candidateLines("m=video 9\n$hostCandidate  \n")

    assertThat(candidates).hasSize(1)
  }

  @Test
  fun `private ipv4 boundaries match rfc1918 exactly`() {
    assertThat(SoftApSdpGuard.isPrivateIpv4("10.0.0.0")).isTrue()
    assertThat(SoftApSdpGuard.isPrivateIpv4("10.255.255.255")).isTrue()
    assertThat(SoftApSdpGuard.isPrivateIpv4("172.15.0.1")).isFalse()
    assertThat(SoftApSdpGuard.isPrivateIpv4("172.16.0.0")).isTrue()
    assertThat(SoftApSdpGuard.isPrivateIpv4("172.31.0.0")).isTrue()
    assertThat(SoftApSdpGuard.isPrivateIpv4("172.32.0.0")).isFalse()
    assertThat(SoftApSdpGuard.isPrivateIpv4("192.168.0.0")).isTrue()
    assertThat(SoftApSdpGuard.isPrivateIpv4("192.167.0.0")).isFalse()
  }

  @Test
  fun `malformed addresses are not private`() {
    for (token in listOf("192.168.1", "192.168.1.1.1", "192.168.1.256", "a.b.c.d", "", "host")) {
      assertThat(SoftApSdpGuard.isPrivateIpv4(token)).describedAs(token).isFalse()
    }
  }

  @Test
  fun `a candidate must be typ host to count`() {
    assertThat(SoftApSdpGuard.isSoftApHostCandidate(hostCandidate.removePrefix("a="))).isTrue()
    assertThat(
      SoftApSdpGuard.isSoftApHostCandidate(
        "candidate:1 1 udp 2122260223 192.168.43.20 51234 typ relay",
      ),
    ).isFalse()
  }

  @Test
  fun `the candidate address is read positionally, with or without the a= prefix`() {
    assertThat(SoftApSdpGuard.candidateAddress(hostCandidate)).isEqualTo("192.168.43.20")
    assertThat(
      SoftApSdpGuard.candidateAddress(
        "candidate:3558496604 1 udp 2122260223 10.48.51.202 35664 typ host generation 0",
      ),
    ).isEqualTo("10.48.51.202")
  }

  /** `raddr` would win a scan for anything dotted-quad-shaped and blame the wrong interface. */
  @Test
  fun `a reflexive candidate reports its local address, not its raddr`() {
    assertThat(
      SoftApSdpGuard.candidateAddress(
        "candidate:2 1 udp 1686052607 203.0.113.9 44444 typ srflx raddr 192.168.43.20 rport 51234",
      ),
    ).isEqualTo("203.0.113.9")
  }

  @Test
  fun `a line without an address reports none rather than a stray token`() {
    assertThat(SoftApSdpGuard.candidateAddress("a=mid:0")).isNull()
    assertThat(SoftApSdpGuard.candidateAddress("")).isNull()
  }

  // -----------------------------------------------------------------
  // Pinning a cellular-substituted host address back onto the hotspot
  // -----------------------------------------------------------------

  @Test
  fun `a cellular host address is rewritten to the scoped SoftAP address`() {
    val prefix = Ipv4Prefix("192.168.43.79", 24)
    val original =
      sdp("a=candidate:1 1 udp 2122260223 10.48.51.202 35664 typ host generation 0")

    val pinned = SoftApSdpGuard.pinHostAddresses(original, "192.168.43.79", prefix)

    assertThat(pinned.rewritten).containsExactly("10.48.51.202")
    assertThat(pinned.sdp).contains("192.168.43.79 35664 typ host")
    assertThat(pinned.sdp).doesNotContain("10.48.51.202")
    assertThat(SoftApSdpGuard.inspect(pinned.sdp, prefix)).isInstanceOf(SoftApSdpGuard.Verdict.Ok::class.java)
  }

  @Test
  fun `a host address already on the hotspot is left alone`() {
    val prefix = Ipv4Prefix("192.168.43.79", 24)
    val original = sdp(hostCandidate)

    val pinned = SoftApSdpGuard.pinHostAddresses(original, "192.168.43.79", prefix)

    assertThat(pinned.rewritten).isEmpty()
    assertThat(pinned.sdp).isEqualTo(original)
  }

  @Test
  fun `a reflexive raddr is not treated as the connection address to pin`() {
    // Field 5 is 203.0.113.7; raddr is already the hotspot. Rewriting raddr would hide a srflx
    // that ICE could still select, and would not fix the address the glasses send to.
    val prefix = Ipv4Prefix("192.168.43.79", 24)
    val original = sdp(srflxCandidate)

    val pinned = SoftApSdpGuard.pinHostAddresses(original, "192.168.43.79", prefix)

    assertThat(pinned.rewritten).isEmpty()
    assertThat(pinned.sdp).contains("203.0.113.7")
    assertThat(pinned.sdp).contains("raddr 192.168.43.20")
  }
}
