package com.mentra.asg_client.io.streaming.config;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONException;
import org.json.JSONObject;
import org.junit.Test;

public class WhipStreamConfigTest {

    @Test
    public void fromJson_null_null_returnsDefaults() {
        WhipStreamConfig c = WhipStreamConfig.fromJson(null, null);
        assertEquals(WhipStreamConfig.DEFAULT_VIDEO_WIDTH, c.getVideoWidth());
        assertEquals(WhipStreamConfig.DEFAULT_VIDEO_HEIGHT, c.getVideoHeight());
        assertEquals(WhipStreamConfig.DEFAULT_VIDEO_BITRATE, c.getVideoBitrate());
        assertEquals(WhipStreamConfig.DEFAULT_VIDEO_FPS, c.getVideoFps());
        assertFalse(c.isEchoCancellation());
        assertFalse(c.isNoiseSuppression());
    }

    @Test
    public void compactVsFull_videoParity() throws JSONException {
        JSONObject vCompact = new JSONObject();
        vCompact.put("w", 1280);
        vCompact.put("h", 720);
        vCompact.put("br", 2_500_000);
        vCompact.put("fr", 25);

        JSONObject vFull = new JSONObject();
        vFull.put("width", 1280);
        vFull.put("height", 720);
        vFull.put("bitrate", 2_500_000);
        vFull.put("frameRate", 25);

        WhipStreamConfig c1 = WhipStreamConfig.fromJson(vCompact, null);
        WhipStreamConfig c2 = WhipStreamConfig.fromJson(vFull, null);
        assertEquals(c2.getVideoWidth(), c1.getVideoWidth());
        assertEquals(c2.getVideoHeight(), c1.getVideoHeight());
        assertEquals(c2.getVideoBitrate(), c1.getVideoBitrate());
        assertEquals(c2.getVideoFps(), c1.getVideoFps());
    }

    @Test
    public void videoClamps_matchRtmpThresholds() throws JSONException {
        JSONObject low = new JSONObject();
        low.put("width", 100);
        low.put("height", 100);
        low.put("bitrate", 1);
        low.put("frameRate", 1);
        WhipStreamConfig c = WhipStreamConfig.fromJson(low, null);
        assertEquals(320, c.getVideoWidth());
        assertEquals(240, c.getVideoHeight());
        assertEquals(100_000, c.getVideoBitrate());
        assertEquals(10, c.getVideoFps());

        JSONObject high = new JSONObject();
        high.put("width", 4000);
        high.put("height", 4000);
        high.put("bitrate", 100_000_000);
        high.put("frameRate", 240);
        c = WhipStreamConfig.fromJson(high, null);
        assertEquals(1920, c.getVideoWidth());
        assertEquals(1080, c.getVideoHeight());
        assertEquals(10_000_000, c.getVideoBitrate());
        assertEquals(60, c.getVideoFps());
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
}
