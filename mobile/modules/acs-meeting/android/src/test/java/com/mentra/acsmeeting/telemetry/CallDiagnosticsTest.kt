package com.mentra.acsmeeting.telemetry

import com.mentra.glassesmedia.trace.SoftApTrace
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * These exist because the analyzer parses these exact field names. A rename here and no rename
 * there produces a comparison that silently reports nothing rather than failing, which is the one
 * outcome that wastes a device session.
 */
class CallDiagnosticsTest {

  private fun sample(
    state: String = "connected",
    sinceConnectedMs: Long = 4_000,
    wireBitrateBps: Long? = 1_800_000,
  ) = CallDiagnostics.BweSample(
    state = state,
    sinceJoinMs = 12_000,
    sinceConnectedMs = sinceConnectedMs,
    lobbyDwellMs = 7_500,
    sendQuality = "GOOD",
    wireBitrateBps = wireBitrateBps,
    wireWidth = 960,
    wireHeight = 540,
    sentFps = 14.6,
    wireFps = 14.2,
    inboundBitrateBps = 2_100_000,
    inboundFps = 15.0,
    decodedFps = 15.0,
    framesGated = 3,
    pacerDrops = 1,
    budgetBps = 2_500_000,
    rateArm = "advertise_requested",
    mediaStatsReports = 4,
    mediaStatsAttached = true,
    videoOut = "started",
    packetsPerSecond = 42.5,
    subCount = 180,
    sinkCount = 182,
  )

  private fun render(fields: Array<Pair<String, Any?>>): String =
    SoftApTrace.format("abc123", "acs_bwe_sample", 1_000, *fields)

  @Test
  fun `a sample carries the origin it was taken under`() {
    val line = render(CallDiagnostics.bweFields("joined", "call-1", sample()))

    assertTrue(line, line.contains(" origin=joined"))
    assertTrue(line, line.contains(" callId=call-1"))
  }

  /** An unstamped call still has to group somewhere, and "unknown" is a third bucket, not a guess. */
  @Test
  fun `a caller that sent no origin is recorded as unknown rather than either path`() {
    val line = render(CallDiagnostics.bweFields("", "", sample()))

    assertTrue(line, line.contains(" origin=unknown"))
    assertTrue(line, line.contains(" callId=none"))
  }

  @Test
  fun `the sample names both hops and what was asked for`() {
    val line = render(CallDiagnostics.bweFields("created", "call-2", sample()))

    for (key in listOf(
      "state=connected",
      "sinceJoinMs=12000",
      "sinceConnectedMs=4000",
      "lobbyDwellMs=7500",
      "sendQuality=GOOD",
      "wireBitrateBps=1800000",
      "sentFps=14.6",
      // Both hops on one line is what makes the comparison exact instead of aligned by timestamp.
      "inboundBitrateBps=2100000",
      "inboundFps=15.0",
      "framesGated=3",
      "pacerDrops=1",
      "budgetBps=2500000",
      "p7RateBound=advertise_requested",
      "mediaStatsReports=4",
      "mediaStatsAttached=true",
      "videoOut=started",
      "packetsPerSecond=42.5",
      "subCount=180",
      "sinkCount=182",
    )) {
      assertTrue("$key missing from $line", line.contains(" $key"))
    }
  }

  @Test
  fun `media-stats attach and report names stay stable for the analyzer`() {
    val attach = render(CallDiagnostics.mediaStatsAttachFields("created", "call-4", ok = true))
    assertTrue(attach, attach.contains(" origin=created"))
    assertTrue(attach, attach.contains(" ok=true"))
    assertTrue(attach, attach.contains(" error=none"))

    val report = render(
      CallDiagnostics.mediaStatsReportFields(
        origin = "joined",
        callId = "call-5",
        n = 3,
        videos = 1,
        audios = 1,
        wireBitrateBps = 1_320_000,
        width = 960,
        height = 540,
        fps = 15.0,
        codec = "H264 HW",
        packetCount = 800,
      ),
    )
    for (key in listOf(
      "origin=joined",
      "n=3",
      "videos=1",
      "wireBitrateBps=1320000",
      "width=960",
      "height=540",
      "fps=15.0",
      "codec=H264_HW",
      "packetCount=800",
    )) {
      assertTrue("$key missing from $report", report.contains(" $key"))
    }
  }

  /** Zero would read as "sending nothing", which is the opposite of "nobody has told us yet". */
  @Test
  fun `an unreported bitrate is negative rather than zero`() {
    val line = render(CallDiagnostics.bweFields("created", "call-3", sample(wireBitrateBps = null)))

    assertTrue(line, line.contains(" wireBitrateBps=-1"))
  }

  @Test
  fun `sampling stays dense through the settling window and relaxes after it`() {
    // Before connected: still settling, so still dense.
    assertEquals(CallDiagnostics.DENSE_INTERVAL_MS, CallDiagnostics.sampleIntervalMs(-1))
    assertEquals(CallDiagnostics.DENSE_INTERVAL_MS, CallDiagnostics.sampleIntervalMs(0))
    assertEquals(CallDiagnostics.DENSE_INTERVAL_MS, CallDiagnostics.sampleIntervalMs(CallDiagnostics.DENSE_WINDOW_MS))
    assertEquals(
      CallDiagnostics.SPARSE_INTERVAL_MS,
      CallDiagnostics.sampleIntervalMs(CallDiagnostics.DENSE_WINDOW_MS + 1),
    )
  }

  private fun health(
    sinceConnectedMs: Long,
    wireBitrateBps: Long?,
    msSinceLow: Long = -1,
    msSinceAdaptation: Long = -1,
  ) = CallDiagnostics.wireHealth(sinceConnectedMs, wireBitrateBps, msSinceLow, msSinceAdaptation)

  @Test
  fun `an established call at full rate is the only thing sampled sparsely`() {
    val settled = health(sinceConnectedMs = 200_000, wireBitrateBps = 1_300_000)

    assertEquals(CallDiagnostics.WireHealth.HEALTHY, settled)
    assertEquals(CallDiagnostics.SPARSE_INTERVAL_MS, CallDiagnostics.sampleIntervalMs(settled))
  }

  /**
   * The bug this replaced: the old cadence went sparse at 90 s and the collapse began at 150 s, so
   * the event the whole investigation was about was sampled every 10 seconds.
   */
  @Test
  fun `a collapse long after the settling window pulls the cadence back to dense`() {
    val low = health(sinceConnectedMs = 150_000, wireBitrateBps = 33_000)

    assertEquals(CallDiagnostics.WireHealth.LOW, low)
    assertEquals(CallDiagnostics.DENSE_INTERVAL_MS, CallDiagnostics.sampleIntervalMs(low))
  }

  /** The climb back was the longer half of the outage, so it is sampled at the same rate. */
  @Test
  fun `the recovery ramp stays dense while it is still degraded`() {
    val climbing = health(sinceConnectedMs = 250_000, wireBitrateBps = 700_000)

    assertEquals(CallDiagnostics.WireHealth.RECOVERING, climbing)
    assertEquals(CallDiagnostics.DENSE_INTERVAL_MS, CallDiagnostics.sampleIntervalMs(climbing))
  }

  @Test
  fun `a call that just came back is watched a while before being trusted`() {
    val justBack = health(sinceConnectedMs = 250_000, wireBitrateBps = 1_300_000, msSinceLow = 5_000)
    assertEquals(CallDiagnostics.WireHealth.RECOVERING, justBack)

    val longBack =
      health(
        sinceConnectedMs = 400_000,
        wireBitrateBps = 1_300_000,
        msSinceLow = CallDiagnostics.RECOVERY_WATCH_MS + 1,
      )
    assertEquals(CallDiagnostics.WireHealth.HEALTHY, longBack)
  }

  @Test
  fun `a recent downscale is watched even at a healthy rate`() {
    val adapted = health(sinceConnectedMs = 300_000, wireBitrateBps = 1_300_000, msSinceAdaptation = 4_000)

    assertEquals(CallDiagnostics.WireHealth.RECOVERING, adapted)
  }

  /**
   * ACS publishing an empty report is a fact about ACS, not a bitrate of zero, so it is its own
   * state — and a dense one, because the other columns (sent fps, subscriber count, glasses hop)
   * are what characterise the blindness.
   */
  @Test
  fun `a silent wire is distinguished from a low one and sampled densely`() {
    assertEquals(CallDiagnostics.WireHealth.SILENT, health(sinceConnectedMs = 300_000, wireBitrateBps = null))
    assertEquals(CallDiagnostics.WireHealth.SILENT, health(sinceConnectedMs = 300_000, wireBitrateBps = -1))
    assertEquals(
      CallDiagnostics.DENSE_INTERVAL_MS,
      CallDiagnostics.sampleIntervalMs(CallDiagnostics.WireHealth.SILENT),
    )
  }

  @Test
  fun `everything inside the settling window is settling whatever the rate`() {
    assertEquals(CallDiagnostics.WireHealth.SETTLING, health(sinceConnectedMs = -1, wireBitrateBps = null))
    assertEquals(CallDiagnostics.WireHealth.SETTLING, health(sinceConnectedMs = 10_000, wireBitrateBps = 33_000))
  }

  @Test
  fun `a downscale names what was asked for as well as what arrived`() {
    val line = SoftApTrace.format(
      "abc123",
      "acs_wire_adaptation",
      2_000,
      *CallDiagnostics.wireAdaptationFields(
        origin = "joined",
        callId = "call-6",
        width = 320,
        height = 180,
        direction = "down",
        sinceConnectedMs = 150_000,
        askedWidth = 960,
        askedHeight = 540,
        wireBitrateBps = 33_000,
        ceilingBps = 3_000_000,
        fps = 14.4,
      ),
    )

    for (key in listOf(
      "origin=joined",
      "width=320",
      "height=180",
      "direction=down",
      "sinceConnectedMs=150000",
      "asked=960x540",
      // 11% of what was negotiated. The percentage is the part that reads as a fault rather than
      // as a number, which is why it is computed here instead of left to the reader.
      "percentOfAsked=11",
      "wireBitrateBps=33000",
      "ceilingBps=3000000",
    )) {
      assertTrue("$key missing from $line", line.contains(" $key"))
    }
  }

  @Test
  fun `an episode carries its floor, its cost and the hop that stayed healthy`() {
    val line = SoftApTrace.format(
      "abc123",
      "acs_wire_episode",
      3_000,
      *CallDiagnostics.episodeFields(
        origin = "joined",
        callId = "call-7",
        episode = "recovered",
        startedAtMs = 150_000,
        durationMs = 90_000,
        minBitrateBps = 33_000,
        minResolution = "320x180",
        recoveryMs = 170_000,
        inboundBitrateBps = 2_100_000.0,
        sentFps = 14.5,
        ceilingBps = 3_000_000,
      ),
    )

    for (key in listOf(
      "episode=recovered",
      "startedAtMs=150000",
      "durationMs=90000",
      "minBitrateBps=33000",
      "minResolution=320x180",
      "recoveryMs=170000",
      "inboundBitrateBps=2100000.0",
      "sentFps=14.5",
      "ceilingBps=3000000",
    )) {
      assertTrue("$key missing from $line", line.contains(" $key"))
    }
  }

  /** "Not back yet" and "back instantly" differ by 170 seconds on the capture that started this. */
  @Test
  fun `an unrecovered episode reports negative rather than zero recovery`() {
    val line = SoftApTrace.format(
      "abc123",
      "acs_wire_episode",
      3_000,
      *CallDiagnostics.episodeFields(
        origin = "created",
        callId = "call-8",
        episode = "begin",
        startedAtMs = 150_000,
        durationMs = 0,
        minBitrateBps = 33_000,
        minResolution = "",
        recoveryMs = -1,
        inboundBitrateBps = null,
        sentFps = 15.0,
        ceilingBps = 1_500_000,
      ),
    )

    assertTrue(line, line.contains(" recoveryMs=-1"))
    assertTrue(line, line.contains(" inboundBitrateBps=na"))
    assertTrue(line, line.contains(" minResolution=na"))
  }
}
