package com.mentra.acsmeeting.source

import com.mentra.acsmeeting.source.WhipIngestProtocol.Action
import com.mentra.acsmeeting.source.WhipIngestProtocol.Endpoint
import com.mentra.acsmeeting.source.WhipIngestProtocol.Request
import com.mentra.acsmeeting.source.WhipIngestProtocol.State
import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

/**
 * The endpoint's decision table.
 *
 * These are the cases that are painful to provoke against a live device and cheap to state here: a
 * duplicate POST during a gather, a DELETE against an id that has already been replaced, a POST
 * that lands after teardown. Each one has a specific status the glasses' WHIP client reacts to
 * differently, so the statuses are pinned rather than merely "not 200".
 */
class WhipIngestProtocolTest {

  private val endpoint = Endpoint("192.168.43.20", 8790)
  private val free = State()
  private val offer = "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n"

  private fun post(
    body: String = offer,
    contentType: String? = "application/sdp",
    length: Long? = body.length.toLong(),
    target: String = "/whip",
  ) = Request("POST", target, contentType, length, body)

  // -----------------------------------------------------------------
  // The happy path
  // -----------------------------------------------------------------

  @Test
  fun `a valid offer on a free endpoint negotiates`() {
    val action = WhipIngestProtocol.decide(post(), free, "sess-1")

    assertThat(action).isInstanceOf(Action.Negotiate::class.java)
    val negotiate = action as Action.Negotiate
    assertThat(negotiate.sessionId).isEqualTo("sess-1")
    assertThat(negotiate.offer).isEqualTo(offer)
  }

  @Test
  fun `a lowercase method still negotiates`() {
    // HTTP methods are case-sensitive in the spec, but accepting the variant costs nothing and
    // failing it would present as an unexplained 405 on device.
    val action = WhipIngestProtocol.decide(post().copy(method = "post"), free, "sess-1")

    assertThat(action).isInstanceOf(Action.Negotiate::class.java)
  }

  @Test
  fun `a query string does not hide the base path`() {
    val action = WhipIngestProtocol.decide(post(target = "/whip?x=1"), free, "sess-1")

    assertThat(action).isInstanceOf(Action.Negotiate::class.java)
  }

  @Test
  fun `a trailing slash is the same resource`() {
    val action = WhipIngestProtocol.decide(post(target = "/whip/"), free, "sess-1")

    assertThat(action).isInstanceOf(Action.Negotiate::class.java)
  }

  @Test
  fun `a content type with parameters is still sdp`() {
    val action =
      WhipIngestProtocol.decide(post(contentType = "application/SDP; charset=utf-8"), free, "s")

    assertThat(action).isInstanceOf(Action.Negotiate::class.java)
  }

  // -----------------------------------------------------------------
  // 201 carries the absolute Location the client will DELETE
  // -----------------------------------------------------------------

  /**
   * Absolute, not `/whip/<id>`. WHIP terminations go to the URL in `Location`, and the glasses'
   * client has not been verified to resolve a relative one against the request URL.
   */
  @Test
  fun `201 returns an absolute location and the answer`() {
    val response = WhipIngestProtocol.respondNegotiated(endpoint, "sess-1", "v=0 answer")

    assertThat(response.status).isEqualTo(201)
    assertThat(response.headers["Location"]).isEqualTo("http://192.168.43.20:8790/whip/sess-1")
    assertThat(response.headers["Content-Type"]).isEqualTo("application/sdp")
    assertThat(response.body).isEqualTo("v=0 answer")
  }

  @Test
  fun `the location url is what a delete is accepted on`() {
    val sessionUrl = endpoint.sessionUrl("sess-1")
    val path = sessionUrl.removePrefix("http://192.168.43.20:8790")

    val action = WhipIngestProtocol.decide(
      Request("DELETE", path),
      State(activeSessionId = "sess-1"),
      "unused",
    )

    assertThat(action).isEqualTo(Action.Terminate("sess-1"))
  }

  // -----------------------------------------------------------------
  // One publisher
  // -----------------------------------------------------------------

  /**
   * A second POST usually means the glasses retried a request whose reply they never saw. Replacing
   * a live peer with a speculative one would drop a working call, so the live session wins.
   */
  @Test
  fun `a second offer while publishing conflicts and keeps the live session`() {
    val action = WhipIngestProtocol.decide(post(), State(activeSessionId = "sess-1"), "sess-2")

    val response = (action as Action.Reply).response
    assertThat(response.status).isEqualTo(409)
    assertThat(response.headers["Location"]).isEqualTo("sess-1")
    assertThat(response.body).contains("sess-1")
  }

  // -----------------------------------------------------------------
  // Termination
  // -----------------------------------------------------------------

  @Test
  fun `deleting the active session terminates it`() {
    val action =
      WhipIngestProtocol.decide(Request("DELETE", "/whip/sess-1"), State("sess-1"), "unused")

    assertThat(action).isEqualTo(Action.Terminate("sess-1"))
  }

  /**
   * A stale DELETE must not tear down whoever holds the slot now. This is the rejoin race: the
   * glasses DELETE an old session while a new one is already publishing.
   */
  @Test
  fun `deleting a stale session is a 404 and spares the current publisher`() {
    val action =
      WhipIngestProtocol.decide(Request("DELETE", "/whip/old"), State("sess-2"), "unused")

    assertThat((action as Action.Reply).response.status).isEqualTo(404)
  }

  @Test
  fun `deleting when nothing is active is a 404`() {
    val action = WhipIngestProtocol.decide(Request("DELETE", "/whip/sess-1"), free, "unused")

    assertThat((action as Action.Reply).response.status).isEqualTo(404)
  }

  @Test
  fun `termination returns no content`() {
    assertThat(WhipIngestProtocol.terminated().status).isEqualTo(204)
    assertThat(WhipIngestProtocol.terminated().body).isEmpty()
  }

  // -----------------------------------------------------------------
  // The tombstone
  // -----------------------------------------------------------------

  /**
   * After stop, a well-formed POST is still refused. Granting it a session would attach a publisher
   * to an endpoint whose peer and scoped network are already gone.
   */
  @Test
  fun `a well formed offer after stop is gone, not created`() {
    val action = WhipIngestProtocol.decide(post(), State(stopped = true), "sess-1")

    assertThat((action as Action.Reply).response.status).isEqualTo(410)
  }

  @Test
  fun `a delete after stop is gone rather than 404`() {
    val action = WhipIngestProtocol.decide(
      Request("DELETE", "/whip/sess-1"),
      State(activeSessionId = "sess-1", stopped = true),
      "unused",
    )

    assertThat((action as Action.Reply).response.status).isEqualTo(410)
  }

  // -----------------------------------------------------------------
  // Malformed requests
  // -----------------------------------------------------------------

  @Test
  fun `a non post on the base path is 405 and advertises post`() {
    val action = WhipIngestProtocol.decide(Request("GET", "/whip"), free, "sess-1")

    val response = (action as Action.Reply).response
    assertThat(response.status).isEqualTo(405)
    assertThat(response.headers["Allow"]).isEqualTo("POST")
  }

  @Test
  fun `a non delete on the session path is 405 and advertises delete`() {
    val action = WhipIngestProtocol.decide(Request("GET", "/whip/sess-1"), State("sess-1"), "x")

    val response = (action as Action.Reply).response
    assertThat(response.status).isEqualTo(405)
    assertThat(response.headers["Allow"]).isEqualTo("DELETE")
  }

  @Test
  fun `a non sdp content type is 415`() {
    val action = WhipIngestProtocol.decide(post(contentType = "application/json"), free, "s")

    assertThat((action as Action.Reply).response.status).isEqualTo(415)
  }

  @Test
  fun `a missing content type is 415`() {
    val action = WhipIngestProtocol.decide(post(contentType = null), free, "s")

    assertThat((action as Action.Reply).response.status).isEqualTo(415)
  }

  /** Length is checked before type, because an oversized body is never read and so never typed. */
  @Test
  fun `an oversized offer is 413 even before the type is considered`() {
    val action = WhipIngestProtocol.decide(
      post(contentType = "application/json", length = WhipIngestProtocol.MAX_BODY_BYTES + 1),
      free,
      "s",
    )

    assertThat((action as Action.Reply).response.status).isEqualTo(413)
  }

  @Test
  fun `an offer exactly at the cap is accepted`() {
    val action = WhipIngestProtocol.decide(
      post(length = WhipIngestProtocol.MAX_BODY_BYTES),
      free,
      "s",
    )

    assertThat(action).isInstanceOf(Action.Negotiate::class.java)
  }

  @Test
  fun `an empty offer body is 400`() {
    val action = WhipIngestProtocol.decide(post(body = "   ", length = 3), free, "s")

    assertThat((action as Action.Reply).response.status).isEqualTo(400)
  }

  @Test
  fun `an unrelated path is 404`() {
    val action = WhipIngestProtocol.decide(post(target = "/health"), free, "s")

    assertThat((action as Action.Reply).response.status).isEqualTo(404)
  }

  @Test
  fun `a nested session path is not a session id`() {
    val action =
      WhipIngestProtocol.decide(Request("DELETE", "/whip/a/b"), State("a"), "unused")

    assertThat((action as Action.Reply).response.status).isEqualTo(404)
  }

  @Test
  fun `negotiation failure is a 500, not a client error`() {
    // The publisher did nothing wrong and a retry may succeed, so this must not read as 4xx.
    val response = WhipIngestProtocol.respondNegotiationFailed("gather_timeout")

    assertThat(response.status).isEqualTo(500)
    assertThat(response.body).isEqualTo("gather_timeout")
  }

  // -----------------------------------------------------------------
  // Wire rendering
  // -----------------------------------------------------------------

  /**
   * A missing `Content-Length` turns a clean refusal into a hang: the client waits for a body that
   * never ends, then retries on timeout, which is exactly what the tombstone is meant to prevent.
   */
  @Test
  fun `every response carries a content length and closes the connection`() {
    val rendered = WhipIngestProtocol.render(WhipIngestProtocol.terminated())

    assertThat(rendered).startsWith("HTTP/1.1 204 No Content\r\n")
    assertThat(rendered).contains("Content-Length: 0\r\n")
    assertThat(rendered).contains("Connection: close\r\n")
    assertThat(rendered).endsWith("\r\n\r\n")
  }

  @Test
  fun `the rendered length counts utf8 bytes rather than characters`() {
    val rendered = WhipIngestProtocol.render(
      WhipIngestProtocol.Response(500, "Internal Server Error", body = "café"),
    )

    assertThat(rendered).contains("Content-Length: 5\r\n")
  }

  @Test
  fun `an sdp answer keeps its own content type`() {
    val rendered =
      WhipIngestProtocol.render(WhipIngestProtocol.respondNegotiated(endpoint, "s", "v=0"))

    assertThat(rendered).contains("Content-Type: application/sdp\r\n")
    assertThat(rendered).doesNotContain("text/plain")
    assertThat(rendered).endsWith("\r\n\r\nv=0")
  }

  @Test
  fun `a plain text body gets a default content type`() {
    val rendered =
      WhipIngestProtocol.render(WhipIngestProtocol.Response(410, "Gone", body = "stopped"))

    assertThat(rendered).contains("Content-Type: text/plain; charset=utf-8\r\n")
  }

  // -----------------------------------------------------------------
  // Request line and header parsing
  // -----------------------------------------------------------------

  @Test
  fun `a request line parses into method and target`() {
    assertThat(WhipIngestProtocol.parseRequestLine("POST /whip HTTP/1.1"))
      .isEqualTo("POST" to "/whip")
  }

  @Test
  fun `a request line with extra spacing still parses`() {
    assertThat(WhipIngestProtocol.parseRequestLine("  DELETE   /whip/s1   HTTP/1.1  "))
      .isEqualTo("DELETE" to "/whip/s1")
  }

  @Test
  fun `an absolute or garbage request target is rejected`() {
    // Only origin-form targets are accepted; anything else would bypass the path routing above.
    assertThat(WhipIngestProtocol.parseRequestLine("POST http://host/whip HTTP/1.1")).isNull()
    assertThat(WhipIngestProtocol.parseRequestLine("garbage")).isNull()
    assertThat(WhipIngestProtocol.parseRequestLine("")).isNull()
  }

  @Test
  fun `header lookup ignores case as clients assume`() {
    val headers = mapOf("content-TYPE" to "application/sdp", "Content-Length" to "12")

    assertThat(WhipIngestProtocol.headerValue(headers, "Content-Type")).isEqualTo("application/sdp")
    assertThat(WhipIngestProtocol.headerValue(headers, "CONTENT-LENGTH")).isEqualTo("12")
    assertThat(WhipIngestProtocol.headerValue(headers, "Missing")).isNull()
  }
}
