package com.mentra.framepreview

/** Where preview frames come from. `SYNTHETIC` is a diagnostics-only test pattern. */
enum class PreviewSourceKind(val wire: String) { CALL("call"), SYNTHETIC("synthetic") }

/** How far down the pipeline a frame travels. Everything except `OFF` and `RENDER` is diagnostics. */
enum class PreviewMode(val wire: String) {
  OFF("off"),

  /** Produce the source frame and stop. Separates making a picture from moving it. */
  GENERATE_ONLY("generate_only"),

  /** Pack to the wire format and drop it. Isolates the copy and scale. */
  PACK_ONLY("pack_only"),

  /** Send it; the page validates and acknowledges without drawing. */
  RECEIVE_DISCARD("receive_discard"),

  /** Send it; the page draws and then acknowledges. */
  RENDER("render"),
  ;

  val producesFrames get() = this != OFF
  val packs get() = this == PACK_ONLY || this == RECEIVE_DISCARD || this == RENDER
  val sends get() = this == RECEIVE_DISCARD || this == RENDER

  companion object {
    fun fromWire(raw: String?): PreviewMode? = entries.firstOrNull { it.wire == raw }
  }
}

/** One `configure` call, already parsed. */
data class PreviewConfig(
  val source: PreviewSourceKind = PreviewSourceKind.CALL,
  val mode: PreviewMode = PreviewMode.OFF,
  val targetWidth: Int = PreviewLimits.RELEASE.maxBox.width,
  val targetHeight: Int = PreviewLimits.RELEASE.maxBox.height,
  val maxFps: Int = PreviewLimits.RELEASE.maxFps,
  val noiseAmplitude: Int = 0,
  val consumerDelayMs: Int = 0,
) {
  companion object {
    /** Parse the JS options. Unknown values are rejected rather than silently defaulted. */
    fun fromMap(options: Map<String, Any?>): PreviewConfig {
      val source = when (val raw = options["source"]) {
        null, "call" -> PreviewSourceKind.CALL
        "synthetic" -> PreviewSourceKind.SYNTHETIC
        else -> throw IllegalArgumentException("unknown source $raw")
      }
      val mode = PreviewMode.fromWire(options["mode"] as? String ?: "off")
        ?: throw IllegalArgumentException("unknown mode ${options["mode"]}")
      @Suppress("UNCHECKED_CAST")
      val diagnostics = options["diagnostics"] as? Map<String, Any?> ?: emptyMap()
      return PreviewConfig(
        source = source,
        mode = mode,
        targetWidth = (options["targetWidth"] as? Number)?.toInt() ?: 0,
        targetHeight = (options["targetHeight"] as? Number)?.toInt() ?: 0,
        maxFps = (options["maxFps"] as? Number)?.toInt() ?: PreviewLimits.RELEASE.maxFps,
        noiseAmplitude = (diagnostics["noiseAmplitude"] as? Number)?.toInt() ?: 0,
        consumerDelayMs = (diagnostics["consumerDelayMs"] as? Number)?.toInt() ?: 0,
      )
    }
  }
}

/**
 * Ceilings native enforces even if the host asks for more. The host already quantizes to tiers;
 * these only guard against a host bug turning into a 1080p60 copy loop in a release build.
 */
data class PreviewLimits(val maxBox: PreviewSize, val maxFps: Int) {
  val maxPixels: Int get() = maxBox.width * maxBox.height

  companion object {
    /** The shipping ceiling: 640x360 at 15 fps until measurements justify more. */
    val RELEASE = PreviewLimits(PreviewSize(640, 360), 15)

    /** Stress runs deliberately go past the product ceiling. */
    val DIAGNOSTICS = PreviewLimits(PreviewSize(1920, 1080), 30)

    fun of(diagnosticsEnabled: Boolean) = if (diagnosticsEnabled) DIAGNOSTICS else RELEASE
  }
}

/** What release builds refuse unless the hidden developer setting enables diagnostics. */
object PreviewDiagnosticsPolicy {
  const val DIAGNOSTICS_DISABLED = "diagnostics_disabled"

  /** True when [config] uses anything beyond the call source rendering normally. */
  fun needsDiagnostics(config: PreviewConfig): Boolean =
    config.source == PreviewSourceKind.SYNTHETIC ||
      (config.mode != PreviewMode.OFF && config.mode != PreviewMode.RENDER) ||
      config.noiseAmplitude != 0 ||
      config.consumerDelayMs != 0

  /** Error code to reject with, or null when [config] is allowed. */
  fun check(config: PreviewConfig, diagnosticsEnabled: Boolean): String? =
    if (!diagnosticsEnabled && needsDiagnostics(config)) DIAGNOSTICS_DISABLED else null
}

/** Fault kinds for the diagnostics-only injection hooks. */
enum class PreviewFaultKind(val wire: String) {
  /** Hold every acknowledgement for `ms` before applying it: a slow consumer. */
  ACK_DELAY("ack_delay"),

  /** Ignore acknowledgements until cleared: the ack-timeout path. */
  ACK_DROP("ack_drop"),

  /** Fail the next send as if the transport had gone away. */
  TRANSPORT_CLOSE("transport_close"),

  /** Throw from the next pack on the worker. */
  PACK_THROW("pack_throw"),

  /** Throw from the next tap sink call on the decoder thread. */
  SINK_THROW("sink_throw"),

  /** Remove every armed fault. */
  CLEAR("clear"),
  ;

  companion object {
    fun fromWire(raw: String?): PreviewFaultKind? = entries.firstOrNull { it.wire == raw }
  }
}

/** Thrown by the injection hooks so a test can tell a forced failure from a real one. */
class InjectedPreviewFault(kind: PreviewFaultKind) : RuntimeException("injected ${kind.wire}")

/** Armed faults. One-shot faults disarm when they fire; the rest last until cleared. */
class PreviewFaults {
  @Volatile var ackDelayMs = 0
    private set

  @Volatile var dropAcks = false
    private set

  @Volatile private var transportClose = false

  @Volatile private var packThrow = false

  @Volatile private var sinkThrow = false

  fun arm(kind: PreviewFaultKind, ms: Int = 0) {
    when (kind) {
      PreviewFaultKind.ACK_DELAY -> ackDelayMs = ms.coerceIn(0, 10_000)
      PreviewFaultKind.ACK_DROP -> dropAcks = true
      PreviewFaultKind.TRANSPORT_CLOSE -> transportClose = true
      PreviewFaultKind.PACK_THROW -> packThrow = true
      PreviewFaultKind.SINK_THROW -> sinkThrow = true
      PreviewFaultKind.CLEAR -> clear()
    }
  }

  fun clear() {
    ackDelayMs = 0
    dropAcks = false
    transportClose = false
    packThrow = false
    sinkThrow = false
  }

  val anyArmed: Boolean get() = ackDelayMs != 0 || dropAcks || transportClose || packThrow || sinkThrow

  fun takeTransportClose(): Boolean = transportClose.also { if (it) transportClose = false }

  fun takePackThrow(): Boolean = packThrow.also { if (it) packThrow = false }

  fun takeSinkThrow(): Boolean = sinkThrow.also { if (it) sinkThrow = false }
}
