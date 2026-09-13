package com.mentra.glassesmedia.publisher

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Handler
import android.os.HandlerThread
import com.mentra.glassesmedia.source.I420Planes
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.webrtc.*
import org.webrtc.audio.JavaAudioDeviceModule

/**
 * ASG WhipStreamingService's full-ICE offer/POST/answer/Location lifecycle, with decoded glasses
 * tracks instead of camera/mic capture. One instance per attempt; the coordinator owns retries.
 */
class PhoneWhipPublisher(
  private val context: Context,
  private val endpoint: String,
  private val captureAudio: Boolean,
  private val bitrate: Int,
  private val onState: (String, String) -> Unit,
) {
  private val thread = HandlerThread("Mentra WHIP uplink").apply { start() }
  private val queue = Handler(thread.looper)
  private val closed = AtomicBoolean(false)
  private val frameBusy = AtomicBoolean(false)
  private val closeDone = CountDownLatch(1)
  @Volatile private var cleanupFailure: Throwable? = null
  private val pcm = RelayPcmBuffer()
  private var factory: PeerConnectionFactory? = null
  private var egl: EglBase? = null
  private var adm: JavaAudioDeviceModule? = null
  private var peer: PeerConnection? = null
  private var videoSource: VideoSource? = null
  private var videoTrack: VideoTrack? = null
  private var audioSource: AudioSource? = null
  private var audioTrack: AudioTrack? = null
  private var client: OkHttpClient? = null
  private var resource: HttpUrl? = null
  private var posted = false
  private var localSet = false
  private var connected = false
  private var failureSent = false
  private var lastTimestamp = 0L
  private val disconnectDeadline = Runnable { fail("Phone internet connection was lost") }

  fun start() {
    queue.post {
      if (closed.get()) return@post
      try {
        val url = endpoint.toHttpUrl()
        require(url.isHttps) { "Managed WHIP requires HTTPS" }
        val manager = context.getSystemService(ConnectivityManager::class.java)
        val internet = manager.allNetworks.firstOrNull { network ->
          manager.getNetworkCapabilities(network)?.let {
            it.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) &&
              it.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
          } == true
        } ?: error("Phone mobile data is unavailable")
        client = OkHttpClient.Builder().socketFactory(internet.socketFactory)
          .dns(object : okhttp3.Dns { override fun lookup(hostname: String) = internet.getAllByName(hostname).toList() })
          .callTimeout(20, TimeUnit.SECONDS).followRedirects(false).build()
        PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(context).createInitializationOptions())
        egl = EglBase.create()
        adm = JavaAudioDeviceModule.builder(context)
          .setInputSampleRate(48_000).setUseStereoInput(false)
          .setUseHardwareAcousticEchoCanceler(false).setUseHardwareNoiseSuppressor(false)
          .setAudioBufferCallback { buffer, _, channels, sampleRate, bytes, _ ->
            if (channels == 1 && sampleRate == 48_000) pcm.read(buffer, bytes)
            else for (i in 0 until minOf(bytes, buffer.capacity())) buffer.put(i, 0)
            System.nanoTime()
          }.createAudioDeviceModule().also {
            // WebRTC's external-buffer mode: paced callbacks without AudioRecord/microphone.
            it.setAudioRecordEnabled(false)
          }
        factory = PeerConnectionFactory.builder()
          .setOptions(PeerConnectionFactory.Options().apply {
            // The receiver keeps Wi-Fi; this peer uses real cellular handles from the inventory.
            networkIgnoreMask = 2 or 8 or 16 // WIFI, VPN, LOOPBACK
          })
          .setAudioDeviceModule(adm)
          .setVideoEncoderFactory(DefaultVideoEncoderFactory(egl!!.eglBaseContext, true, true))
          .setVideoDecoderFactory(DefaultVideoDecoderFactory(egl!!.eglBaseContext))
          .createPeerConnectionFactory()
        val config = PeerConnection.RTCConfiguration(listOf(
          PeerConnection.IceServer.builder("stun:stun.cloudflare.com:3478").createIceServer(),
        )).apply { sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN }
        peer = factory!!.createPeerConnection(config, observer) ?: error("Could not create WHIP peer")
        videoSource = factory!!.createVideoSource(false).also { it.capturerObserver.onCapturerStarted(true) }
        videoTrack = factory!!.createVideoTrack("glasses-video", videoSource)
        val transceiver = peer!!.addTransceiver(videoTrack, RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_ONLY))
        val codecs = factory!!.getRtpSenderCapabilities(MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO).codecs
        val h264 = codecs.filter { it.name.equals("H264", ignoreCase = true) }
        if (h264.isNotEmpty()) transceiver.setCodecPreferences(h264)
        val parameters = transceiver.sender.parameters
        parameters.encodings.forEach { it.maxBitrateBps = bitrate.coerceIn(250_000, 12_000_000) }
        transceiver.sender.parameters = parameters
        if (captureAudio) {
          val constraints = MediaConstraints().apply {
            for (key in listOf("googEchoCancellation", "googNoiseSuppression", "googAutoGainControl"))
              mandatory.add(MediaConstraints.KeyValuePair(key, "false"))
          }
          audioSource = factory!!.createAudioSource(constraints)
          audioTrack = factory!!.createAudioTrack("glasses-audio", audioSource)
          peer!!.addTransceiver(audioTrack, RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_ONLY))
        }
        peer!!.createOffer(sdpObserver(onCreate = { offer ->
          peer?.setLocalDescription(sdpObserver(onSet = { localSet = true; maybePost() }), offer)
        }), MediaConstraints())
        queue.postDelayed({ if (!connected && !closed.get()) fail("WHIP connection timed out") }, 35_000)
      } catch (error: Exception) { fail(error.message ?: "WHIP startup failed") }
    }
  }

  fun onPcm(bytes: ByteArray, rate: Int, channels: Int) {
    if (!closed.get() && captureAudio) pcm.push(bytes, rate, channels)
  }

  fun onVideoFrame(planes: I420Planes) {
    if (closed.get() || !planes.planesReadable() || !frameBusy.compareAndSet(false, true)) return
    // Copy before returning to the receiver. At most one frame is waiting on the publisher queue.
    val buffer = JavaI420Buffer.allocate(planes.width, planes.height)
    fun copy(src: java.nio.ByteBuffer, srcStride: Int, dst: java.nio.ByteBuffer, dstStride: Int, width: Int, height: Int) {
      val source = src.duplicate()
      val base = source.position()
      val destination = dst.duplicate()
      for (row in 0 until height) {
        source.limit(source.capacity()).position(base + row * srcStride)
        source.limit(base + row * srcStride + width)
        destination.position(row * dstStride)
        destination.put(source)
      }
    }
    try {
      copy(planes.y, planes.strideY, buffer.dataY, buffer.strideY, planes.width, planes.height)
      copy(planes.u, planes.strideU, buffer.dataU, buffer.strideU, (planes.width + 1) / 2, (planes.height + 1) / 2)
      copy(planes.v, planes.strideV, buffer.dataV, buffer.strideV, (planes.width + 1) / 2, (planes.height + 1) / 2)
      if (!queue.post {
        try {
          if (!closed.get()) {
            lastTimestamp = maxOf(System.nanoTime(), lastTimestamp + 1)
            val frame = VideoFrame(buffer, 0, lastTimestamp)
            videoSource?.capturerObserver?.onFrameCaptured(frame)
          }
        } finally { buffer.release(); frameBusy.set(false) }
      }) { buffer.release(); frameBusy.set(false) }
    } catch (_: Exception) { buffer.release(); frameBusy.set(false) }
  }

  private fun maybePost() {
    val pc = peer ?: return
    if (closed.get() || posted || !localSet || pc.iceGatheringState() != PeerConnection.IceGatheringState.COMPLETE) return
    posted = true
    val http = client ?: return
    val request = Request.Builder().url(endpoint)
      .post(pc.localDescription.description.toRequestBody("application/sdp".toMediaType())).build()
    http.newCall(request).enqueue(object : Callback {
      override fun onFailure(call: Call, error: IOException) { queue.post { fail("WHIP signaling failed") } }
      override fun onResponse(call: Call, response: Response) {
        response.use {
          val location = response.header("Location")?.let { request.url.resolve(it) }
          val answer = response.body?.string().orEmpty()
          // A late successful POST still owns a remote resource and must DELETE it after stop.
          if (closed.get()) { location?.let { delete(http, it) }; return }
          queue.post {
            if (closed.get()) { location?.let { delete(http, it) }; return@post }
            if (response.code != 201 || location == null || !location.isHttps || answer.isBlank()) {
              location?.takeIf { it.isHttps }?.let { delete(http, it) }
              fail("WHIP server rejected publish (HTTP ${response.code})")
              return@post
            }
            resource = location
            peer?.setRemoteDescription(sdpObserver(), SessionDescription(SessionDescription.Type.ANSWER, answer))
          }
        }
      }
    })
  }

  private fun fail(reason: String) {
    if (closed.get() || failureSent) return
    failureSent = true
    onState("failed", reason)
  }

  private fun sdpObserver(onCreate: (SessionDescription) -> Unit = {}, onSet: () -> Unit = {}) = object : SdpObserver {
    override fun onCreateSuccess(sdp: SessionDescription) { queue.post { if (!closed.get()) onCreate(sdp) } }
    override fun onSetSuccess() { queue.post { if (!closed.get()) onSet() } }
    override fun onCreateFailure(error: String) { queue.post { fail("WHIP offer failed") } }
    override fun onSetFailure(error: String) { queue.post { fail("WHIP description failed") } }
  }

  private val observer = object : PeerConnection.Observer {
    override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) { queue.post {
      if (closed.get()) return@post
      when (state) {
        PeerConnection.IceConnectionState.CONNECTED, PeerConnection.IceConnectionState.COMPLETED -> {
          connected = true; queue.removeCallbacks(disconnectDeadline); onState("connected", "Phone publisher connected")
        }
        PeerConnection.IceConnectionState.DISCONNECTED -> { queue.removeCallbacks(disconnectDeadline); queue.postDelayed(disconnectDeadline, 10_000) }
        PeerConnection.IceConnectionState.FAILED -> fail("WHIP ICE failed")
        else -> Unit
      }
    } }
    override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) { queue.post { maybePost() } }
    override fun onSignalingChange(state: PeerConnection.SignalingState) = Unit
    override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit
    override fun onIceCandidate(candidate: IceCandidate) = Unit
    override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) = Unit
    override fun onAddStream(stream: MediaStream) = Unit
    override fun onRemoveStream(stream: MediaStream) = Unit
    override fun onDataChannel(channel: DataChannel) = Unit
    override fun onRenegotiationNeeded() = Unit
    override fun onAddTrack(receiver: RtpReceiver, streams: Array<out MediaStream>) = Unit
  }

  /** Called off WebRTC threads. Drains callbacks before disposing factory/ADM/encoder resources. */
  fun close() {
    if (closed.compareAndSet(false, true)) {
      queue.post {
        fun step(action: () -> Unit) {
          try { action() } catch (error: Throwable) { cleanupFailure = cleanupFailure ?: error }
        }
        try {
          step { resource?.let { url -> client?.let { delete(it, url) } }; resource = null }
          step { peer?.close() }
          step { peer?.dispose(); peer = null }
          step { videoSource?.capturerObserver?.onCapturerStopped() }
          step { videoTrack?.dispose() }
          step { videoSource?.dispose() }
          step { audioTrack?.dispose() }
          step { audioSource?.dispose() }
          step { factory?.dispose() }
          step { adm?.release() }
          step { egl?.release() }
        } finally { closeDone.countDown(); thread.quitSafely() }
      }
    }
    check(closeDone.await(20, TimeUnit.SECONDS)) { "Phone publisher cleanup is still pending" }
    cleanupFailure?.let { throw IllegalStateException("Phone publisher cleanup failed", it) }
  }

  private fun delete(http: OkHttpClient, url: HttpUrl) {
    if (!url.isHttps) return
    http.newCall(Request.Builder().url(url).delete().build()).enqueue(object : Callback {
      override fun onFailure(call: Call, e: IOException) = Unit
      override fun onResponse(call: Call, response: Response) { response.close() }
    })
  }
}
