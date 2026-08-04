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
        assertEquals(1280, c.getVideoWidth());
        assertEquals(720, c.getVideoHeight());
        assertEquals(2_500_000, c.getVideoBitrate());
        assertEquals(15, c.getVideoFps());
        assertEquals(RtmpStreamConfig.DEFAULT_AUDIO_BITRATE, c.getAudioBitrate());
        assertEquals(RtmpStreamConfig.DEFAULT_AUDIO_SAMPLE_RATE, c.getAudioSampleRate());
        assertFalse(c.isEchoCancellation());
        assertFalse(c.isNoiseSuppression());
    }

    @Test
    public void fromJson_honorsFullKeys() throws JSONException {
        JSONObject v = new JSONObject();
        v.put("width", 1920);
        v.put("height", 1080);
        v.put("bitrate", 8_000_000);
        v.put("frameRate", 30);
        JSONObject a = new JSONObject();
        a.put("bitrate", 96_000);
        a.put("sampleRate", 48000);
        a.put("echoCancellation", true);
        a.put("noiseSuppression", true);

        RtmpStreamConfig c = RtmpStreamConfig.fromJson(v, a);
        assertEquals(1920, c.getVideoWidth());
        assertEquals(1080, c.getVideoHeight());
        assertEquals(8_000_000, c.getVideoBitrate());
        assertEquals(30, c.getVideoFps());
        assertEquals(96_000, c.getAudioBitrate());
        assertEquals(48000, c.getAudioSampleRate());
        assertTrue(c.isEchoCancellation());
        assertTrue(c.isNoiseSuppression());
    }

    @Test
    public void fromJson_honorsCompactKeys() throws JSONException {
        JSONObject v = new JSONObject();
        v.put("w", 640);
        v.put("h", 360);
        v.put("br", 500_000);
        v.put("fr", 24);

        RtmpStreamConfig c = RtmpStreamConfig.fromJson(v, null);
        assertEquals(640, c.getVideoWidth());
        assertEquals(360, c.getVideoHeight());
        assertEquals(500_000, c.getVideoBitrate());
        assertEquals(24, c.getVideoFps());
    }

    @Test
    public void fromJson_honorsFpsAndFKeys() throws JSONException {
        JSONObject vFps = new JSONObject();
        vFps.put("width", 854);
        vFps.put("height", 480);
        vFps.put("bitrate", 1_000_000);
        vFps.put("fps", 20);

        RtmpStreamConfig c1 = RtmpStreamConfig.fromJson(vFps, null);
        assertEquals(854, c1.getVideoWidth());
        assertEquals(480, c1.getVideoHeight());
        assertEquals(20, c1.getVideoFps());

        JSONObject vF = new JSONObject();
        vF.put("w", 640);
        vF.put("h", 360);
        vF.put("br", 750_000);
        vF.put("f", 10);

        RtmpStreamConfig c2 = RtmpStreamConfig.fromJson(vF, null);
        assertEquals(10, c2.getVideoFps());
    }

    @Test
    public void fromJson_fullKeyWinsOverCompact() throws JSONException {
        JSONObject v = new JSONObject();
        v.put("width", 1280);
        v.put("w", 640);
        v.put("height", 720);
        v.put("h", 360);
        v.put("bitrate", 2_500_000);
        v.put("br", 500_000);
        v.put("frameRate", 15);
        v.put("fr", 30);
        v.put("fps", 24);

        RtmpStreamConfig c = RtmpStreamConfig.fromJson(v, null);
        assertEquals(1280, c.getVideoWidth());
        assertEquals(720, c.getVideoHeight());
        assertEquals(2_500_000, c.getVideoBitrate());
        assertEquals(15, c.getVideoFps()); // frameRate wins over fr/fps
    }

    @Test
    public void fromJson_clampsOversizedAndUndersized() throws JSONException {
        JSONObject oversized = new JSONObject();
        oversized.put("width", 4000);
        oversized.put("height", 3000);
        oversized.put("bitrate", 50_000_000);
        oversized.put("frameRate", 120);

        RtmpStreamConfig c1 = RtmpStreamConfig.fromJson(oversized, null);
        assertEquals(1920, c1.getVideoWidth());
        assertEquals(1080, c1.getVideoHeight());
        assertEquals(10_000_000, c1.getVideoBitrate());
        assertEquals(30, c1.getVideoFps());

        JSONObject undersized = new JSONObject();
        undersized.put("width", 10);
        undersized.put("height", 10);
        undersized.put("bitrate", 1);
        undersized.put("frameRate", 1);

        RtmpStreamConfig c2 = RtmpStreamConfig.fromJson(undersized, null);
        assertEquals(320, c2.getVideoWidth());
        assertEquals(240, c2.getVideoHeight());
        assertEquals(100_000, c2.getVideoBitrate());
        assertEquals(5, c2.getVideoFps());
    }

    @Test
    public void fromJson_snapsOddDimensionsToEven() throws JSONException {
        JSONObject v = new JSONObject();
        v.put("width", 641);
        v.put("height", 361);
        v.put("bitrate", 750_000);
        v.put("frameRate", 15);

        RtmpStreamConfig c = RtmpStreamConfig.fromJson(v, null);
        assertEquals(640, c.getVideoWidth());
        assertEquals(360, c.getVideoHeight());
    }

    @Test
    public void fromJson_malformedFieldFallsBackToDefault() throws JSONException {
        JSONObject v = new JSONObject();
        v.put("width", "not-a-number");
        v.put("height", 720);
        v.put("bitrate", 2_500_000);
        v.put("frameRate", 15);

        RtmpStreamConfig c = RtmpStreamConfig.fromJson(v, null);
        // optInt(name, fallback) returns the fallback when the value is non-numeric.
        assertEquals(RtmpStreamConfig.DEFAULT_VIDEO_WIDTH, c.getVideoWidth());
        assertEquals(720, c.getVideoHeight());
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
