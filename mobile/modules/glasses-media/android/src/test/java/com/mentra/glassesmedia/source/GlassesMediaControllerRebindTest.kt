package com.mentra.glassesmedia.source

import java.net.BindException
import java.net.InetAddress
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.After
import org.junit.Test

class GlassesMediaControllerRebindTest {

  @After
  fun restoreKillSwitch() {
    MediaDiagnostics.SOFTAP_RECOVERY_ENABLED = true
  }

  private class RebindFakeSource : GlassesMediaSource {
    var nextUrl: String? = "http://127.0.0.1:2/whip"
    var forceClosed = 0
    var closed = true
    var restarted = 0
    override var state: SourceState = SourceState.IDLE
    override var ingestUrl: String? = "http://127.0.0.1:1/whip"

    override fun start(config: SourceConfig) {
      ingestUrl = nextUrl
      state = SourceState.CONNECTING
    }

    override fun restart(config: SourceConfig) {
      restarted += 1
      start(config)
    }

    override fun stop() {
      state = SourceState.IDLE
    }

    override fun setPcmDeliveryEnabled(enabled: Boolean) = Unit

    override fun forceCloseIngest() {
      forceClosed += 1
    }

    override fun awaitIngestClosed(timeoutMs: Long): Boolean = closed
  }

  private fun controller(source: RebindFakeSource): GlassesMediaController {
    val controller = GlassesMediaController { _, _, _ -> source }
    controller.attach(
      video = { _ -> },
      pcm = { _, _, _ -> },
      config = SourceConfig("", SourceKind.SOFTAP, bindAddress = "127.0.0.1"),
    )
    // attach() starts the source and would consume nextUrl. Restore the "old" URL the
    // rebind check compares against, then set the URL restart should mint.
    source.ingestUrl = "http://127.0.0.1:1/whip"
    source.nextUrl = "http://127.0.0.1:2/whip"
    source.restarted = 0
    source.forceClosed = 0
    return controller
  }

  @Test
  fun rebindReturnsAFreshUrlAndForceClosesTheParkedListener() {
    val source = RebindFakeSource()
    val controller = controller(source)

    val url = controller.rebindIngest(
      SourceConfig("", SourceKind.SOFTAP, bindAddress = "127.0.0.1"),
      timeoutMs = 50,
    )

    assertThat(url).isEqualTo("http://127.0.0.1:2/whip")
    assertThat(source.restarted).isEqualTo(1)
    assertThat(source.forceClosed).isEqualTo(1)
  }

  @Test
  fun rebindThrowsWhenTheNewUrlIsUnchanged() {
    val source = RebindFakeSource()
    val controller = controller(source)
    source.nextUrl = source.ingestUrl

    assertThatThrownBy {
      controller.rebindIngest(
        SourceConfig("", SourceKind.SOFTAP, bindAddress = "127.0.0.1"),
        timeoutMs = 50,
      )
    }.isInstanceOf(IllegalStateException::class.java)
      .hasMessageContaining("did not mint a new listener")
    assertThat(source.forceClosed).isEqualTo(0)
  }

  @Test
  fun rebindThrowsWhenTheNewUrlIsNull() {
    val source = RebindFakeSource()
    val controller = controller(source)
    source.nextUrl = null

    assertThatThrownBy {
      controller.rebindIngest(
        SourceConfig("", SourceKind.SOFTAP, bindAddress = "127.0.0.1"),
        timeoutMs = 50,
      )
    }.isInstanceOf(IllegalStateException::class.java)
      .hasMessageContaining("did not mint a new listener")
    assertThat(source.forceClosed).isEqualTo(0)
  }

  @Test
  fun rebindThrowsWhenForceCloseDoesNotReleaseTheOldListener() {
    val source = RebindFakeSource()
    val controller = controller(source)
    source.closed = false

    assertThatThrownBy {
      controller.rebindIngest(
        SourceConfig("", SourceKind.SOFTAP, bindAddress = "127.0.0.1"),
        timeoutMs = 50,
      )
    }.isInstanceOf(IllegalStateException::class.java)
      .hasMessageContaining("did not release the old listener")
    assertThat(source.forceClosed).isEqualTo(1)
  }

  @Test
  fun rebindThrowsWhenRecoveryIsDisabled() {
    val source = RebindFakeSource()
    val controller = controller(source)
    MediaDiagnostics.SOFTAP_RECOVERY_ENABLED = false

    assertThatThrownBy {
      controller.rebindIngest(
        SourceConfig("", SourceKind.SOFTAP, bindAddress = "127.0.0.1"),
        timeoutMs = 50,
      )
    }.isInstanceOf(IllegalStateException::class.java)
      .hasMessageContaining("disabled")
    assertThat(source.restarted).isEqualTo(0)
  }
}

/**
 * The fail-closed contract [GlassesMediaController.rebindIngest] relies on: a live listener
 * keeps its port until [WhipIngestServer.closeNow], so a second bind on that port is refused.
 */
class WhipIngestRebindPortTest {

  private val loopback = InetAddress.getByName("127.0.0.1")
  private val servers = mutableListOf<WhipIngestServer>()

  @After
  fun tearDown() {
    servers.forEach { runCatching { it.closeNow() } }
  }

  private class StubNegotiator : WhipIngestServer.Negotiator {
    override fun negotiate(sessionId: String, offer: String) = Result.success("v=0")
    override fun terminate(sessionId: String) = Unit
  }

  private fun start(port: Int = 0): WhipIngestServer {
    val server = WhipIngestServer(StubNegotiator())
    servers.add(server)
    server.start(loopback, port)
    return server
  }

  @Test
  fun aHeldPortFailsClosedUntilForceCloseReleasesIt() {
    val first = start()
    val port = requireNotNull(first.boundEndpoint).port

    val occupant = WhipIngestServer(StubNegotiator())
    servers.add(occupant)
    runCatching { occupant.start(loopback, port) }
      .onSuccess {
        occupant.closeNow()
        throw AssertionError("expected a held port to reject a second bind")
      }
      .onFailure { assertThat(it).isInstanceOfAny(BindException::class.java, java.net.SocketException::class.java) }

    first.closeNow()
    assertThat(first.awaitClosed(1_000)).isTrue()

    val replacement = start(port)
    assertThat(requireNotNull(replacement.boundEndpoint).port).isEqualTo(port)
  }

  @Test
  fun aTombstoneWithoutForceCloseStillHoldsThePort() {
    val first = start()
    val port = requireNotNull(first.boundEndpoint).port
    first.stop()

    val occupant = WhipIngestServer(StubNegotiator())
    servers.add(occupant)
    runCatching { occupant.start(loopback, port) }
      .onSuccess {
        occupant.closeNow()
        throw AssertionError("expected the tombstoned listener to keep holding its port")
      }
      .onFailure { assertThat(it).isInstanceOfAny(BindException::class.java, java.net.SocketException::class.java) }

    first.closeNow()
    assertThat(first.awaitClosed(1_000)).isTrue()
  }
}
