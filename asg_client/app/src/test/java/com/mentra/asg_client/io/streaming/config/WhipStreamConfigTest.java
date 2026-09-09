package com.mentra.asg_client.io.streaming.config;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONException;
import org.json.JSONObject;
import org.junit.Test;

public class WhipStreamConfigTest {

    @Test
    public void fromJson_null_null_returnsDefaults() {
        WhipStreamConfig c = WhipStreamConfig.fromJson(null, null);
        assertEquals(1280, c.getVideoWidth());
        assertEquals(720, c.getVideoHeight());
        assertEquals(2_500_000, c.getVideoBitrate());
        assertEquals(15, c.getVideoFps());
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

        WhipStreamConfig c = WhipStreamConfig.fromJson(v, null);
        assertEquals(1920, c.getVideoWidth());
        assertEquals(1080, c.getVideoHeight());
        assertEquals(8_000_000, c.getVideoBitrate());
        assertEquals(30, c.getVideoFps());
    }

    @Test
    public void fromJson_honorsCompactKeys() throws JSONException {
        JSONObject v = new JSONObject();
        v.put("w", 640);
        v.put("h", 360);
        v.put("br", 500_000);
        v.put("fr", 24);

        WhipStreamConfig c = WhipStreamConfig.fromJson(v, null);
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

        WhipStreamConfig c1 = WhipStreamConfig.fromJson(vFps, null);
        assertEquals(20, c1.getVideoFps());

        JSONObject vF = new JSONObject();
        vF.put("w", 640);
        vF.put("h", 360);
        vF.put("br", 750_000);
        vF.put("f", 10);

        WhipStreamConfig c2 = WhipStreamConfig.fromJson(vF, null);
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

        WhipStreamConfig c = WhipStreamConfig.fromJson(v, null);
        assertEquals(1280, c.getVideoWidth());
        assertEquals(720, c.getVideoHeight());
        assertEquals(2_500_000, c.getVideoBitrate());
        assertEquals(15, c.getVideoFps());
    }

    @Test
    public void fromJson_clampsAndSnapsOddDimensions() throws JSONException {
        JSONObject v = new JSONObject();
        v.put("width", 641);
        v.put("height", 361);
        v.put("bitrate", 50_000_000);
        v.put("frameRate", 120);

        WhipStreamConfig c = WhipStreamConfig.fromJson(v, null);
        assertEquals(640, c.getVideoWidth());
        assertEquals(360, c.getVideoHeight());
        assertEquals(10_000_000, c.getVideoBitrate());
        assertEquals(30, c.getVideoFps());
    }

    @Test
    public void audioBooleans_roundTrip_compactAndFull() throws JSONException {
        JSONObject aCompact = new JSONObject();
        aCompact.put("ec", true);
        aCompact.put("ns", false);
        WhipStreamConfig c = WhipStreamConfig.fromJson(null, aCompact);
        assertTrue(c.isEchoCancellation());
        assertFalse(c.isNoiseSuppression());

        JSONObject aFull = new JSONObject();
        aFull.put("echoCancellation", false);
        aFull.put("noiseSuppression", true);
        c = WhipStreamConfig.fromJson(null, aFull);
        assertFalse(c.isEchoCancellation());
        assertTrue(c.isNoiseSuppression());
    }

    @Test
    public void captureAudio_defaultsTrue_andParsesCompactAndFull() throws JSONException {
        WhipStreamConfig defaults = WhipStreamConfig.fromJson(null, null);
        assertTrue(defaults.isCaptureAudio());

        JSONObject compact = new JSONObject();
        compact.put("ca", false);
        WhipStreamConfig skipped = WhipStreamConfig.fromJson(null, compact);
        assertFalse(skipped.isCaptureAudio());

        JSONObject full = new JSONObject();
        full.put("captureAudio", false);
        WhipStreamConfig skippedFull = WhipStreamConfig.fromJson(null, full);
        assertFalse(skippedFull.isCaptureAudio());

        JSONObject enabled = new JSONObject();
        enabled.put("captureAudio", true);
        WhipStreamConfig on = WhipStreamConfig.fromJson(null, enabled);
        assertTrue(on.isCaptureAudio());
    }
    @Test
    public void optionalBitrates_preserveDefaultsAndParseOverrides() throws JSONException {
        WhipStreamConfig defaults = WhipStreamConfig.fromJson(null, null);
        assertNull(defaults.getVideoMinBitrateBps());
        assertNull(defaults.getVideoInitialBitrateBps());
        JSONObject video = new JSONObject()
                .put("bitrate", 500_000)
                .put("minBitrateBps", 300_000)
                .put("initialBitrateBps", 400_000);
        WhipStreamConfig config = WhipStreamConfig.fromJson(video, null);
        assertEquals(Integer.valueOf(300_000), config.getVideoMinBitrateBps());
        assertEquals(Integer.valueOf(400_000), config.getVideoInitialBitrateBps());
        config.setVideoBitrate(200_000);
        assertEquals(Integer.valueOf(200_000), config.getVideoMinBitrateBps());
        video.put("minBitrateBps", -1).put("initialBitrateBps", 0);
        config = WhipStreamConfig.fromJson(video, null);
        assertNull(config.getVideoMinBitrateBps());
        assertNull(config.getVideoInitialBitrateBps());
    }

}
