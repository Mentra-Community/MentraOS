package com.mentra.acsmeeting.source

/**
 * The WHIP endpoint's request handling, as a pure function.
 *
 * Everything here is decided from the request plus [IngestState]; sockets, peers and SDP generation
 * live in [WhipIngestServer]. That split exists because the interesting failures are protocol
 * failures — a second POST while a session is live, a DELETE against a stale id, a POST that
 * arrives after teardown — and those are painful to provoke through a socket and trivial to state
 * as a table.
 *
 * The glasses are the offerer and keep the WHIP client they already use against Cloudflare. Only
 * the endpoint moves onto the phone. So this implements the endpoint half of WHIP, and only the
 * parts one publisher on a private link needs: no trickle `PATCH`, no ICE restart, no auth.
 */
object WhipIngestProtocol {

  /** Base resource the glasses POST an offer to. */
  const val BASE_PATH = "/whip"

  /**
   * Largest offer we will buffer. Real offers are 2-6 KB; the cap is generous but finite so a
   * confused or hostile client on the hotspot cannot make the phone allocate without bound.
   */
  const val MAX_BODY_BYTES = 256 * 1024L

  const val SDP_CONTENT_TYPE = "application/sdp"

  /** A parsed request. [body] is only populated once the length check has passed. */
  data class Request(
    val method: String,
    val target: String,
    val contentType: String? = null,
    val contentLength: Long? = null,
    val body: String = "",
  )

  /**
   * @param activeSessionId the one publisher currently negotiated or negotiating, if any
   * @param stopped set by [WhipIngestServer.stop]. The listener stays up briefly afterwards so a
   *   late POST gets a real `410 Gone` instead of a connection reset it cannot distinguish from a
   *   network glitch.
   */
  data class State(val activeSessionId: String? = null, val stopped: Boolean = false)

  /** Where to point the `Location` header. WHIP clients DELETE against exactly this URL. */
  data class Endpoint(val host: String, val port: Int) {
    fun sessionUrl(sessionId: String) = "http://$host:$port$BASE_PATH/$sessionId"
  }

  data class Response(
    val status: Int,
    val reason: String,
    val headers: Map<String, String> = emptyMap(),
    val body: String = "",
  )

  sealed interface Action {
    /**
     * A valid offer for a free endpoint. The shell must answer it and reply `201` with the answer
     * and an absolute `Location`; [respondNegotiated] and [respondNegotiationFailed] build those.
     */
    data class Negotiate(val sessionId: String, val offer: String) : Action

    /** A DELETE matching the live session. The shell tears down, then replies with [terminated]. */
    data class Terminate(val sessionId: String) : Action

    /** Nothing to do but write this. */
    data class Reply(val response: Response) : Action
  }

  /**
   * @param newSessionId id to assign if this request opens a session. Passed in rather than minted
   *   here so the decision stays deterministic under test.
   */
  fun decide(request: Request, state: State, newSessionId: String): Action {
    // Tombstone first. A POST arriving after stop() is well-formed and would otherwise be granted
    // a session on an endpoint whose peer and scoped network are already gone.
    if (state.stopped) {
      return Action.Reply(Response(410, "Gone", body = "endpoint stopped"))
    }

    val target = request.target.substringBefore('?')
    val sessionId = sessionIdOf(target)

    return when {
      target == BASE_PATH || target == "$BASE_PATH/" -> decideOnBase(request, state, newSessionId)
      sessionId != null -> decideOnSession(request, state, sessionId)
      else -> Action.Reply(Response(404, "Not Found", body = "no such resource"))
    }
  }

  private fun decideOnBase(request: Request, state: State, newSessionId: String): Action {
    if (!request.method.equals("POST", ignoreCase = true)) {
      return Action.Reply(
        Response(405, "Method Not Allowed", mapOf("Allow" to "POST"), "POST an SDP offer"),
      )
    }
    // Length before type: we refuse to read the body at all, so we cannot have parsed its type.
    val length = request.contentLength
    if (length != null && length > MAX_BODY_BYTES) {
      return Action.Reply(
        Response(413, "Content Too Large", body = "offer exceeds $MAX_BODY_BYTES bytes"),
      )
    }
    if (!isSdp(request.contentType)) {
      return Action.Reply(
        Response(415, "Unsupported Media Type", body = "expected $SDP_CONTENT_TYPE"),
      )
    }
    if (request.body.isBlank()) {
      return Action.Reply(Response(400, "Bad Request", body = "empty offer"))
    }
    // One publisher. A second POST means the glasses re-published without deleting — usually a
    // retry after a reply they never saw. 409 keeps the live session rather than replacing a
    // working peer with a speculative one; the orchestrator's teardown is what frees the slot.
    state.activeSessionId?.let {
      return Action.Reply(
        Response(409, "Conflict", mapOf("Location" to it), "session $it already publishing"),
      )
    }
    return Action.Negotiate(newSessionId, request.body)
  }

  private fun decideOnSession(request: Request, state: State, sessionId: String): Action {
    if (!request.method.equals("DELETE", ignoreCase = true)) {
      return Action.Reply(
        Response(405, "Method Not Allowed", mapOf("Allow" to "DELETE"), "DELETE to terminate"),
      )
    }
    if (sessionId != state.activeSessionId) {
      return Action.Reply(Response(404, "Not Found", body = "session $sessionId is not active"))
    }
    return Action.Terminate(sessionId)
  }

  /** `201` with the answer. WHIP requires the endpoint to gather fully before answering. */
  fun respondNegotiated(endpoint: Endpoint, sessionId: String, answerSdp: String) = Response(
    status = 201,
    reason = "Created",
    headers = mapOf(
      "Location" to endpoint.sessionUrl(sessionId),
      "Content-Type" to SDP_CONTENT_TYPE,
    ),
    body = answerSdp,
  )

  /**
   * The offer was acceptable but we could not answer it — no answer in time, no host candidate on
   * the hotspot subnet, peer creation failed. `500` and not `4xx`: the publisher did nothing wrong,
   * and a retry may well succeed.
   */
  fun respondNegotiationFailed(reason: String) =
    Response(500, "Internal Server Error", body = reason)

  /** WHIP terminations return no content. */
  fun terminated() = Response(204, "No Content")

  private fun isSdp(contentType: String?): Boolean {
    val value = contentType?.substringBefore(';')?.trim() ?: return false
    return value.equals(SDP_CONTENT_TYPE, ignoreCase = true)
  }

  /** `/whip/<id>` -> `<id>`, for a single non-empty path segment. Anything else is not a session. */
  private fun sessionIdOf(target: String): String? {
    if (!target.startsWith("$BASE_PATH/")) return null
    val remainder = target.removePrefix("$BASE_PATH/")
    if (remainder.isEmpty() || remainder.contains('/')) return null
    return remainder
  }

  /**
   * Renders a response to the wire. `Content-Length` is always present and the connection always
   * closes: the glasses' WHIP client makes one request per connection, and a missing length turns
   * a clean `410` into a hang while the client waits for a body that never ends.
   */
  fun render(response: Response): String {
    val bodyBytes = response.body.toByteArray(Charsets.UTF_8)
    val head = StringBuilder("HTTP/1.1 ${response.status} ${response.reason}\r\n")
    for ((name, value) in response.headers) {
      head.append("$name: $value\r\n")
    }
    if (!response.headers.keys.any { it.equals("Content-Type", ignoreCase = true) } &&
      bodyBytes.isNotEmpty()
    ) {
      head.append("Content-Type: text/plain; charset=utf-8\r\n")
    }
    head.append("Content-Length: ${bodyBytes.size}\r\n")
    head.append("Connection: close\r\n\r\n")
    head.append(response.body)
    return head.toString()
  }

  /** Parses `POST /whip HTTP/1.1`. Null when the line is not a plausible request line. */
  fun parseRequestLine(line: String): Pair<String, String>? {
    val parts = line.trim().split(' ').filter { it.isNotEmpty() }
    if (parts.size < 2) return null
    val method = parts[0]
    val target = parts[1]
    if (method.isEmpty() || !target.startsWith("/")) return null
    return method to target
  }

  /** Case-insensitive header lookup, as HTTP requires and OkHttp clients assume. */
  fun headerValue(headers: Map<String, String>, name: String): String? =
    headers.entries.firstOrNull { it.key.equals(name, ignoreCase = true) }?.value
}
