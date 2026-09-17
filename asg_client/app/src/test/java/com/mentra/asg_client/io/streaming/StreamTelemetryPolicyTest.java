package com.mentra.asg_client.io.streaming;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import com.mentra.asg_client.AsgConstants;
import org.json.JSONException;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

public class StreamTelemetryPolicyTest {

    @Before
    public void resetBefore() {
        StreamTelemetryPolicy.resetToDefault();
    }

    @After
    public void resetAfter() {
        StreamTelemetryPolicy.resetToDefault();
    }

    @Test
    public void defaultMatchesBuildConstant() {
        assertEquals(AsgConstants.ENABLE_PIPELINE_FPS_TELEMETRY, StreamTelemetryPolicy.isEnabled());
        assertFalse(StreamTelemetryPolicy.isEnabled());
    }

    @Test
    public void setEnabled_togglesRuntimeState() {
        StreamTelemetryPolicy.setEnabled(true);
        assertTrue(StreamTelemetryPolicy.isEnabled());
        StreamTelemetryPolicy.setEnabled(false);
        assertFalse(StreamTelemetryPolicy.isEnabled());
    }

    @Test
    public void fromStartStream_absentKey_returnsDefault() throws JSONException {
        JSONObject start = new JSONObject().put("type", "start_stream");
        assertEquals(AsgConstants.ENABLE_PIPELINE_FPS_TELEMETRY, StreamTelemetryPolicy.fromStartStream(start));
    }

    @Test
    public void fromStartStream_fullKey() throws JSONException {
        JSONObject start = new JSONObject().put("telemetry", true);
        assertTrue(StreamTelemetryPolicy.fromStartStream(start));
        start.put("telemetry", false);
        assertFalse(StreamTelemetryPolicy.fromStartStream(start));
    }

    @Test
    public void fromStartStream_compactKey() throws JSONException {
        JSONObject start = new JSONObject().put("tl", true);
        assertTrue(StreamTelemetryPolicy.fromStartStream(start));
    }

    @Test
    public void fromStartStream_fullKeyWinsOverCompact() throws JSONException {
        JSONObject start = new JSONObject().put("telemetry", false).put("tl", true);
        assertFalse(StreamTelemetryPolicy.fromStartStream(start));
    }

    @Test
    public void fromStartStream_nullPayload_returnsDefault() {
        assertEquals(AsgConstants.ENABLE_PIPELINE_FPS_TELEMETRY, StreamTelemetryPolicy.fromStartStream(null));
    }

    @Test
    public void applyStartStream_setsRuntimeState() throws JSONException {
        StreamTelemetryPolicy.applyStartStream(new JSONObject().put("telemetry", true));
        assertTrue(StreamTelemetryPolicy.isEnabled());
        // A later start without the key falls back to the default, so state never leaks.
        StreamTelemetryPolicy.applyStartStream(new JSONObject());
        assertFalse(StreamTelemetryPolicy.isEnabled());
    }
}
