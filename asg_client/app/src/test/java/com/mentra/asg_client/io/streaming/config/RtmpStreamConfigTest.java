package com.mentra.asg_client.io.streaming.config;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONException;
import org.json.JSONObject;
import org.junit.Test;

public class RtmpStreamConfigTest {

    @Test
    public void fromJson_null_null_returnsDefaults() {
        RtmpStreamConfig c = RtmpStreamConfig.fromJson(null, null);
        assertEquals(1920, c.getVideoWidth());
        assertEquals(1080, c.getVideoHeight());
        assertEquals(4_500_000, c.getVideoBitrate());
        assertEquals(24, c.getVideoFps());
        assertEquals(RtmpStreamConfig.DEFAULT_AUDIO_BITRATE, c.getAudioBitrate());
        assertEquals(RtmpStreamConfig.DEFAULT_AUDIO_SAMPLE_RATE, c.getAudioSampleRate());
        assertFalse(c.isEchoCancellation());
        assertFalse(c.isNoiseSuppression());
    }

    @Test
    public void fromJson_ignoresCallerVideoOverrides_forces1080p24() throws JSONException {
        JSONObject vCompact = new JSONObject();
        vCompact.put("w", 640);
        vCompact.put("h", 360);
        vCompact.put("br", 500_000);
        vCompact.put("fr", 15);
        JSONObject aCompact = new JSONObject();
        aCompact.put("br", 96_000);
        aCompact.put("sr", 48000);
        aCompact.put("ec", true);
        aCompact.put("ns", true);

        JSONObject vFull = new JSONObject();
        vFull.put("width", 1920);
        vFull.put("height", 1080);
        vFull.put("bitrate", 8_000_000);
        vFull.put("frameRate", 30);
        JSONObject aFull = new JSONObject();
        aFull.put("bitrate", 96_000);
        aFull.put("sampleRate", 48000);
        aFull.put("echoCancellation", true);
        aFull.put("noiseSuppression", true);

        RtmpStreamConfig c1 = RtmpStreamConfig.fromJson(vCompact, aCompact);
        RtmpStreamConfig c2 = RtmpStreamConfig.fromJson(vFull, aFull);

        assertEquals(1920, c1.getVideoWidth());
        assertEquals(1080, c1.getVideoHeight());
        assertEquals(4_500_000, c1.getVideoBitrate());
        assertEquals(24, c1.getVideoFps());
        assertEquals(1920, c2.getVideoWidth());
        assertEquals(1080, c2.getVideoHeight());
        assertEquals(4_500_000, c2.getVideoBitrate());
        assertEquals(24, c2.getVideoFps());

        // Audio still follows caller config.
        assertEquals(96_000, c1.getAudioBitrate());
        assertEquals(48000, c1.getAudioSampleRate());
        assertTrue(c1.isEchoCancellation());
        assertTrue(c1.isNoiseSuppression());
        assertEquals(c2.getAudioBitrate(), c1.getAudioBitrate());
    }

    @Test
    public void setCaptureSize_regressionAndFallback() {
        RtmpStreamConfig c = new RtmpStreamConfig().setVideoWidth(1280).setVideoHeight(720);

        c.setCaptureSize(0, 720);
        assertEquals(1280, c.getCaptureSurfaceWidth());
        assertEquals(720, c.getCaptureSurfaceHeight());

        c.setCaptureSize(4608, 2592);
        assertEquals(4608, c.getCaptureSurfaceWidth());
        assertEquals(2592, c.getCaptureSurfaceHeight());

        c.setCaptureSize(1920, 1080);
        assertEquals(1920, c.getCaptureSurfaceWidth());
        c.setCaptureSize(-1, 0);
        assertEquals(1280, c.getCaptureSurfaceWidth());
        assertEquals(720, c.getCaptureSurfaceHeight());
    }

    @Test
    public void setCaptureSize_zeroHeightClearsCapture() {
        RtmpStreamConfig c = new RtmpStreamConfig().setVideoWidth(854).setVideoHeight(480);
        c.setCaptureSize(1280, 0);
        assertEquals(854, c.getCaptureSurfaceWidth());
        assertEquals(480, c.getCaptureSurfaceHeight());
    }

    @Test
    public void toString_includesCaptureOnlyWhenSet() {
        RtmpStreamConfig c = new RtmpStreamConfig();
        assertFalse(c.toString().contains("capture="));

        c.setCaptureSize(1920, 1080);
        assertTrue(c.toString().contains("capture=1920x1080"));
    }
}
