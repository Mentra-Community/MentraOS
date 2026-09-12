package com.mentra.acsmeeting.network

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import androidx.test.platform.app.InstrumentationRegistry
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.assertj.core.api.Assertions.assertThat
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription

/**
 * PHASE 0.5 HARD GATE — the six facts the SoftAP architecture depends on.
 *
 * This is a real-device test, deliberately excluded from CI: it needs a phone with cellular data
 * active and the glasses hotspot broadcasting. Run it before building the WHIP ingest server. If
 * [libwebrtc emits a hotspot host candidate][iceGatheringProducesAHotspotHostCandidate] fails, stock
 * libwebrtc is not enumerating the no-INTERNET network and [ScopedNetworkChangeDetector] must be
 * installed and this re-run before Phase 3 proceeds.
 *
 * ```
 * cd mobile/android && ./gradlew :mentra-acs-meeting:connectedDebugAndroidTest \
 *   -Pandroid.testInstrumentationRunnerArguments.softApSsid=MentraLive-1234 \
 *   -Pandroid.testInstrumentationRunnerArguments.softApPassphrase=<passphrase>
 * ```
 *
 * Without those arguments every test is skipped rather than failing, so an accidental CI run is
 * inert rather than red.
 *
 * The three glasses-initiated facts (inbound TCP, inbound UDP, cleartext WHIP POST) are the reason
 * gallery sync is not sufficient evidence: sync only proves phone -> glasses, and here the glasses
 * connect *to* a server on the phone. AP client isolation, firewall rules, or Android's inbound
 * local-network policy can each break that while sync keeps working. This class proves the phone
 * side accepts inbound connections on the hotspot address; driving the glasses to actually dial in
 * is the Phase 7 device proof.
 */
class SoftApFeasibilityGateTest {

    private lateinit var context: Context
    private lateinit var scoped: ScopedSoftApNetwork
    private var ssid: String = ""
    private var passphrase: String = ""

    @Before
    fun setUp() {
        val arguments = InstrumentationRegistry.getArguments()
        ssid = arguments.getString("softApSsid").orEmpty()
        passphrase = arguments.getString("softApPassphrase").orEmpty()
        assumeTrue("softApSsid instrumentation argument is required", ssid.isNotEmpty())

        context = InstrumentationRegistry.getInstrumentation().targetContext
        scoped = ScopedSoftApNetwork(context)
    }

    // -----------------------------------------------------------------
    // (6) ACS/internet traffic stays on cellular
    // -----------------------------------------------------------------

    @Test
    fun scopedJoinKeepsCellularAsTheDefaultNetwork() {
        scoped.join(ssid, passphrase)
        try {
            assertThat(scoped.isAvailable()).isTrue()
            assertThat(scoped.localIpv4()).isNotNull()

            val manager = context.getSystemService(ConnectivityManager::class.java)
            val default = requireNotNull(manager.activeNetwork) { "no default network" }
            val capabilities = requireNotNull(manager.getNetworkCapabilities(default))

            assertThat(capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR))
                .describedAs("default network must remain cellular after the scoped join")
                .isTrue()
            assertThat(capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET))
                .isTrue()
        } finally {
            scoped.release()
        }
    }

    // -----------------------------------------------------------------
    // (1) inbound TCP on the hotspot address
    // -----------------------------------------------------------------

    @Test
    fun phoneAcceptsInboundTcpOnTheHotspotAddress() {
        scoped.join(ssid, passphrase)
        try {
            val local = InetAddress.getByName(requireNotNull(scoped.localIpv4()))
            val accepted = CountDownLatch(1)

            ServerSocket().use { server ->
                server.reuseAddress = true
                server.bind(InetSocketAddress(local, 0))

                Thread {
                    runCatching { server.accept().use { accepted.countDown() } }
                }
                    .apply { isDaemon = true }
                    .start()

                Socket().use { client ->
                    client.connect(InetSocketAddress(local, server.localPort), CONNECT_TIMEOUT_MS)
                }

                assertThat(accepted.await(5, TimeUnit.SECONDS))
                    .describedAs("inbound TCP on %s was not accepted", local)
                    .isTrue()
            }
        } finally {
            scoped.release()
        }
    }

    // -----------------------------------------------------------------
    // (2) inbound UDP on the hotspot address
    // -----------------------------------------------------------------

    @Test
    fun phoneReceivesUdpOnTheHotspotAddress() {
        scoped.join(ssid, passphrase)
        try {
            val local = InetAddress.getByName(requireNotNull(scoped.localIpv4()))

            DatagramSocket(null).use { receiver ->
                receiver.reuseAddress = true
                receiver.bind(InetSocketAddress(local, 0))
                receiver.soTimeout = 5_000

                val payload = "softap-gate".toByteArray()
                DatagramSocket().use { sender ->
                    sender.send(DatagramPacket(payload, payload.size, local, receiver.localPort))
                }

                val buffer = ByteArray(64)
                val packet = DatagramPacket(buffer, buffer.size)
                receiver.receive(packet)

                assertThat(String(packet.data, 0, packet.length)).isEqualTo("softap-gate")
            }
        } finally {
            scoped.release()
        }
    }

    // -----------------------------------------------------------------
    // (4) + (5) libwebrtc gathers, and can select, a hotspot host candidate
    // -----------------------------------------------------------------

    /**
     * The reviewer's primary risk. A scoped `Network` alone does not make libwebrtc's internally
     * created UDP sockets use that interface, and its network monitor only watches
     * internet-capable networks. If this fails, install [ScopedNetworkChangeDetector].
     */
    @Test
    fun iceGatheringProducesAHotspotHostCandidate() {
        scoped.join(ssid, passphrase)
        val localIpv4 = requireNotNull(scoped.localIpv4())

        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(context)
                .createInitializationOptions(),
        )
        val eglBase = EglBase.create()
        val factory =
            PeerConnectionFactory.builder()
                .setVideoEncoderFactory(DefaultVideoEncoderFactory(eglBase.eglBaseContext, true, true))
                .setVideoDecoderFactory(DefaultVideoDecoderFactory(eglBase.eglBaseContext))
                .createPeerConnectionFactory()

        val candidates = mutableListOf<IceCandidate>()
        val gathered = CountDownLatch(1)

        // No ICE servers: host-only, matching what the ingest source will use.
        val config = PeerConnection.RTCConfiguration(emptyList())
        config.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
        config.continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_ONCE

        val peer =
            requireNotNull(
                factory.createPeerConnection(
                    config,
                    object : NoOpPeerConnectionObserver() {
                        override fun onIceCandidate(candidate: IceCandidate) {
                            synchronized(candidates) { candidates.add(candidate) }
                        }

                        override fun onIceGatheringChange(
                            newState: PeerConnection.IceGatheringState,
                        ) {
                            if (newState == PeerConnection.IceGatheringState.COMPLETE) {
                                gathered.countDown()
                            }
                        }
                    },
                ),
            )

        try {
            peer.addTransceiver(org.webrtc.MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO)
            peer.createOffer(
                object : NoOpSdpObserver() {
                    override fun onCreateSuccess(sdp: SessionDescription) {
                        peer.setLocalDescription(NoOpSdpObserver(), sdp)
                    }
                },
                MediaConstraints(),
            )

            assertThat(gathered.await(15, TimeUnit.SECONDS))
                .describedAs("ICE gathering did not complete")
                .isTrue()

            val hotspotCandidates =
                synchronized(candidates) {
                    candidates.filter { it.sdp.contains("typ host") && it.sdp.contains(localIpv4) }
                }

            assertThat(hotspotCandidates)
                .describedAs(
                    "libwebrtc gathered no host candidate on the SoftAP address %s. " +
                        "All candidates: %s. Install ScopedNetworkChangeDetector before Phase 3.",
                    localIpv4,
                    synchronized(candidates) { candidates.map { it.sdp } },
                )
                .isNotEmpty()
        } finally {
            peer.dispose()
            factory.dispose()
            eglBase.release()
            scoped.release()
        }
    }

    private open class NoOpPeerConnectionObserver : PeerConnection.Observer {
        override fun onSignalingChange(state: PeerConnection.SignalingState) {}

        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {}

        override fun onIceConnectionReceivingChange(receiving: Boolean) {}

        override fun onIceGatheringChange(newState: PeerConnection.IceGatheringState) {}

        override fun onIceCandidate(candidate: IceCandidate) {}

        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) {}

        override fun onAddStream(stream: org.webrtc.MediaStream) {}

        override fun onRemoveStream(stream: org.webrtc.MediaStream) {}

        override fun onDataChannel(channel: org.webrtc.DataChannel) {}

        override fun onRenegotiationNeeded() {}

        override fun onAddTrack(
            receiver: org.webrtc.RtpReceiver,
            streams: Array<out org.webrtc.MediaStream>,
        ) {}
    }

    private open class NoOpSdpObserver : SdpObserver {
        override fun onCreateSuccess(sdp: SessionDescription) {}

        override fun onSetSuccess() {}

        override fun onCreateFailure(error: String?) {}

        override fun onSetFailure(error: String?) {}
    }

    private companion object {
        const val CONNECT_TIMEOUT_MS = 5_000
    }
}
