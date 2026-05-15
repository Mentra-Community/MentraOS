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
        assertEquals(RtmpStreamConfig.DEFAULT_VIDEO_WIDTH, c.getVideoWidth());
        assertEquals(RtmpStreamConfig.DEFAULT_VIDEO_HEIGHT, c.getVideoHeight());
        assertEquals(RtmpStreamConfig.DEFAULT_VIDEO_BITRATE, c.getVideoBitrate());
        assertEquals(RtmpStreamConfig.DEFAULT_VIDEO_FPS, c.getVideoFps());
        assertEquals(RtmpStreamConfig.DEFAULT_AUDIO_BITRATE, c.getAudioBitrate());
        assertEquals(RtmpStreamConfig.DEFAULT_AUDIO_SAMPLE_RATE, c.getAudioSampleRate());
        assertFalse(c.isEchoCancellation());
        assertFalse(c.isNoiseSuppression());
    }

    @Test
    public void compactKeys_parseSameAsFullKeys() throws JSONException {
        JSONObject vCompact = new JSONObject();
        vCompact.put("w", 1280);
        vCompact.put("h", 720);
        vCompact.put("br", 2_000_000);
        vCompact.put("fr", 24);
        JSONObject aCompact = new JSONObject();
        aCompact.put("br", 96_000);
        aCompact.put("sr", 48000);
        aCompact.put("ec", true);
        aCompact.put("ns", true);

        JSONObject vFull = new JSONObject();
        vFull.put("width", 1280);
        vFull.put("height", 720);
        vFull.put("bitrate", 2_000_000);
        vFull.put("frameRate", 24);
        JSONObject aFull = new JSONObject();
        aFull.put("bitrate", 96_000);
        aFull.put("sampleRate", 48000);
        aFull.put("echoCancellation", true);
        aFull.put("noiseSuppression", true);

        RtmpStreamConfig c1 = RtmpStreamConfig.fromJson(vCompact, aCompact);
        RtmpStreamConfig c2 = RtmpStreamConfig.fromJson(vFull, aFull);
        assertEquals(c2.getVideoWidth(), c1.getVideoWidth());
        assertEquals(c2.getVideoHeight(), c1.getVideoHeight());
        assertEquals(c2.getVideoBitrate(), c1.getVideoBitrate());
        assertEquals(c2.getVideoFps(), c1.getVideoFps());
        assertEquals(c2.getAudioBitrate(), c1.getAudioBitrate());
        assertEquals(c2.getAudioSampleRate(), c1.getAudioSampleRate());
        assertEquals(c2.isEchoCancellation(), c1.isEchoCancellation());
        assertEquals(c2.isNoiseSuppression(), c1.isNoiseSuppression());
    }

    @Test
    public void videoClamps_widthAndHeight() throws JSONException {
        JSONObject low = new JSONObject();
        low.put("width", 100);
        low.put("height", 100);
        RtmpStreamConfig c = RtmpStreamConfig.fromJson(low, null);
        assertEquals(320, c.getVideoWidth());
        assertEquals(240, c.getVideoHeight());

        JSONObject high = new JSONObject();
        high.put("width", 4000);
        high.put("height", 4000);
        c = RtmpStreamConfig.fromJson(high, null);
        assertEquals(1920, c.getVideoWidth());
        assertEquals(1080, c.getVideoHeight());
    }

    @Test
    public void videoClamps_bitrateAndFrameRate() throws JSONException {
        JSONObject low = new JSONObject();
        low.put("bitrate", 1);
        low.put("frameRate", 1);
        RtmpStreamConfig c = RtmpStreamConfig.fromJson(low, null);
        assertEquals(100_000, c.getVideoBitrate());
        assertEquals(10, c.getVideoFps());

        JSONObject high = new JSONObject();
        high.put("bitrate", 100_000_000);
        high.put("frameRate", 240);
        c = RtmpStreamConfig.fromJson(high, null);
        assertEquals(10_000_000, c.getVideoBitrate());
        assertEquals(60, c.getVideoFps());
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
