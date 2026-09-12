package com.mentra.acsmeeting.source

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.Test

/**
 * The bridge boundary between the host's `videoSource` union and the native source classes.
 *
 * Worth pinning because this is the last place a malformed source can be rejected with a message
 * that names the field. Past here it becomes a call that joins and shows nothing.
 */
class MeetingVideoSourceSpecTest {

  @Test
  fun `a whep source parses to a whep config`() {
    val spec = MeetingVideoSourceSpec.parse(
      mapOf("type" to "whep", "url" to " https://example.com/whep "),
      null,
    )

    assertThat(spec).isEqualTo(MeetingVideoSourceSpec.Whep("https://example.com/whep"))
    assertThat(spec.toConfig()).isEqualTo(
      SourceConfig("https://example.com/whep", SourceKind.WHEP),
    )
  }

  @Test
  fun `a softap source parses to a softap config carrying the bind address`() {
    val spec = MeetingVideoSourceSpec.parse(
      mapOf("type" to "softap", "bindAddress" to "192.168.43.20"),
      null,
    )

    assertThat(spec).isEqualTo(MeetingVideoSourceSpec.SoftAp("192.168.43.20"))
    assertThat(spec.toConfig())
      .isEqualTo(SourceConfig("", SourceKind.SOFTAP, "192.168.43.20"))
  }

  /**
   * The orchestrator may not know the address yet when it builds the request; the source falls
   * back to asking the joined network. A blank string must not become a bind target.
   */
  @Test
  fun `a softap source without a usable bind address carries null`() {
    assertThat(MeetingVideoSourceSpec.parse(mapOf("type" to "softap"), null))
      .isEqualTo(MeetingVideoSourceSpec.SoftAp(null))
    assertThat(MeetingVideoSourceSpec.parse(mapOf("type" to "softap", "bindAddress" to " "), null))
      .isEqualTo(MeetingVideoSourceSpec.SoftAp(null))
  }

  @Test
  fun `the type is matched case insensitively`() {
    assertThat(MeetingVideoSourceSpec.parse(mapOf("type" to "SoftAP"), null).kind)
      .isEqualTo(SourceKind.SOFTAP)
  }

  // -----------------------------------------------------------------
  // Back-compatibility with a host that predates the union
  // -----------------------------------------------------------------

  @Test
  fun `a bare whepUrl with no videoSource still parses`() {
    assertThat(MeetingVideoSourceSpec.parse(null, "https://example.com/whep"))
      .isEqualTo(MeetingVideoSourceSpec.Whep("https://example.com/whep"))
  }

  @Test
  fun `a whep source with no url falls back to the legacy field`() {
    assertThat(MeetingVideoSourceSpec.parse(mapOf("type" to "whep"), "https://legacy/whep"))
      .isEqualTo(MeetingVideoSourceSpec.Whep("https://legacy/whep"))
  }

  // -----------------------------------------------------------------
  // Rejections
  // -----------------------------------------------------------------

  @Test
  fun `an unknown type is rejected rather than defaulting to whep`() {
    assertThatThrownBy { MeetingVideoSourceSpec.parse(mapOf("type" to "quic"), null) }
      .isInstanceOf(IllegalArgumentException::class.java)
      .hasMessageContaining("quic")
  }

  @Test
  fun `a whep source with no url anywhere is rejected`() {
    assertThatThrownBy { MeetingVideoSourceSpec.parse(mapOf("type" to "whep"), " ") }
      .isInstanceOf(IllegalArgumentException::class.java)
      .hasMessageContaining("url")
  }

  @Test
  fun `no source and no legacy url is rejected`() {
    assertThatThrownBy { MeetingVideoSourceSpec.parse(null, null) }
      .isInstanceOf(IllegalArgumentException::class.java)
  }

  @Test
  fun `a missing type is rejected`() {
    assertThatThrownBy { MeetingVideoSourceSpec.parse(mapOf("url" to "https://x/whep"), null) }
      .isInstanceOf(IllegalArgumentException::class.java)
  }

  @Test
  fun `the synthetic arm maps to the direct kind`() {
    assertThat(MeetingVideoSourceSpec.Synthetic.toConfig())
      .isEqualTo(SourceConfig("", SourceKind.DIRECT))
  }
}
