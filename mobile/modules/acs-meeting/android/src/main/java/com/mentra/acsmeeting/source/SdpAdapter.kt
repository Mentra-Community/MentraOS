package com.mentra.acsmeeting.source

import org.webrtc.SdpObserver
import org.webrtc.SessionDescription

/**
 * No-op [SdpObserver] so call sites override only the one callback they care about.
 *
 * Shared by the Cloudflare and SoftAP paths, which negotiate in opposite directions and therefore
 * each ignore a different half of this interface.
 */
internal open class SdpAdapter : SdpObserver {
  override fun onCreateSuccess(sdp: SessionDescription) {}
  override fun onSetSuccess() {}
  override fun onCreateFailure(error: String) {}
  override fun onSetFailure(error: String) {}
}
