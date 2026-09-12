package com.mentra.asg_client.io.streaming.telemetry;

import androidx.annotation.Nullable;
import java.util.Collection;
import java.util.Locale;
import java.util.Map;

/**
 * Send-side pipeline diagnosis for a WHIP call, derived from one WebRTC stats sweep.
 *
 * <p>The question this answers is "which stage is limiting the picture", and the reason it exists
 * is that every counter we already logged could look healthy while the wearer saw mush.
 * {@code STREAM_QUALITY} reports the <em>configured</em> resolution and the byte rate we achieved,
 * and both stay flat when libwebrtc quietly adapts 720p down to 320x180: the encoder is still
 * producing frames, they are still being sent, and the bitrate we asked for is still the bitrate we
 * asked for. The fields that expose the adaptation — {@code qualityLimitationReason} and the
 * {@code frameWidth}/{@code frameHeight} on {@code outbound-rtp} — were never read.
 *
 * <p>Parsing is separated from the WebRTC types through {@link Entry} so the derivation below is
 * unit-testable against plain maps. Nothing here allocates per frame; it runs once per sweep.
 */
public final class WhipPipelineStats {

    /** One {@code RTCStats} object, narrowed to what parsing needs. */
    public interface Entry {
        String type();

        Map<String, Object> members();
    }

    /** Cumulative WebRTC counters. Deltas are taken against the previous sweep, never absolute. */
    public static final class Sample {
        public String qualityLimitation = "";
        public double limitCpuSec = -1;
        public double limitBandwidthSec = -1;
        public double limitOtherSec = -1;

        /** Size the encoder actually produced. Differs from the source size once adaptation kicks in. */
        public int encodedWidth;

        public int encodedHeight;
        public int sourceWidth;
        public int sourceHeight;

        public double captureFps = Double.NaN;
        public double encodeFps = Double.NaN;

        public String encoderImplementation = "";
        public long framesEncoded = -1;
        public double totalEncodeTimeSec = -1;
        public long framesSent = -1;
        public long framesDropped = -1;
        public long keyFramesEncoded = -1;
        public long hugeFramesSent = -1;

        public long bytesSent = -1;
        public long packetsSent = -1;
        public long retransmittedPacketsSent = -1;
        public long nackCount = -1;
        public long pliCount = -1;
        public long firCount = -1;
        public double totalPacketSendDelaySec = -1;
        public long targetBitrateBps = -1;

        public double roundTripTimeSec = -1;
        public double jitterSec = -1;
        public double fractionLost = -1;
        public long packetsLost = -1;

        public long availableOutgoingBitrateBps = -1;

        /** Wall time this sweep covers. Rates are meaningless without it. */
        public long elapsedMs;

        public int configuredWidth;
        public int configuredHeight;
        public double configuredFps;
    }

    /**
     * Named limiting stage. Ordered by how actionable the verdict is, not by severity: a CPU-bound
     * encoder and a bandwidth-bound one need opposite fixes, so they must never collapse into one
     * "degraded" bucket.
     */
    public static final String VERDICT_OK = "OK";

    public static final String VERDICT_ENCODER_CPU = "ENCODER_CPU";
    public static final String VERDICT_NETWORK_BANDWIDTH = "NETWORK_BANDWIDTH";
    public static final String VERDICT_NETWORK_LOSS = "NETWORK_LOSS";
    public static final String VERDICT_ENCODER_SLOW = "ENCODER_SLOW";
    public static final String VERDICT_DOWNSCALED = "DOWNSCALED";
    public static final String VERDICT_CAMERA_STARVED = "CAMERA_STARVED";
    public static final String VERDICT_NO_DATA = "NO_DATA";

    /** Above this the receiver is losing enough to force repair, well before video visibly breaks. */
    public static final double LOSS_ALARM_FRACTION = 0.02;

    /** Encoding slower than this share of the frame interval cannot hold the configured rate. */
    public static final double ENCODE_BUDGET_SHARE = 0.8;

    /** Capture below this share of the configured rate starves the encoder regardless of its speed. */
    public static final double CAPTURE_STARVED_SHARE = 0.7;

    private WhipPipelineStats() {}

    /**
     * Collapses one sweep into a single named cause.
     *
     * <p>{@code qualityLimitationReason} wins whenever libwebrtc sets it, because it is the
     * encoder's own account of why it is adapting and no derived heuristic can outrank it. The
     * remaining checks exist for the case it reports {@code none} while the picture is still bad,
     * which is what a starved camera or a lossy link looks like.
     */
    public static String verdict(Sample s) {
        if (s.encodedWidth <= 0 && Double.isNaN(s.encodeFps)) {
            return VERDICT_NO_DATA;
        }
        if ("cpu".equalsIgnoreCase(s.qualityLimitation)) {
            return VERDICT_ENCODER_CPU;
        }
        if ("bandwidth".equalsIgnoreCase(s.qualityLimitation)) {
            return VERDICT_NETWORK_BANDWIDTH;
        }
        if (s.fractionLost >= LOSS_ALARM_FRACTION) {
            return VERDICT_NETWORK_LOSS;
        }
        if (isEncodeOverBudget(s)) {
            return VERDICT_ENCODER_SLOW;
        }
        if (isDownscaled(s)) {
            return VERDICT_DOWNSCALED;
        }
        if (isCaptureStarved(s)) {
            return VERDICT_CAMERA_STARVED;
        }
        return VERDICT_OK;
    }

    /**
     * Whether the encoder is emitting fewer pixels than the caller configured.
     *
     * <p>Compared against the configured size rather than the {@code media-source} size on purpose:
     * the source track is itself adapted by libwebrtc, so a downscale that both stages agree on
     * would cancel out and read as healthy.
     */
    public static boolean isDownscaled(Sample s) {
        if (s.encodedWidth <= 0 || s.encodedHeight <= 0) {
            return false;
        }
        if (s.configuredWidth <= 0 || s.configuredHeight <= 0) {
            return false;
        }
        return (long) s.encodedWidth * s.encodedHeight
                < (long) s.configuredWidth * s.configuredHeight;
    }

    /** Encoded pixels as a percentage of what was configured. 100 when not adapting. */
    public static int encodedPixelPercent(Sample s) {
        if (s.configuredWidth <= 0 || s.configuredHeight <= 0) {
            return -1;
        }
        if (s.encodedWidth <= 0 || s.encodedHeight <= 0) {
            return -1;
        }
        double configured = (double) s.configuredWidth * s.configuredHeight;
        double encoded = (double) s.encodedWidth * s.encodedHeight;
        return (int) Math.round(encoded / configured * 100.0);
    }

    /**
     * Bits spent per pixel per encoded frame, or NaN when the sweep cannot say.
     *
     * The only figure on this line that speaks to how the picture <em>looks</em> rather than how
     * much of it there is. It exists so the glasses encode and the phone's ACS re-encode can be
     * compared in the same unit: this stream is decoded and re-encoded before Teams sees it, so
     * whichever leg has the lower bpp is the one baking in the artifacts, and until both printed
     * bpp there was no way to tell which.
     *
     * <p>Uses the encoded geometry and encode rate, not the configured ones — a stream adapted down
     * to a smaller size spends its bits over fewer pixels, and scoring it against the size we asked
     * for would read as a quality gain.
     */
    public static double bitsPerPixel(Sample s) {
        long bps = bitrateBps(s.bytesSent, s.elapsedMs);
        if (bps < 0 || s.encodedWidth <= 0 || s.encodedHeight <= 0) {
            return Double.NaN;
        }
        if (Double.isNaN(s.encodeFps) || s.encodeFps <= 0) {
            return Double.NaN;
        }
        return bps / ((double) s.encodedWidth * s.encodedHeight * s.encodeFps);
    }

    /** Mean milliseconds spent in the encoder per frame this sweep, or NaN when unknown. */
    public static double encodeMsPerFrame(long framesEncodedDelta, double encodeTimeSecDelta) {
        if (framesEncodedDelta <= 0 || encodeTimeSecDelta < 0) {
            return Double.NaN;
        }
        return encodeTimeSecDelta * 1000.0 / framesEncodedDelta;
    }

    private static boolean isEncodeOverBudget(Sample s) {
        double encodeMs = encodeMsPerFrame(s.framesEncoded, s.totalEncodeTimeSec);
        if (Double.isNaN(encodeMs) || s.configuredFps <= 0) {
            return false;
        }
        double frameBudgetMs = 1000.0 / s.configuredFps;
        return encodeMs > frameBudgetMs * ENCODE_BUDGET_SHARE;
    }

    private static boolean isCaptureStarved(Sample s) {
        if (!Double.isFinite(s.captureFps) || s.configuredFps <= 0) {
            return false;
        }
        return s.captureFps < s.configuredFps * CAPTURE_STARVED_SHARE;
    }

    /**
     * One greppable line per sweep.
     *
     * <p>Deliberately flat {@code key=value} rather than prose: a soak run produces thousands of
     * these and they have to survive being cut apart by {@code rg} and pasted into a ticket.
     */
    public static String format(@Nullable String streamId, Sample s) {
        StringBuilder line = new StringBuilder(512);
        line.append("[STREAM_PIPELINE] streamId=")
                .append(streamId != null && !streamId.isEmpty() ? streamId : "-")
                .append(" verdict=")
                .append(verdict(s));

        line.append(" cfg=").append(size(s.configuredWidth, s.configuredHeight));
        line.append(" src=")
                .append(size(s.sourceWidth, s.sourceHeight))
                .append('@')
                .append(fps(s.captureFps));
        line.append(" enc=")
                .append(size(s.encodedWidth, s.encodedHeight))
                .append('@')
                .append(fps(s.encodeFps));

        int pixelPercent = encodedPixelPercent(s);
        line.append(" pixels=").append(pixelPercent < 0 ? "n/a" : pixelPercent + "%");

        line.append(" limit=")
                .append(s.qualityLimitation.isEmpty() ? "n/a" : s.qualityLimitation)
                .append("{cpu=")
                .append(seconds(s.limitCpuSec))
                .append(" bw=")
                .append(seconds(s.limitBandwidthSec))
                .append(" other=")
                .append(seconds(s.limitOtherSec))
                .append('}');

        line.append(" encImpl=")
                .append(s.encoderImplementation.isEmpty()
                        ? "n/a"
                        : s.encoderImplementation.replace(' ', '_'));
        line.append(" encMs=")
                .append(decimal(encodeMsPerFrame(s.framesEncoded, s.totalEncodeTimeSec)));
        line.append(" budgetMs=")
                .append(s.configuredFps > 0 ? decimal(1000.0 / s.configuredFps) : "n/a");

        line.append(" kbps{sent=")
                .append(kbps(bitrateBps(s.bytesSent, s.elapsedMs)))
                .append(" target=")
                .append(kbps(s.targetBitrateBps))
                .append(" avail=")
                .append(kbps(s.availableOutgoingBitrateBps))
                .append('}');

        line.append(" bpp=").append(decimal3(bitsPerPixel(s)));

        line.append(" frames{enc=")
                .append(count(s.framesEncoded))
                .append(" sent=")
                .append(count(s.framesSent))
                .append(" dropped=")
                .append(count(s.framesDropped))
                .append(" key=")
                .append(count(s.keyFramesEncoded))
                .append(" huge=")
                .append(count(s.hugeFramesSent))
                .append('}');

        line.append(" repair{rtx=")
                .append(count(s.retransmittedPacketsSent))
                .append(" nack=")
                .append(count(s.nackCount))
                .append(" pli=")
                .append(count(s.pliCount))
                .append(" fir=")
                .append(count(s.firCount))
                .append('}');

        line.append(" net{rttMs=")
                .append(millis(s.roundTripTimeSec))
                .append(" jitterMs=")
                .append(millis(s.jitterSec))
                .append(" loss=")
                .append(percent(s.fractionLost))
                .append(" lost=")
                .append(count(s.packetsLost))
                .append(" pacerMs=")
                .append(pacerMs(s))
                .append('}');

        return line.toString();
    }

    /** Mean milliseconds a packet waited in the pacer this sweep. Rises before bitrate falls. */
    public static String pacerMs(Sample s) {
        if (s.totalPacketSendDelaySec < 0 || s.packetsSent <= 0) {
            return "n/a";
        }
        return decimal(s.totalPacketSendDelaySec * 1000.0 / s.packetsSent);
    }

    public static long bitrateBps(long bytesDelta, long elapsedMs) {
        if (bytesDelta < 0 || elapsedMs <= 0) {
            return -1;
        }
        return bytesDelta * 8_000L / elapsedMs;
    }

    /**
     * Reads one sweep out of a WebRTC report.
     *
     * <p>Cumulative members are written raw; {@link #delta(Sample, Sample)} turns them into the
     * per-sweep values the line prints. Doing it in that order keeps the caller free to hold a
     * single previous sample rather than a field-per-counter.
     */
    public static Sample parse(Collection<? extends Entry> entries) {
        Sample s = new Sample();
        for (Entry entry : entries) {
            Map<String, Object> m = entry.members();
            String type = entry.type();
            if ("outbound-rtp".equals(type) && isVideo(m)) {
                readOutbound(s, m);
            } else if ("media-source".equals(type) && isVideo(m)) {
                s.sourceWidth = (int) num(m.get("width"), s.sourceWidth);
                s.sourceHeight = (int) num(m.get("height"), s.sourceHeight);
                s.captureFps = num(m.get("framesPerSecond"), s.captureFps);
            } else if ("remote-inbound-rtp".equals(type) && isVideo(m)) {
                s.roundTripTimeSec = num(m.get("roundTripTime"), s.roundTripTimeSec);
                s.jitterSec = num(m.get("jitter"), s.jitterSec);
                s.fractionLost = num(m.get("fractionLost"), s.fractionLost);
                s.packetsLost = (long) num(m.get("packetsLost"), s.packetsLost);
            } else if ("candidate-pair".equals(type) && isSelectedPair(m)) {
                s.availableOutgoingBitrateBps =
                        (long) num(m.get("availableOutgoingBitrate"), s.availableOutgoingBitrateBps);
                double pairRtt = num(m.get("currentRoundTripTime"), -1);
                if (s.roundTripTimeSec < 0 && pairRtt >= 0) {
                    s.roundTripTimeSec = pairRtt;
                }
            }
        }
        return s;
    }

    private static void readOutbound(Sample s, Map<String, Object> m) {
        s.encodedWidth = (int) num(m.get("frameWidth"), s.encodedWidth);
        s.encodedHeight = (int) num(m.get("frameHeight"), s.encodedHeight);
        s.encodeFps = num(m.get("framesPerSecond"), s.encodeFps);
        s.framesEncoded = (long) num(m.get("framesEncoded"), s.framesEncoded);
        s.framesSent = (long) num(m.get("framesSent"), s.framesSent);
        s.keyFramesEncoded = (long) num(m.get("keyFramesEncoded"), s.keyFramesEncoded);
        s.hugeFramesSent = (long) num(m.get("hugeFramesSent"), s.hugeFramesSent);
        s.totalEncodeTimeSec = num(m.get("totalEncodeTime"), s.totalEncodeTimeSec);
        s.bytesSent = (long) num(m.get("bytesSent"), s.bytesSent);
        s.packetsSent = (long) num(m.get("packetsSent"), s.packetsSent);
        s.retransmittedPacketsSent =
                (long) num(m.get("retransmittedPacketsSent"), s.retransmittedPacketsSent);
        s.nackCount = (long) num(m.get("nackCount"), s.nackCount);
        s.pliCount = (long) num(m.get("pliCount"), s.pliCount);
        s.firCount = (long) num(m.get("firCount"), s.firCount);
        s.totalPacketSendDelaySec =
                num(m.get("totalPacketSendDelay"), s.totalPacketSendDelaySec);
        s.targetBitrateBps = (long) num(m.get("targetBitrate"), s.targetBitrateBps);

        Object dropped = m.get("framesDropped");
        if (!(dropped instanceof Number)) {
            dropped = m.get("framesDiscardedOnSend");
        }
        s.framesDropped = (long) num(dropped, s.framesDropped);

        Object impl = m.get("encoderImplementation");
        if (impl != null) {
            s.encoderImplementation = String.valueOf(impl);
        }
        Object reason = m.get("qualityLimitationReason");
        if (reason != null) {
            s.qualityLimitation = String.valueOf(reason);
        }
        Object durations = m.get("qualityLimitationDurations");
        if (durations instanceof Map) {
            Map<?, ?> d = (Map<?, ?>) durations;
            s.limitCpuSec = durationSeconds(d.get("cpu"), s.limitCpuSec);
            s.limitBandwidthSec = durationSeconds(d.get("bandwidth"), s.limitBandwidthSec);
            s.limitOtherSec = durationSeconds(d.get("other"), s.limitOtherSec);
        }
    }

    /**
     * Turns two cumulative samples into the per-sweep deltas the line prints.
     *
     * <p>Absolute counters are kept for the fields that only mean something absolutely — the
     * current encoded size, the current limitation reason, the current rates — while everything
     * monotonic is differenced. A negative delta means WebRTC reset the counter under us
     * (a track rebuild), and is clamped rather than printed as a wild negative rate.
     */
    public static Sample delta(Sample current, @Nullable Sample previous) {
        if (previous == null) {
            return current;
        }
        Sample out = current;
        out.framesEncoded = diff(current.framesEncoded, previous.framesEncoded);
        out.framesSent = diff(current.framesSent, previous.framesSent);
        out.framesDropped = diff(current.framesDropped, previous.framesDropped);
        out.keyFramesEncoded = diff(current.keyFramesEncoded, previous.keyFramesEncoded);
        out.hugeFramesSent = diff(current.hugeFramesSent, previous.hugeFramesSent);
        out.bytesSent = diff(current.bytesSent, previous.bytesSent);
        out.packetsSent = diff(current.packetsSent, previous.packetsSent);
        out.retransmittedPacketsSent =
                diff(current.retransmittedPacketsSent, previous.retransmittedPacketsSent);
        out.nackCount = diff(current.nackCount, previous.nackCount);
        out.pliCount = diff(current.pliCount, previous.pliCount);
        out.firCount = diff(current.firCount, previous.firCount);
        out.packetsLost = diff(current.packetsLost, previous.packetsLost);
        out.totalEncodeTimeSec =
                diffDouble(current.totalEncodeTimeSec, previous.totalEncodeTimeSec);
        out.totalPacketSendDelaySec =
                diffDouble(current.totalPacketSendDelaySec, previous.totalPacketSendDelaySec);
        return out;
    }

    /** Snapshot of the raw cumulative values, taken before {@link #delta} mutates them. */
    public static Sample copyCumulative(Sample s) {
        Sample copy = new Sample();
        copy.framesEncoded = s.framesEncoded;
        copy.framesSent = s.framesSent;
        copy.framesDropped = s.framesDropped;
        copy.keyFramesEncoded = s.keyFramesEncoded;
        copy.hugeFramesSent = s.hugeFramesSent;
        copy.bytesSent = s.bytesSent;
        copy.packetsSent = s.packetsSent;
        copy.retransmittedPacketsSent = s.retransmittedPacketsSent;
        copy.nackCount = s.nackCount;
        copy.pliCount = s.pliCount;
        copy.firCount = s.firCount;
        copy.packetsLost = s.packetsLost;
        copy.totalEncodeTimeSec = s.totalEncodeTimeSec;
        copy.totalPacketSendDelaySec = s.totalPacketSendDelaySec;
        return copy;
    }

    private static long diff(long current, long previous) {
        if (current < 0) {
            return -1;
        }
        if (previous < 0) {
            return current;
        }
        return Math.max(0, current - previous);
    }

    private static double diffDouble(double current, double previous) {
        if (current < 0) {
            return -1;
        }
        if (previous < 0) {
            return current;
        }
        return Math.max(0, current - previous);
    }

    private static boolean isVideo(Map<String, Object> m) {
        Object kind = m.get("kind");
        if (kind == null) {
            kind = m.get("mediaType");
        }
        return kind == null || "video".equals(String.valueOf(kind));
    }

    private static boolean isSelectedPair(Map<String, Object> m) {
        Object nominated = m.get("nominated");
        Object state = m.get("state");
        boolean succeeded = state == null || "succeeded".equals(String.valueOf(state));
        boolean chosen = !(nominated instanceof Boolean) || (Boolean) nominated;
        return succeeded && chosen;
    }

    private static double durationSeconds(@Nullable Object value, double fallback) {
        return num(value, fallback);
    }

    /** WebRTC hands members back as Long, BigInteger, Double, or a numeric String. */
    private static double num(@Nullable Object value, double fallback) {
        if (value instanceof Number) {
            return ((Number) value).doubleValue();
        }
        if (value instanceof String) {
            try {
                return Double.parseDouble((String) value);
            } catch (NumberFormatException ignored) {
                return fallback;
            }
        }
        return fallback;
    }

    private static String size(int width, int height) {
        return width > 0 && height > 0 ? width + "x" + height : "n/a";
    }

    private static String fps(double value) {
        return Double.isFinite(value) && value >= 0
                ? String.format(Locale.US, "%.1f", value)
                : "n/a";
    }

    private static String decimal(double value) {
        return Double.isFinite(value) && value >= 0
                ? String.format(Locale.US, "%.1f", value)
                : "n/a";
    }

    /** Three places: bpp differences that matter to the eye show up in the third. */
    private static String decimal3(double value) {
        return Double.isFinite(value) && value >= 0
                ? String.format(Locale.US, "%.3f", value)
                : "n/a";
    }

    private static String seconds(double value) {
        return value >= 0 ? String.format(Locale.US, "%.1f", value) : "n/a";
    }

    private static String millis(double seconds) {
        return seconds >= 0 ? String.format(Locale.US, "%.1f", seconds * 1000.0) : "n/a";
    }

    private static String percent(double fraction) {
        return fraction >= 0 ? String.format(Locale.US, "%.2f%%", fraction * 100.0) : "n/a";
    }

    private static String count(long value) {
        return value < 0 ? "n/a" : Long.toString(value);
    }

    private static String kbps(long bps) {
        return bps < 0 ? "n/a" : Long.toString(bps / 1000L);
    }
}
