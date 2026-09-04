package com.mentra.acsmeeting.source

import android.util.Log
import com.mentra.acsmeeting.trace.SoftApTrace
import java.io.BufferedOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * The WHIP endpoint, moved off Cloudflare and onto the phone.
 *
 * The glasses keep publishing exactly as they do today — POST an SDP offer, read the answer, DELETE
 * the `Location` when done. Only the address changes, from an HTTPS Cloudflare URL to
 * `http://192.168.43.x:port/whip` on the hotspot. Keeping the glasses as the offerer is what makes
 * this a small change on the device that is hardest to debug.
 *
 * The listener is bound to the SoftAP [InetAddress] itself rather than to the wildcard address.
 * `Network.bindSocket` has no `ServerSocket` overload, and it is not needed: binding to that one
 * local address is what restricts which interface can accept these connections, and it keeps the
 * endpoint off the phone's other networks. Binding libwebrtc's own UDP sockets is a separate
 * problem and is handled by the host-only ICE configuration in [LocalWhipIngestSource] plus
 * [com.mentra.acsmeeting.network.ScopedNetworkChangeDetector].
 *
 * Protocol decisions live in [WhipIngestProtocol]; this class owns sockets, threads and the session
 * slot.
 */
class WhipIngestServer(
  private val negotiator: Negotiator,
  private val idFactory: () -> String = { UUID.randomUUID().toString().replace("-", "").take(12) },
) {

  /**
   * Turns an offer into an answer. Separate from the server so the protocol and socket behaviour
   * test without WebRTC, and so the peer can be owned by the session rather than by the listener.
   */
  interface Negotiator {
    /**
     * Called off the accept thread and expected to block until ICE gathering completes: WHIP
     * requires the endpoint to gather fully before answering, since neither side does trickle
     * `PATCH` here. Returning a failure produces `500` and frees the session slot.
     */
    fun negotiate(sessionId: String, offer: String): Result<String>

    /** Release the peer for [sessionId]. Must be idempotent; DELETE and stop() can both call it. */
    fun terminate(sessionId: String)
  }

  private val lock = Any()
  private var state = WhipIngestProtocol.State()
  private var server: ServerSocket? = null
  private var endpoint: WhipIngestProtocol.Endpoint? = null
  private var acceptThread: Thread? = null
  private val connections = Executors.newCachedThreadPool { runnable ->
    Thread(runnable, "whip-ingest-conn").apply { isDaemon = true }
  }
  private val accepted = AtomicInteger()

  /** Bound endpoint, or null before [start]. This is the URL the glasses must be told to POST to. */
  val boundEndpoint: WhipIngestProtocol.Endpoint?
    get() = synchronized(lock) { endpoint }

  /**
   * Binds and begins accepting.
   *
   * @param address the phone's own address on the SoftAP, from
   *   [com.mentra.acsmeeting.network.ScopedSoftApNetwork.localIpv4]
   * @param port 0 to let the OS choose, which is what production does; the fixed-port form exists
   *   for tests
   */
  fun start(address: InetAddress, port: Int = 0): WhipIngestProtocol.Endpoint {
    synchronized(lock) {
      check(server == null) { "ingest server already started" }
      val socket = ServerSocket()
      socket.reuseAddress = true
      socket.bind(InetSocketAddress(address, port), BACKLOG)
      val bound = WhipIngestProtocol.Endpoint(address.hostAddress ?: "127.0.0.1", socket.localPort)
      server = socket
      endpoint = bound
      state = WhipIngestProtocol.State()
      acceptThread = Thread({ acceptLoop(socket) }, "whip-ingest-accept").apply {
        isDaemon = true
        start()
      }
      SoftApTrace.stage(
        "whip_listener_bound",
        "host" to bound.host,
        "port" to bound.port,
        "url" to "${bound.host}:${bound.port}${WhipIngestProtocol.BASE_PATH}",
      )
      return bound
    }
  }

  /**
   * Stops accepting new publishers and tears the live session down.
   *
   * The listener is not closed immediately. For [TOMBSTONE_MS] it stays up answering `410 Gone`, so
   * a POST or DELETE already in flight from the glasses gets a real HTTP status instead of a
   * connection reset — which a client cannot tell apart from a Wi-Fi glitch, and would retry.
   */
  fun stop() {
    val live: String?
    synchronized(lock) {
      if (server == null) return
      live = state.activeSessionId
      state = WhipIngestProtocol.State(activeSessionId = null, stopped = true)
    }
    live?.let { runCatching { negotiator.terminate(it) } }
    SoftApTrace.stage("whip_listener_tombstoned", "graceMs" to TOMBSTONE_MS, "session" to live)

    val closer = Thread({
      Thread.sleep(TOMBSTONE_MS)
      closeListener()
    }, "whip-ingest-tombstone")
    closer.isDaemon = true
    closer.start()
  }

  /** Closes the listener without waiting out the tombstone. For tests and hard teardown. */
  fun closeNow() {
    synchronized(lock) {
      if (server == null) return
      state = WhipIngestProtocol.State(activeSessionId = null, stopped = true)
    }
    closeListener()
  }

  private fun closeListener() {
    val socket = synchronized(lock) {
      val current = server
      server = null
      endpoint = null
      current
    } ?: return
    runCatching { socket.close() }
    connections.shutdownNow()
    SoftApTrace.stage("whip_listener_closed", "accepted" to accepted.get())
  }

  private fun acceptLoop(socket: ServerSocket) {
    while (!socket.isClosed) {
      val connection = try {
        socket.accept()
      } catch (_: SocketException) {
        return // closed under us; the only expected exit
      } catch (error: IOException) {
        Log.w(TAG, "accept failed", error)
        return
      }
      accepted.incrementAndGet()
      // Each connection on its own thread: a negotiation blocks for the length of an ICE gather,
      // and a DELETE arriving during one must not queue behind it.
      try {
        connections.execute { serve(connection) }
      } catch (_: java.util.concurrent.RejectedExecutionException) {
        runCatching { connection.close() }
      }
    }
  }

  private fun serve(connection: Socket) {
    connection.use { socket ->
      socket.soTimeout = READ_TIMEOUT_MS
      val output = BufferedOutputStream(socket.getOutputStream())
      try {
        val request = readRequest(socket.getInputStream())
        if (request == null) {
          write(output, WhipIngestProtocol.Response(400, "Bad Request", body = "malformed request"))
          return
        }
        write(output, handle(request))
      } catch (error: Exception) {
        Log.w(TAG, "connection failed", error)
        runCatching {
          write(output, WhipIngestProtocol.Response(400, "Bad Request", body = "read failed"))
        }
      }
    }
  }

  private fun handle(request: WhipIngestProtocol.Request): WhipIngestProtocol.Response {
    val action: WhipIngestProtocol.Action
    val endpointSnapshot: WhipIngestProtocol.Endpoint?
    synchronized(lock) {
      action = WhipIngestProtocol.decide(request, state, idFactory())
      endpointSnapshot = endpoint
      // Reserve the slot inside the lock so a duplicate POST during a gather gets 409 rather than
      // creating a second peer for the same publisher.
      when (action) {
        is WhipIngestProtocol.Action.Negotiate ->
          state = state.copy(activeSessionId = action.sessionId)
        is WhipIngestProtocol.Action.Terminate ->
          state = state.copy(activeSessionId = null)
        is WhipIngestProtocol.Action.Reply -> Unit
      }
    }

    return when (action) {
      is WhipIngestProtocol.Action.Reply -> action.response.also {
        if (it.status >= 400) {
          SoftApTrace.stage("whip_request_rejected", "status" to it.status, "path" to request.target)
        }
      }

      is WhipIngestProtocol.Action.Terminate -> {
        SoftApTrace.stage("whip_session_deleted", "session" to action.sessionId)
        runCatching { negotiator.terminate(action.sessionId) }
        WhipIngestProtocol.terminated()
      }

      is WhipIngestProtocol.Action.Negotiate -> {
        SoftApTrace.stage(
          "whip_offer_received",
          "session" to action.sessionId,
          "offerBytes" to action.offer.length,
        )
        val answer = runCatching { negotiator.negotiate(action.sessionId, action.offer) }
          .getOrElse { Result.failure(it) }
        answer.fold(
          onSuccess = { sdp ->
            val target = endpointSnapshot
            if (target == null) {
              releaseSlot(action.sessionId)
              WhipIngestProtocol.respondNegotiationFailed("endpoint closed during negotiation")
            } else {
              SoftApTrace.stage(
                "whip_answer_sent",
                "session" to action.sessionId,
                "answerBytes" to sdp.length,
              )
              WhipIngestProtocol.respondNegotiated(target, action.sessionId, sdp)
            }
          },
          onFailure = { error ->
            releaseSlot(action.sessionId)
            val reason = error.message ?: error.javaClass.simpleName
            SoftApTrace.failure(
              "whip_negotiation_failed",
              "reason" to reason,
              "session" to action.sessionId,
            )
            WhipIngestProtocol.respondNegotiationFailed(reason)
          },
        )
      }
    }
  }

  /** Frees the slot only if this session still holds it, so a newer publisher is not evicted. */
  private fun releaseSlot(sessionId: String) {
    synchronized(lock) {
      if (state.activeSessionId == sessionId) {
        state = state.copy(activeSessionId = null)
      }
    }
    runCatching { negotiator.terminate(sessionId) }
  }

  private fun write(output: BufferedOutputStream, response: WhipIngestProtocol.Response) {
    output.write(WhipIngestProtocol.render(response).toByteArray(Charsets.UTF_8))
    output.flush()
  }

  companion object {
    private const val TAG = "ACS-SPIKE"
    private const val BACKLOG = 4
    private const val READ_TIMEOUT_MS = 10_000

    /**
     * How long the endpoint answers `410` after [stop]. Long enough for an in-flight request from
     * the glasses to land, short enough not to hold the port across a rejoin.
     */
    const val TOMBSTONE_MS = 3_000L

    /**
     * Reads a request into [WhipIngestProtocol.Request]. Only `Content-Length` bodies are
     * supported: the glasses' WHIP client sends one, and `chunked` would be a silent 400 otherwise,
     * so it is rejected explicitly by the missing-length path below.
     */
    fun readRequest(stream: InputStream): WhipIngestProtocol.Request? {
      val reader = stream.bufferedReader(Charsets.UTF_8)
      val (method, target) = WhipIngestProtocol.parseRequestLine(
        reader.readLine() ?: return null,
      ) ?: return null

      val headers = mutableMapOf<String, String>()
      while (true) {
        val line = reader.readLine() ?: break
        if (line.isEmpty()) break
        val separator = line.indexOf(':')
        if (separator <= 0) continue
        headers[line.substring(0, separator).trim()] = line.substring(separator + 1).trim()
      }

      val contentType = WhipIngestProtocol.headerValue(headers, "Content-Type")
      val contentLength = WhipIngestProtocol.headerValue(headers, "Content-Length")?.toLongOrNull()

      // Do not read a body we have already decided to refuse. decide() checks the length first for
      // exactly this reason.
      if (contentLength == null || contentLength <= 0 ||
        contentLength > WhipIngestProtocol.MAX_BODY_BYTES
      ) {
        return WhipIngestProtocol.Request(method, target, contentType, contentLength)
      }

      val body = CharArray(contentLength.toInt())
      var read = 0
      while (read < body.size) {
        val count = reader.read(body, read, body.size - read)
        if (count < 0) break
        read += count
      }
      return WhipIngestProtocol.Request(method, target, contentType, contentLength, String(body, 0, read))
    }

    /** Convenience for tests and teardown paths that must not outlive the tombstone. */
    fun awaitTombstone() = TimeUnit.MILLISECONDS.sleep(TOMBSTONE_MS + 250)
  }
}
