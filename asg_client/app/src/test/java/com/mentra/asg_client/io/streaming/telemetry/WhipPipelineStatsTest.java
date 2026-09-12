package com.mentra.asg_client.io.streaming.telemetry;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.Test;

public class WhipPipelineStatsTest {

    private static final class FakeEntry implements WhipPipelineStats.Entry {
        private final String type;
        private final Map<String, Object> members;

        FakeEntry(String type, Map<String, Object> members) {
            this.type = type;
            this.members = members;
        }

        @Override
        public String type() {
            return type;
        }

        @Override
        public Map<String, Object> members() {
            return members;
        }
    }

    private static Map<String, Object> members(Object... pairs) {
        Map<String, Object> m = new HashMap<>();
        for (int i = 0; i + 1 < pairs.length; i += 2) {
            m.put(String.valueOf(pairs[i]), pairs[i + 1]);
        }
        return m;
    }

    private static List<WhipPipelineStats.Entry> entries(WhipPipelineStats.Entry... e) {
        List<WhipPipelineStats.Entry> list = new ArrayList<>();
        for (WhipPipelineStats.Entry entry : e) {
            list.add(entry);
        }
        return list;
    }

    private static WhipPipelineStats.Sample healthy() {
        WhipPipelineStats.Sample s = new WhipPipelineStats.Sample();
        s.configuredWidth = 1280;
        s.configuredHeight = 720;
        s.configuredFps = 15;
        s.encodedWidth = 1280;
        s.encodedHeight = 720;
        s.encodeFps = 14.9;
        s.captureFps = 15.0;
        s.qualityLimitation = "none";
        s.framesEncoded = 15;
        s.totalEncodeTimeSec = 0.15;
        s.fractionLost = 0.0;
        s.elapsedMs = 1000;
        return s;
    }

    @Test
    public void healthySweepReportsOk() {
        assertEquals(WhipPipelineStats.VERDICT_OK, WhipPipelineStats.verdict(healthy()));
    }

    /**
     * Measured glasses state: 720p at ~15 fps on ~1.9 Mbps. The phone decodes this and re-encodes
     * it for ACS, so this bpp is the artifact floor for everything Teams sees no matter what the
     * second encode spends.
     */
    @Test
    public void bitsPerPixelUsesTheEncodedGeometryAndRate() {
        WhipPipelineStats.Sample s = healthy();
        s.bytesSent = 237_500; // 1.9 Mbps over the 1000 ms sweep
        s.encodeFps = 15.0;
        // 1_900_000 / (1280*720*15)
        assertEquals(0.137, WhipPipelineStats.bitsPerPixel(s), 0.001);
    }

    /**
     * A stream adapted down spends its bits over fewer pixels. Scoring it against the size we asked
     * for would report the downscale as a quality gain, which is backwards.
     */
    @Test
    public void bitsPerPixelRisesWhenTheEncoderDropsResolution() {
        WhipPipelineStats.Sample big = healthy();
        big.bytesSent = 125_000;
        big.encodeFps = 15.0;

        WhipPipelineStats.Sample small = healthy();
        small.bytesSent = 125_000;
        small.encodeFps = 15.0;
        small.encodedWidth = 640;
        small.encodedHeight = 360;

        assertTrue(WhipPipelineStats.bitsPerPixel(small) > WhipPipelineStats.bitsPerPixel(big));
    }

    @Test
    public void bitsPerPixelIsNotANumberWithoutAGeometryOrRate() {
        WhipPipelineStats.Sample noBytes = healthy();
        noBytes.bytesSent = -1;
        assertTrue(Double.isNaN(WhipPipelineStats.bitsPerPixel(noBytes)));

        WhipPipelineStats.Sample noSize = healthy();
        noSize.bytesSent = 125_000;
        noSize.encodedWidth = 0;
        assertTrue(Double.isNaN(WhipPipelineStats.bitsPerPixel(noSize)));

        WhipPipelineStats.Sample noRate = healthy();
        noRate.bytesSent = 125_000;
        noRate.encodeFps = Double.NaN;
        assertTrue(Double.isNaN(WhipPipelineStats.bitsPerPixel(noRate)));
    }

    @Test
    public void formattedLineCarriesBitsPerPixel() {
        WhipPipelineStats.Sample s = healthy();
        s.bytesSent = 237_500;
        s.encodeFps = 15.0;
        String line = WhipPipelineStats.format("stream-9", s);
        assertTrue(line, line.contains("bpp=0.137"));
    }

    @Test
    public void formattedLinePrintsNaBppWhenTheSweepCannotSay() {
        WhipPipelineStats.Sample s = healthy();
        s.bytesSent = -1;
        assertTrue(WhipPipelineStats.format("stream-9", s).contains("bpp=n/a"));
    }

    /**
     * The encoder's own reason outranks every derived signal, including a downscale it caused.
     * Collapsing the two into one verdict would hide whether to cut resolution or cool the SoC.
     */
    @Test
    public void cpuLimitationOutranksTheDownscaleItCauses() {
        WhipPipelineStats.Sample s = healthy();
        s.qualityLimitation = "cpu";
        s.encodedWidth = 640;
        s.encodedHeight = 360;
        assertEquals(WhipPipelineStats.VERDICT_ENCODER_CPU, WhipPipelineStats.verdict(s));
    }

    @Test
    public void bandwidthLimitationIsDistinctFromCpu() {
        WhipPipelineStats.Sample s = healthy();
        s.qualityLimitation = "bandwidth";
        assertEquals(WhipPipelineStats.VERDICT_NETWORK_BANDWIDTH, WhipPipelineStats.verdict(s));
    }

    /** A downscale with no reason attached is still the thing the wearer sees. */
    @Test
    public void silentDownscaleIsReportedWhenWebrtcBlamesNothing() {
        WhipPipelineStats.Sample s = healthy();
        s.qualityLimitation = "none";
        s.encodedWidth = 640;
        s.encodedHeight = 360;
        assertTrue(WhipPipelineStats.isDownscaled(s));
        assertEquals(WhipPipelineStats.VERDICT_DOWNSCALED, WhipPipelineStats.verdict(s));
        assertEquals(25, WhipPipelineStats.encodedPixelPercent(s));
    }

    @Test
    public void encodingAtOrAboveTheConfiguredSizeIsNotADownscale() {
        WhipPipelineStats.Sample s = healthy();
        assertFalse(WhipPipelineStats.isDownscaled(s));
        assertEquals(100, WhipPipelineStats.encodedPixelPercent(s));
    }

    @Test
    public void lossAboveTheAlarmFractionIsNamedAsLoss() {
        WhipPipelineStats.Sample s = healthy();
        s.fractionLost = 0.05;
        assertEquals(WhipPipelineStats.VERDICT_NETWORK_LOSS, WhipPipelineStats.verdict(s));
    }

    /** 15 fps leaves a 66.7ms budget; 60ms of encode per frame cannot hold the rate. */
    @Test
    public void encodeSlowerThanTheFrameBudgetIsNamed() {
        WhipPipelineStats.Sample s = healthy();
        s.framesEncoded = 15;
        s.totalEncodeTimeSec = 0.9;
        assertEquals(WhipPipelineStats.VERDICT_ENCODER_SLOW, WhipPipelineStats.verdict(s));
        assertEquals(60.0, WhipPipelineStats.encodeMsPerFrame(15, 0.9), 0.01);
    }

    @Test
    public void captureBelowTheConfiguredRateStarvesTheEncoder() {
        WhipPipelineStats.Sample s = healthy();
        s.captureFps = 6.0;
        assertEquals(WhipPipelineStats.VERDICT_CAMERA_STARVED, WhipPipelineStats.verdict(s));
    }

    @Test
    public void anEmptyReportIsNoDataRatherThanHealthy() {
        WhipPipelineStats.Sample s = new WhipPipelineStats.Sample();
        assertEquals(WhipPipelineStats.VERDICT_NO_DATA, WhipPipelineStats.verdict(s));
    }

    @Test
    public void parseReadsAdaptationAndNetworkFieldsAcrossStatsTypes() {
        Map<String, Object> limits = new HashMap<>();
        limits.put("cpu", 12.5);
        limits.put("bandwidth", 0.0);
        limits.put("other", 0.0);

        WhipPipelineStats.Sample s = WhipPipelineStats.parse(entries(
                new FakeEntry("outbound-rtp", members(
                        "kind", "video",
                        "frameWidth", 640L,
                        "frameHeight", 360L,
                        "framesPerSecond", 14.0,
                        "framesEncoded", 300L,
                        "totalEncodeTime", 3.0,
                        "encoderImplementation", "OMX.qcom.video.encoder.avc",
                        "qualityLimitationReason", "cpu",
                        "qualityLimitationDurations", limits,
                        "bytesSent", 500_000L,
                        "packetsSent", 400L,
                        "nackCount", 3L,
                        "pliCount", 1L,
                        "targetBitrate", 1_200_000.0)),
                new FakeEntry("media-source", members(
                        "kind", "video",
                        "width", 1280L,
                        "height", 720L,
                        "framesPerSecond", 15.0)),
                new FakeEntry("remote-inbound-rtp", members(
                        "kind", "video",
                        "roundTripTime", 0.032,
                        "jitter", 0.012,
                        "fractionLost", 0.004,
                        "packetsLost", 7L)),
                new FakeEntry("candidate-pair", members(
                        "nominated", Boolean.TRUE,
                        "state", "succeeded",
                        "availableOutgoingBitrate", 1_900_000.0))));

        assertEquals(640, s.encodedWidth);
        assertEquals(360, s.encodedHeight);
        assertEquals(1280, s.sourceWidth);
        assertEquals(720, s.sourceHeight);
        assertEquals("cpu", s.qualityLimitation);
        assertEquals(12.5, s.limitCpuSec, 0.001);
        assertEquals("OMX.qcom.video.encoder.avc", s.encoderImplementation);
        assertEquals(300L, s.framesEncoded);
        assertEquals(1_200_000L, s.targetBitrateBps);
        assertEquals(0.032, s.roundTripTimeSec, 0.0001);
        assertEquals(7L, s.packetsLost);
        assertEquals(1_900_000L, s.availableOutgoingBitrateBps);
        assertEquals(3L, s.nackCount);
    }

    /** An unnominated pair is a candidate we are not sending on; its bitrate would mislead. */
    @Test
    public void parseIgnoresCandidatePairsThatWereNotSelected() {
        WhipPipelineStats.Sample s = WhipPipelineStats.parse(entries(
                new FakeEntry("candidate-pair", members(
                        "nominated", Boolean.FALSE,
                        "state", "failed",
                        "availableOutgoingBitrate", 9_000_000.0))));
        assertEquals(-1L, s.availableOutgoingBitrateBps);
    }

    @Test
    public void deltaDifferencesCumulativeCountersAgainstThePreviousSweep() {
        WhipPipelineStats.Sample previous = new WhipPipelineStats.Sample();
        previous.framesEncoded = 100;
        previous.bytesSent = 1_000_000;
        previous.totalEncodeTimeSec = 1.0;

        WhipPipelineStats.Sample current = new WhipPipelineStats.Sample();
        current.framesEncoded = 115;
        current.bytesSent = 1_200_000;
        current.totalEncodeTimeSec = 1.15;

        WhipPipelineStats.Sample out = WhipPipelineStats.delta(current, previous);
        assertEquals(15L, out.framesEncoded);
        assertEquals(200_000L, out.bytesSent);
        assertEquals(0.15, out.totalEncodeTimeSec, 0.0001);
    }

    /** A track rebuild resets WebRTC's counters; the sweep after it must not print a negative rate. */
    @Test
    public void deltaClampsWhenWebrtcResetsCountersUnderUs() {
        WhipPipelineStats.Sample previous = new WhipPipelineStats.Sample();
        previous.framesEncoded = 5_000;
        previous.bytesSent = 9_000_000;

        WhipPipelineStats.Sample current = new WhipPipelineStats.Sample();
        current.framesEncoded = 12;
        current.bytesSent = 40_000;

        WhipPipelineStats.Sample out = WhipPipelineStats.delta(current, previous);
        assertEquals(0L, out.framesEncoded);
        assertEquals(0L, out.bytesSent);
    }

    @Test
    public void firstSweepWithoutAPreviousSampleKeepsItsOwnValues() {
        WhipPipelineStats.Sample current = new WhipPipelineStats.Sample();
        current.framesEncoded = 15;
        assertEquals(15L, WhipPipelineStats.delta(current, null).framesEncoded);
    }

    @Test
    public void bitrateIsDerivedFromTheSweepWindowNotAFixedSecond() {
        assertEquals(1_600_000L, WhipPipelineStats.bitrateBps(200_000, 1000));
        assertEquals(800_000L, WhipPipelineStats.bitrateBps(200_000, 2000));
        assertEquals(-1L, WhipPipelineStats.bitrateBps(200_000, 0));
    }

    @Test
    public void formattedLineCarriesTheVerdictAndBothResolutions() {
        WhipPipelineStats.Sample s = healthy();
        s.qualityLimitation = "cpu";
        s.encodedWidth = 640;
        s.encodedHeight = 360;
        s.sourceWidth = 1280;
        s.sourceHeight = 720;
        s.encoderImplementation = "OMX.qcom.video.encoder.avc";
        s.limitCpuSec = 12.5;
        s.bytesSent = 200_000;
        s.roundTripTimeSec = 0.032;
        s.fractionLost = 0.004;
        s.packetsSent = 400;
        s.totalPacketSendDelaySec = 1.6;

        String line = WhipPipelineStats.format("stream-7", s);
        assertTrue(line, line.contains("[STREAM_PIPELINE]"));
        assertTrue(line, line.contains("streamId=stream-7"));
        assertTrue(line, line.contains("verdict=ENCODER_CPU"));
        assertTrue(line, line.contains("cfg=1280x720"));
        assertTrue(line, line.contains("enc=640x360@14.9"));
        assertTrue(line, line.contains("pixels=25%"));
        assertTrue(line, line.contains("limit=cpu{cpu=12.5"));
        assertTrue(line, line.contains("encImpl=OMX.qcom.video.encoder.avc"));
        assertTrue(line, line.contains("kbps{sent=1600"));
        assertTrue(line, line.contains("rttMs=32.0"));
        assertTrue(line, line.contains("loss=0.40%"));
        assertTrue(line, line.contains("pacerMs=4.0"));
    }

    /** Unknown fields print n/a; a log full of zeroes would read as a measurement. */
    @Test
    public void missingFieldsRenderAsNotAvailable() {
        String line = WhipPipelineStats.format(null, new WhipPipelineStats.Sample());
        assertTrue(line, line.contains("streamId=-"));
        assertTrue(line, line.contains("verdict=NO_DATA"));
        assertTrue(line, line.contains("enc=n/a"));
        assertTrue(line, line.contains("rttMs=n/a"));
        assertTrue(line, line.contains("encMs=n/a"));
        assertTrue(line, line.contains("pacerMs=n/a"));
    }
}
