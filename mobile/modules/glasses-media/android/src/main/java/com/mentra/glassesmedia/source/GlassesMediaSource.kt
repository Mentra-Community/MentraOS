package com.mentra.glassesmedia.source

import com.mentra.glassesmedia.trace.SoftApTrace

enum class SourceKind {
  /** Subscribe to a Cloudflare WHEP endpoint. The phone is the offerer. */
  WHEP,
  DIRECT,

  /**
   * Serve a WHIP endpoint on the glasses hotspot and let the glasses publish into it. The phone is
   * the answerer, and no traffic leaves the local link. See [LocalWhipIngestSource].
   */
  SOFTAP,
}

enum class SourceState { IDLE, CONNECTING, LIVE, FAILED }

data class SourceConfig(
  /**
   * WHEP: the endpoint to subscribe to. SOFTAP: unused, because the URL is not known until the
   * listener has bound a port — the source reports it back through
   * [GlassesMediaSource.ingestUrl] instead.
   */
  val url: String,
  val kind: SourceKind = SourceKind.WHEP,
  /** SOFTAP only: the phone's own IPv4 address on the hotspot, to bind the listener to. */
  val bindAddress: String? = null,
)

/** ACS-negotiated output size. One object so a frame cannot observe a torn width/height. */
data class TargetSize(val width: Int, val height: Int)

/**
 * Whether a subscriber already on [currentUrl] can serve [next] as-is instead of
 * being rebuilt.
 *
 * Reuse is the whole point: a rebuild mints a new peer and restarts the wait for
 * the first frame, which is the outage we are trying to shorten. `CONNECTING`
 * counts as reusable, and since `LIVE` means "a frame reached the sink" that now
 * spans the answer → first frame window too. It cannot strand a caller, because
 * every `CONNECTING` is bounded: the offer post fails, or the answer's
 * first-frame deadline expires into `FAILED` and this returns false.
 *
 * SoftAP never reuses: the listener, port and peer belong to one publish attempt,
 * and the ingest URL is an output of binding, not an input that could stay valid.
 *
 * Owned by an object rather than a file-level function so Kotlin incremental
 * compile cannot see two [GlassesMediaSourceKt] facades and report a phantom
 * overload of the same signature.
 */
object SourceReusePolicy {
  fun canReuse(currentUrl: String?, state: SourceState, next: SourceConfig): Boolean =
    currentUrl == next.url && next.kind == SourceKind.WHEP && state != SourceState.FAILED
}

/**
 * Observes source health transitions. `FAILED` is the one that matters: ICE
 * dropped, the WHEP endpoint went away, or an answered subscription never
 * delivered a frame — and nothing downstream will notice on its own, because
 * ACS keeps the call up with a frozen last frame.
 */
fun interface SourceStateListener {
  fun onSourceState(state: SourceState, reason: String?)
}

/**
 * Transports whatever the glasses already captured. Capture policy lives
 * outside this interface so a Cloudflare hop can be replaced without touching ACS.
 */
interface GlassesMediaSource {
  fun start(config: SourceConfig)
  fun restart(config: SourceConfig)
  /** Rebuild the transport for the current config even if it looks healthy. */
  fun forceRestart() {}
  fun stop()
  val state: SourceState

  /**
   * SOFTAP only: the WHIP URL the glasses must POST their offer to, known only after [start] has
   * bound a listener. Null for every other kind, where the URL is an input rather than an output.
   */
  val ingestUrl: String? get() = null

  fun setPcmDeliveryEnabled(enabled: Boolean)
  fun setTargetSize(size: TargetSize?) {}
  fun setStateListener(listener: SourceStateListener?) {}

  /**
   * Drop a retiring SoftAP listener now, skipping its tombstone. No-op for every other kind.
   *
   * After [restart], this is the previous listener generation — not the one that just bound.
   */
  fun forceCloseIngest() {}

  /**
   * Has the retiring SoftAP listener released its port? `true` when there is nothing to wait for.
   */
  fun awaitIngestClosed(timeoutMs: Long): Boolean = true
}

/**
 * Builds the transport for one attempt. Takes [SourceConfig] because the kind decides the class:
 * a Cloudflare subscription and a SoftAP listener are different objects, not one object with a
 * mode flag, and the session must not have to know which.
 */
fun interface GlassesMediaSourceFactory {
  fun create(video: VideoFrameListener, pcm: PcmListener, config: SourceConfig): GlassesMediaSource
}

class GlassesMediaController(
  private val factory: GlassesMediaSourceFactory,
) {
  private var source: GlassesMediaSource? = null
  private var stateListener: SourceStateListener? = null

  /**
   * The SoftAP listener this controller has let go of, kept only until its port is released.
   *
   * [stop] drops the source, but a WHIP listener answers `410` for a few seconds after that and
   * still holds its port. Losing the reference here is what made the port's release unobservable
   * from above, so the next call bound into it.
   *
   * After [rebindIngest], this is the current source: [GlassesMediaSource.restart] parks the
   * previous listener on that object, so [forceCloseIngest] / [awaitIngestClosed] stay unambiguous.
   */
  private var retiringIngest: GlassesMediaSource? = null

  val state: SourceState
    get() = source?.state ?: SourceState.IDLE

  /** SOFTAP only: the URL the glasses must publish to, once a listener has bound. */
  val ingestUrl: String?
    get() = source?.ingestUrl

  fun attach(video: VideoFrameListener, pcm: PcmListener, config: SourceConfig) {
    retire()
    source = factory.create(video, pcm, config).also {
      it.setStateListener(stateListener)
      it.start(config)
    }
  }

  fun restart(config: SourceConfig) {
    source?.restart(config)
  }

  /**
   * Destroy the current SoftAP listener generation and bind a new one.
   *
   * [GlassesMediaSource.restart] is [LocalWhipIngestSource.start]: it parks the old listener as
   * retiring and binds a new OS-chosen port. This then force-closes that parked generation —
   * no tombstone wait — and refuses a null or unchanged URL so a stale listener cannot be reused.
   *
   * Does not call [LocalWhipIngestSource.close], which would dispose the shared
   * PeerConnectionFactory.
   */
  fun rebindIngest(config: SourceConfig, timeoutMs: Long): String {
    if (!MediaDiagnostics.SOFTAP_RECOVERY_ENABLED) {
      SoftApTrace.failure("ingest_rebind_disabled")
      throw IllegalStateException("SoftAP ingest rebind is disabled")
    }
    val current = source ?: throw IllegalStateException("No media source to rebind")
    val oldUrl = ingestUrl
    current.restart(config)
    val newUrl = ingestUrl
    if (newUrl.isNullOrBlank() || newUrl == oldUrl) {
      SoftApTrace.failure("ingest_rebind_stale", "oldUrl" to oldUrl, "newUrl" to newUrl)
      throw IllegalStateException(
        "SoftAP ingest rebind did not mint a new listener (old=$oldUrl new=$newUrl)",
      )
    }
    // After restart the current source's retiring handle is the previous listener.
    retiringIngest = current
    forceCloseIngest()
    val closed = awaitIngestClosed(timeoutMs)
    SoftApTrace.stage(
      "ingest_rebind",
      "oldUrl" to oldUrl,
      "newUrl" to newUrl,
      "closed" to closed,
    )
    if (!closed) {
      SoftApTrace.failure("ingest_rebind_close_failed", "oldUrl" to oldUrl, "newUrl" to newUrl)
      throw IllegalStateException("SoftAP ingest rebind did not release the old listener")
    }
    return newUrl
  }

  fun forceRestart() {
    source?.forceRestart()
  }

  fun setStateListener(listener: SourceStateListener?) {
    stateListener = listener
    source?.setStateListener(listener)
  }

  fun stop() {
    retire()
  }

  private fun retire() {
    val previous = source
    previous?.stop()
    if (previous is LocalWhipIngestSource) retiringIngest = previous
    source = null
  }

  /**
   * Has the SoftAP listener actually released its port? `true` when there is nothing to wait for.
   *
   * A `false` here is the teardown barrier's signal to force the close rather than to give up:
   * the next call's bind fails on exactly this port.
   */
  fun awaitIngestClosed(timeoutMs: Long): Boolean = retiringIngest?.awaitIngestClosed(timeoutMs) ?: true

  /** Close the retiring listener now, skipping the tombstone. Only for a barrier that timed out. */
  fun forceCloseIngest() {
    // Do not drop the handle here: the host re-asks awaitIngestClosed after this to verify the port
    // was released, and a null reference answers `true` unconditionally, hiding a failed close. The
    // next retire() reassigns retiringIngest, so keeping the closed one until then is harmless.
    retiringIngest?.forceCloseIngest()
  }

  fun setPcmDeliveryEnabled(enabled: Boolean) {
    source?.setPcmDeliveryEnabled(enabled)
  }

  fun setTargetSize(size: TargetSize?) {
    source?.setTargetSize(size)
  }
}
