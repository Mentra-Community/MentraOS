package com.mentra.acsmeeting.source

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test
import org.webrtc.PeerConnectionFactory

/**
 * Pins which adapters the SoftAP peer may gather on.
 *
 * Getting this wrong is not a crash. An answer carrying a cellular candidate negotiates fine and
 * then never carries a frame, because the glasses have no route to the phone's mobile address — and
 * the logs show a healthy call the whole time.
 */
class SoftApIcePolicyTest {

  private val mask = SoftApIcePolicy.networkIgnoreMask()

  @Test
  fun `cellular is excluded because the glasses cannot reach it`() {
    assertThat(SoftApIcePolicy.allowsAdapter(mask, PeerConnectionFactory.Options.ADAPTER_TYPE_CELLULAR))
      .isFalse()
  }

  @Test
  fun `vpn is excluded because a tunnel address is not on the hotspot`() {
    assertThat(SoftApIcePolicy.allowsAdapter(mask, PeerConnectionFactory.Options.ADAPTER_TYPE_VPN))
      .isFalse()
  }

  @Test
  fun `loopback is excluded because no other device can reach it`() {
    assertThat(SoftApIcePolicy.allowsAdapter(mask, PeerConnectionFactory.Options.ADAPTER_TYPE_LOOPBACK))
      .isFalse()
  }

  /** The whole point: the hotspot presents as Wi-Fi, so Wi-Fi must survive the mask. */
  @Test
  fun `wifi is allowed`() {
    assertThat(SoftApIcePolicy.allowsAdapter(mask, PeerConnectionFactory.Options.ADAPTER_TYPE_WIFI))
      .isTrue()
  }

  /**
   * The reason `ScopedNetworkChangeDetector` publishes decoy entries for interfaces it does not
   * want. `ADAPTER_TYPE_UNKNOWN` is `0`, so no mask can ever exclude it: an interface the network
   * monitor never announced is an interface ICE will gather on no matter what this mask says.
   */
  @Test
  fun `an unknown adapter cannot be masked, so no interface may go unannounced`() {
    assertThat(PeerConnectionFactory.Options.ADAPTER_TYPE_UNKNOWN).isEqualTo(0)
    assertThat(SoftApIcePolicy.allowsAdapter(mask, PeerConnectionFactory.Options.ADAPTER_TYPE_UNKNOWN))
      .isTrue()
  }

  @Test
  fun `ethernet and ANY are excluded so a leftover AutoDetect network cannot gather`() {
    assertThat(SoftApIcePolicy.allowsAdapter(mask, PeerConnectionFactory.Options.ADAPTER_TYPE_ETHERNET))
      .isFalse()
    assertThat(SoftApIcePolicy.allowsAdapter(mask, PeerConnectionFactory.Options.ADAPTER_TYPE_ANY))
      .isFalse()
  }

  @Test
  fun `the factory options carry the mask`() {
    assertThat(SoftApIcePolicy.factoryOptions().networkIgnoreMask).isEqualTo(mask)
  }

  /**
   * The network monitor must stay on. Disabling it would stop libwebrtc from noticing the Wi-Fi
   * interface at all, which is the opposite of what this path needs.
   */
  @Test
  fun `the network monitor is left enabled`() {
    assertThat(SoftApIcePolicy.factoryOptions().disableNetworkMonitor).isFalse()
  }
}
