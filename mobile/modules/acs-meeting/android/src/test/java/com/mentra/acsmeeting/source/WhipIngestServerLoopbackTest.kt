package com.mentra.acsmeeting.source

import java.io.BufferedReader
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.assertj.core.api.Assertions.assertThat
import org.junit.After
import org.junit.Test

/**
 * Drives [WhipIngestServer] over a real loopback socket with a stub negotiator.
 *
 * [WhipIngestProtocolTest] covers the decision table; this covers everything the table cannot: that
 * the listener binds to one address, that a request actually parses off the wire, that a
 * negotiation blocking for the length of an ICE gather does not block a concurrent DELETE, and that
 * the session slot is genuinely freed when a negotiation fails. Loopback stands in for the hotspot
 * address — the binding code is identical, only the interface differs.
 */
class WhipIngestServerLoopbackTest {

  private val loopback = InetAddress.getByName("127.0.0.1")
  private var server: WhipIngestServer? = null

  @After
  fun tearDown() {
    server?.closeNow()
  }

  /** Records what the server asked of it and answers on command. */
  private class StubNegotiator(
    private val answer: String = ANSWER_SDP,
    private val failWith: String? = null,
  ) : WhipIngestServer.Negotiator {
    val offers = ConcurrentLinkedQueue<Pair<String, String>>()
    val terminated = ConcurrentLinkedQueue<String>()
    val entered = CountDownLatch(1)

    /** Set to hold [negotiate] open, simulating a slow ICE gather. */
    @Volatile var block: CountDownLatch? = null

    override fun negotiate(sessionId: String, offer: String): Result<String> {
      offers.add(sessionId to offer)
      entered.countDown()
      block?.await(5, TimeUnit.SECONDS)
      return failWith?.let { Result.failure(IllegalStateException(it)) } ?: Result.success(answer)
    }

    override fun terminate(sessionId: String) {
      terminated.add(sessionId)
    }
  }

  private fun start(negotiator: WhipIngestServer.Negotiator, id: String = "sess-1") =
    WhipIngestServer(negotiator) { id }
      .also { server = it }
      .start(loopback)

  // -----------------------------------------------------------------
  // Binding
  // -----------------------------------------------------------------

  @Test
  fun `the listener binds to the given address and reports the port`() {
    val endpoint = start(StubNegotiator())

    assertThat(endpoint.host).isEqualTo("127.0.0.1")
    assertThat(endpoint.port).isGreaterThan(0)
    assertThat(server!!.boundEndpoint).isEqualTo(endpoint)
    assertThat(endpoint.sessionUrl("abc"))
      .isEqualTo("http://127.0.0.1:${endpoint.port}/whip/abc")
  }

  @Test
  fun `starting twice is rejected rather than silently rebinding`() {
    val ingest = WhipIngestServer(StubNegotiator())
    server = ingest
    ingest.start(loopback)

    // A second bind would leave an orphan listener holding a port for the rest of the process.
    runCatching { ingest.start(loopback) }
      .onSuccess { throw AssertionError("expected a rejected second start") }
      .onFailure { assertThat(it).isInstanceOf(IllegalStateException::class.java) }
  }

  // -----------------------------------------------------------------
  // Publishing
  // -----------------------------------------------------------------

  @Test
  fun `an offer off the wire is answered with 201 and an absolute location`() {
    val negotiator = StubNegotiator()
    val endpoint = start(negotiator)

    val response = request(endpoint.port, postOffer())

    assertThat(response.statusLine).isEqualTo("HTTP/1.1 201 Created")
    assertThat(response.header("Location"))
      .isEqualTo("http://127.0.0.1:${endpoint.port}/whip/sess-1")
    assertThat(response.header("Content-Type")).isEqualTo("application/sdp")
    assertThat(response.body).isEqualTo(ANSWER_SDP)
    assertThat(negotiator.offers).hasSize(1)
    assertThat(negotiator.offers.peek().second).contains("m=video")
  }

  @Test
  fun `the offer body reaches the negotiator intact`() {
    val negotiator = StubNegotiator()
    val endpoint = start(negotiator)
    val offer = "v=0\r\n" + "a=x\r\n".repeat(400)

    request(endpoint.port, postOffer(offer))

    assertThat(negotiator.offers.peek().second).isEqualTo(offer)
  }

  @Test
  fun `deleting the location terminates the publisher`() {
    val negotiator = StubNegotiator()
    val endpoint = start(negotiator)
    request(endpoint.port, postOffer())

    val response = request(endpoint.port, "DELETE /whip/sess-1 HTTP/1.1\r\nHost: x\r\n\r\n")

    assertThat(response.statusLine).isEqualTo("HTTP/1.1 204 No Content")
    assertThat(negotiator.terminated).containsExactly("sess-1")
  }

  @Test
  fun `a publisher can rejoin after deleting`() {
    val negotiator = StubNegotiator()
    val endpoint = start(negotiator)
    request(endpoint.port, postOffer())
    request(endpoint.port, "DELETE /whip/sess-1 HTTP/1.1\r\nHost: x\r\n\r\n")

    val response = request(endpoint.port, postOffer())

    assertThat(response.statusLine).isEqualTo("HTTP/1.1 201 Created")
    assertThat(negotiator.offers).hasSize(2)
  }

  // -----------------------------------------------------------------
  // Concurrency
  // -----------------------------------------------------------------

  /**
   * The reason each connection gets its own thread. A gather blocks for as long as ICE takes, and a
   * DELETE arriving during it — the user leaving mid-join — must not sit in the accept queue behind
   * it.
   */
  @Test
  fun `a delete is served while a negotiation is still gathering`() {
    val negotiator = StubNegotiator()
    val gate = CountDownLatch(1)
    negotiator.block = gate
    val endpoint = start(negotiator)

    val publisher = Thread { runCatching { request(endpoint.port, postOffer()) } }
    publisher.start()
    assertThat(negotiator.entered.await(5, TimeUnit.SECONDS))
      .describedAs("negotiation never started")
      .isTrue()

    // Stale id, so this exercises routing and response without disturbing the pending session.
    val response = request(endpoint.port, "DELETE /whip/other HTTP/1.1\r\nHost: x\r\n\r\n")

    assertThat(response.statusLine).isEqualTo("HTTP/1.1 404 Not Found")
    gate.countDown()
    publisher.join(5_000)
  }

  /** A retry that arrives during a gather must not create a second peer for the same publisher. */
  @Test
  fun `a duplicate offer during a gather conflicts instead of negotiating twice`() {
    val negotiator = StubNegotiator()
    val gate = CountDownLatch(1)
    negotiator.block = gate
    val endpoint = start(negotiator)

    val publisher = Thread { runCatching { request(endpoint.port, postOffer()) } }
    publisher.start()
    assertThat(negotiator.entered.await(5, TimeUnit.SECONDS)).isTrue()

    val response = request(endpoint.port, postOffer())

    assertThat(response.statusLine).isEqualTo("HTTP/1.1 409 Conflict")
    assertThat(negotiator.offers).hasSize(1)
    gate.countDown()
    publisher.join(5_000)
  }

  // -----------------------------------------------------------------
  // Failure handling
  // -----------------------------------------------------------------

  /**
   * A failed negotiation must free the slot. Otherwise one bad gather wedges the endpoint at 409
   * for the rest of the call and the only recovery is a full teardown.
   */
  @Test
  fun `a failed negotiation returns 500 and frees the session slot`() {
    val negotiator = StubNegotiator(failWith = "gather_timeout")
    val endpoint = start(negotiator)

    val failed = request(endpoint.port, postOffer())

    assertThat(failed.statusLine).isEqualTo("HTTP/1.1 500 Internal Server Error")
    assertThat(failed.body).isEqualTo("gather_timeout")
    assertThat(negotiator.terminated).contains("sess-1")

    val retry = request(endpoint.port, postOffer())
    assertThat(retry.statusLine).isEqualTo("HTTP/1.1 500 Internal Server Error")
    assertThat(negotiator.offers).describedAs("the slot was not freed").hasSize(2)
  }

  @Test
  fun `a malformed request line gets 400 rather than closing the connection`() {
    val endpoint = start(StubNegotiator())

    val response = request(endpoint.port, "not-a-request\r\n\r\n")

    assertThat(response.statusLine).isEqualTo("HTTP/1.1 400 Bad Request")
  }

  @Test
  fun `a get on the base path gets 405 off the wire`() {
    val endpoint = start(StubNegotiator())

    val response = request(endpoint.port, "GET /whip HTTP/1.1\r\nHost: x\r\n\r\n")

    assertThat(response.statusLine).isEqualTo("HTTP/1.1 405 Method Not Allowed")
    assertThat(response.header("Allow")).isEqualTo("POST")
  }

  @Test
  fun `an oversized offer is refused without its body being read`() {
    val negotiator = StubNegotiator()
    val endpoint = start(negotiator)
    val declared = WhipIngestProtocol.MAX_BODY_BYTES + 1

    val response = request(
      endpoint.port,
      "POST /whip HTTP/1.1\r\nHost: x\r\nContent-Type: application/sdp\r\n" +
        "Content-Length: $declared\r\n\r\n",
    )

    assertThat(response.statusLine).isEqualTo("HTTP/1.1 413 Content Too Large")
    assertThat(negotiator.offers).isEmpty()
  }

  /** Chunked bodies are not supported; the glasses' client sends a length. */
  @Test
  fun `an offer with no content length is refused as unsupported`() {
    val negotiator = StubNegotiator()
    val endpoint = start(negotiator)

    val response = request(
      endpoint.port,
      "POST /whip HTTP/1.1\r\nHost: x\r\nContent-Type: application/sdp\r\n" +
        "Transfer-Encoding: chunked\r\n\r\n",
    )

    assertThat(response.statusLine).isEqualTo("HTTP/1.1 400 Bad Request")
    assertThat(negotiator.offers).isEmpty()
  }

  // -----------------------------------------------------------------
  // Teardown
  // -----------------------------------------------------------------

  /**
   * The tombstone. A connection refused is indistinguishable from a Wi-Fi glitch, so the glasses
   * would retry; `410 Gone` tells them the endpoint is deliberately finished.
   */
  @Test
  fun `an offer after stop gets 410 while the tombstone is up`() {
    val negotiator = StubNegotiator()
    val endpoint = start(negotiator)
    request(endpoint.port, postOffer())

    server!!.stop()

    val response = request(endpoint.port, postOffer())
    assertThat(response.statusLine).isEqualTo("HTTP/1.1 410 Gone")
    assertThat(negotiator.offers).describedAs("no new negotiation after stop").hasSize(1)
  }

  @Test
  fun `stop terminates the live publisher`() {
    val negotiator = StubNegotiator()
    val endpoint = start(negotiator)
    request(endpoint.port, postOffer())

    server!!.stop()

    assertThat(negotiator.terminated).containsExactly("sess-1")
  }

  @Test
  fun `the listener is gone once the tombstone expires`() {
    val negotiator = StubNegotiator()
    val endpoint = start(negotiator)
    server!!.stop()

    WhipIngestServer.awaitTombstone()

    assertThat(server!!.boundEndpoint).isNull()
    runCatching { request(endpoint.port, postOffer()) }
      .onSuccess { throw AssertionError("listener still accepting after the tombstone: $it") }
  }

  @Test
  fun `stop is idempotent and safe before any publisher connects`() {
    val ingest = WhipIngestServer(StubNegotiator())
    server = ingest
    ingest.start(loopback)

    ingest.stop()
    ingest.stop()
    ingest.closeNow()

    assertThat(ingest.boundEndpoint).isNull()
  }

  // -----------------------------------------------------------------
  // Wire helpers
  // -----------------------------------------------------------------

  private data class WireResponse(
    val statusLine: String,
    val headers: Map<String, String>,
    val body: String,
  ) {
    fun header(name: String) = WhipIngestProtocol.headerValue(headers, name)
  }

  private fun postOffer(offer: String = OFFER_SDP): String =
    "POST /whip HTTP/1.1\r\nHost: x\r\nContent-Type: application/sdp\r\n" +
      "Content-Length: ${offer.toByteArray().size}\r\n\r\n$offer"

  private fun request(port: Int, raw: String): WireResponse =
    Socket().use { socket ->
      socket.connect(InetSocketAddress(loopback, port), 3_000)
      socket.soTimeout = 10_000
      socket.getOutputStream().apply {
        write(raw.toByteArray(Charsets.UTF_8))
        flush()
      }
      readResponse(socket.getInputStream().bufferedReader(Charsets.UTF_8))
    }

  private fun readResponse(reader: BufferedReader): WireResponse {
    val statusLine = reader.readLine() ?: error("no status line")
    val headers = mutableMapOf<String, String>()
    while (true) {
      val line = reader.readLine() ?: break
      if (line.isEmpty()) break
      val separator = line.indexOf(':')
      if (separator > 0) {
        headers[line.substring(0, separator).trim()] = line.substring(separator + 1).trim()
      }
    }
    val length = WhipIngestProtocol.headerValue(headers, "Content-Length")?.toIntOrNull() ?: 0
    val body = CharArray(length)
    var read = 0
    while (read < length) {
      val count = reader.read(body, read, length - read)
      if (count < 0) break
      read += count
    }
    return WireResponse(statusLine, headers, String(body, 0, read))
  }

  private companion object {
    const val OFFER_SDP =
      "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n" +
        "a=candidate:1 1 udp 2122260223 192.168.43.1 51234 typ host generation 0\r\n"
    const val ANSWER_SDP =
      "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n" +
        "a=candidate:1 1 udp 2122260223 192.168.43.20 51235 typ host generation 0\r\n"
  }
}
