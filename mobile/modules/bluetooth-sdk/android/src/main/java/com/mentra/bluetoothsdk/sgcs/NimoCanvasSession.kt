package com.mentra.bluetoothsdk.sgcs

/** Serialized business-command state machine. An ACK means acceptance, never visible pixels. */
internal class NimoCanvasSession {
  sealed class Action {
    data class Send(val key: Int, val frame: ByteArray, val ticket: Long) : Action()
    data class Reconnect(val reason: String) : Action()
    data class Rejected(val status: Int) : Action()
  }
  private data class Flight(val key: Int, val frame: ByteArray, val ticket: Long)
  private var ready = false
  private var active = false
  private var held = false
  private var locked = false
  private var launchBlocked = false
  private var waitingReadiness = false
  private var observedNotReady = false
  private var readinessRetries = 0
  private var exitRequested = false
  private var desired: ByteArray? = null
  private var accepted: ByteArray? = null
  private var rejected: ByteArray? = null
  private var scope: String? = null
  private var forceRevision = 0L
  private var sentRevision = 0L
  private var ticket = 0L
  private var flight: Flight? = null

  fun offer(frame: ByteArray, scope: String, force: Boolean = false): List<Action> {
    require(frame.size in 3..(NimoCanvasCodec.MAX_STREAM - 8))
    if (this.scope != scope || force) forceRevision++
    this.scope = scope
    desired = frame.copyOf()
    exitRequested = false
    return pump()
  }

  /** Debug capture seam; production behavior is unchanged unless explicitly held. */
  fun hold(value: Boolean, resume: Boolean = true): List<Action> {
    held = value
    return if (!value && resume) pump() else emptyList()
  }

  fun currentScope(): String? = scope

  fun readiness(value: Boolean): List<Action> = updateReadiness(value, confirmed = false)

  /** Newly received device predicates, not a replay of cached heartbeat state.
   * The caller validates the report and discards traffic from older bearers. */
  fun confirmedReadiness(value: Boolean): List<Action> = updateReadiness(value, confirmed = true)

  private fun updateReadiness(value: Boolean, confirmed: Boolean): List<Action> {
    if (!value) readinessRetries = 0
    if (!value && flight != null) return resetLink("Readiness lost during canvas command")
    if (waitingReadiness) {
      if (!value) observedNotReady = true
      else if (!observedNotReady) {
        if (!confirmed || readinessRetries >= 3) return emptyList()
        readinessRetries++
      }
    }
    ready = value
    if (!value) { active = false; accepted = null }
    if (value) waitingReadiness = false
    return pump()
  }

  /** A new transport generation has no accepted frame. Retain only the latest desired scene. */
  fun disconnected() {
    ready = false; active = false; held = false; locked = false; launchBlocked = false
    waitingReadiness = false; observedNotReady = false
    readinessRetries = 0
    accepted = null; rejected = null; flight = null; ticket++; forceRevision++
  }

  fun exit(): List<Action> {
    desired = null; scope = null; accepted = null; rejected = null; exitRequested = true
    return pump()
  }

  /** A local gesture/native app takeover suppresses replay until the host submits another scene. */
  fun nativeApp(appId: Int, entered: Boolean): List<Action> {
    if ((appId == NimoCanvasCodec.APP_ID && !entered) || (appId != NimoCanvasCodec.APP_ID && entered)) {
      // The expected FD Exit report preserves newer host content. A different
      // native app entering is a real takeover, even while our Exit waits for ACK.
      if (flight?.key == 3) {
        active = false; accepted = null
        if (appId != NimoCanvasCodec.APP_ID && entered) {
          desired = null; rejected = null; scope = null
        }
        return emptyList()
      }
      val ambiguous = flight != null
      desired = null; accepted = null; rejected = null; active = false; exitRequested = false; scope = null
      if (ambiguous) return resetLink("Native app transition interrupted canvas command")
    }
    return emptyList()
  }

  fun acceptsResponse(key: Int, payload: ByteArray): Boolean {
    val current = flight ?: return false
    if (current.key != key || payload.isEmpty()) return false
    val status = payload[0].toInt() and 255
    val echo = if (key == 4) byteArrayOf(0, NimoCanvasCodec.APP_ID.toByte(), 0, 0, 0)
      else byteArrayOf(0, NimoCanvasCodec.APP_ID.toByte())
    if (status == 0 && !payload.contentEquals(echo)) return false
    if (status != 0 && payload.size != 1 &&
      !(payload.size == echo.size && payload.copyOfRange(1, payload.size).contentEquals(echo.copyOfRange(1, echo.size)))) return false
    return true
  }

  fun response(key: Int, payload: ByteArray): List<Action> {
    if (!acceptsResponse(key, payload)) return emptyList()
    val current = flight ?: return emptyList()
    val status = payload[0].toInt() and 255
    flight = null
    if (status != 0) {
      when (status) {
        7 -> { ready = false; waitingReadiness = true; observedNotReady = false; active = false; accepted = null }
        8 -> { locked = true; active = false; accepted = null }
        2 -> return listOf(Action.Rejected(status)) + resetLink("Canvas device timeout is ambiguous")
        else -> {
          if (key == 4) rejected = current.frame
          else {
            if (key == 1) launchBlocked = true else desired = null
            active = false; exitRequested = false
          }
        }
      }
      return listOf(Action.Rejected(status)) + pump()
    }
    when (key) {
      1 -> active = true
      4 -> { accepted = current.frame; rejected = null; readinessRetries = 0 }
      3 -> { active = false; accepted = null; exitRequested = false }
    }
    return pump()
  }

  fun timeout(expectedTicket: Long): List<Action> {
    if (flight?.ticket != expectedTicket) return emptyList()
    return resetLink("Canvas ACK timeout; reconnect before reusing a command key")
  }

  private fun resetLink(reason: String): List<Action> {
    ready = false; active = false; accepted = null; flight = null; ticket++; forceRevision++
    return listOf(Action.Reconnect(reason))
  }

  private fun pump(): List<Action> {
    if (!ready || held || locked || launchBlocked || waitingReadiness || flight != null) return emptyList()
    val next = desired
    val key = when {
      exitRequested && active -> 3
      exitRequested -> { exitRequested = false; return emptyList() }
      next == null -> return emptyList()
      !active -> 1
      next.contentEquals(rejected) -> return emptyList()
      next.contentEquals(accepted) && sentRevision == forceRevision -> return emptyList()
      else -> 4
    }
    val frame = if (key == 4) next!!.copyOf() else ByteArray(0)
    if (key == 4) sentRevision = forceRevision
    val sending = Flight(key, frame, ++ticket)
    flight = sending
    return listOf(Action.Send(key, frame.copyOf(), sending.ticket))
  }
}
