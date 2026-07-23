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
        assertEquals(1280, c.getVideoWidth());
        assertEquals(720, c.getVideoHeight());
        assertEquals(2_500_000, c.getVideoBitrate());
        assertEquals(24, c.getVideoFps());
        assertFalse(c.isEchoCancellation());
        assertFalse(c.isNoiseSuppression());
    }

    @Test
    public void fromJson_ignoresCallerVideoOverrides_forces720p24() throws JSONException {
        JSONObject vCompact = new JSONObject();
        vCompact.put("w", 640);
        vCompact.put("h", 360);
        vCompact.put("br", 500_000);
        vCompact.put("fr", 15);

        JSONObject vFull = new JSONObject();
        vFull.put("width", 1920);
        vFull.put("height", 1080);
        vFull.put("bitrate", 8_000_000);
        vFull.put("frameRate", 30);

        WhipStreamConfig c1 = WhipStreamConfig.fromJson(vCompact, null);
        WhipStreamConfig c2 = WhipStreamConfig.fromJson(vFull, null);
        assertEquals(1280, c1.getVideoWidth());
        assertEquals(720, c1.getVideoHeight());
        assertEquals(2_500_000, c1.getVideoBitrate());
        assertEquals(24, c1.getVideoFps());
        assertEquals(c2.getVideoWidth(), c1.getVideoWidth());
        assertEquals(c2.getVideoHeight(), c1.getVideoHeight());
        assertEquals(c2.getVideoBitrate(), c1.getVideoBitrate());
        assertEquals(c2.getVideoFps(), c1.getVideoFps());
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
