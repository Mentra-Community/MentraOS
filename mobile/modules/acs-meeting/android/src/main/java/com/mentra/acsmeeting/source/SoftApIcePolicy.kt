package com.mentra.acsmeeting.source

import org.webrtc.PeerConnectionFactory

/**
 * Keeps the SoftAP peer's ICE on the hotspot.
 *
 * Answering with a cellular candidate is the quiet failure mode: the glasses have no route to the
 * phone's mobile address, so ICE either fails after a full timeout or, worse, connects over some
 * other shared network and the "direct" link is a fiction. Rather than hope ICE prefers the right
 * interface, this removes the wrong ones from consideration entirely.
 *
 * [networkIgnoreMask] is a real libwebrtc knob — `PeerConnectionFactory.Options.networkIgnoreMask`
 * — unlike the socket factory the design originally assumed existed. Combined with an empty ICE
 * server list (so no srflx or relay candidate can be gathered at all) it leaves exactly one kind of
 * candidate available: a Wi-Fi host candidate, which on a phone joined to the glasses hotspot is
 * the hotspot address.
 *
 * Pure integer arithmetic, so it is unit tested rather than assumed.
 */
object SoftApIcePolicy {

  /**
   * Adapters the SoftAP peer must not gather on.
   *
   * Cellular is the dangerous one and the reason this exists. VPN is excluded because a corporate
   * VPN on the phone would otherwise offer a tunnel address the glasses cannot reach. Loopback is
   * excluded because it is never reachable from another device and only adds candidates to sift
   * through. Ethernet is left available: a USB-tethered debug setup is legitimate, and it is not a
   * route that can silently substitute for the hotspot.
   */
  fun networkIgnoreMask(): Int =
    PeerConnectionFactory.Options.ADAPTER_TYPE_CELLULAR or
      PeerConnectionFactory.Options.ADAPTER_TYPE_VPN or
      PeerConnectionFactory.Options.ADAPTER_TYPE_LOOPBACK

  /** Whether [adapterType] is gathered on, given [mask]. Mirrors libwebrtc's own bitwise test. */
  fun allowsAdapter(mask: Int, adapterType: Int): Boolean = (mask and adapterType) == 0

  /** Factory options for the SoftAP peer. The network monitor stays on; we need it to see Wi-Fi. */
  fun factoryOptions(): PeerConnectionFactory.Options = PeerConnectionFactory.Options().apply {
    networkIgnoreMask = networkIgnoreMask()
  }
}
