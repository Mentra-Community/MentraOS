package com.mentra.bluetoothsdk.utils;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.After;
import org.junit.Test;

public class BleJsonCompactTest {

    @After
    public void tearDown() {
        BleJsonCompact.resetSession();
    }

    @Test
    public void encodeShortensKeysAndEnums() throws Exception {
        BleJsonCompact.markSessionConnected(1_700_000_000_000L);
        JSONObject input =
                new JSONObject(
                        "{"
                                + "\"type\":\"photo_status\","
                                + "\"requestId\":\"p1\","
                                + "\"status\":\"capturing\","
                                + "\"timestamp\":1700000000100,"
                                + "\"reconnecting\":false,"
                                + "\"captureMetadata\":{"
                                + "\"aeStateName\":\"SEARCHING\","
                                + "\"source\":\"button\""
                                + "}"
                                + "}");

        JSONObject compact = BleJsonCompact.encode(input);

        assertTrue(compact.has("t"));
        assertEquals("photo_status", compact.getString("t"));
        assertEquals("p1", compact.getString("r"));
        assertEquals(3, compact.getInt("s"));
        assertEquals(100L, compact.getLong("ts"));
        assertFalse(compact.has("rc"));
        assertEquals(1, compact.getJSONObject("cm").getInt("aes"));
        assertEquals(1, compact.getJSONObject("cm").getInt("src"));
    }

    @Test
    public void decodeRestoresVerboseJson() throws Exception {
        BleJsonCompact.markSessionConnected(1_700_000_000_000L);
        JSONObject compact =
                new JSONObject(
                        "{"
                                + "\"t\":\"photo_status\","
                                + "\"r\":\"p1\","
                                + "\"s\":4,"
                                + "\"ts\":42,"
                                + "\"cm\":{\"aes\":0,\"etn\":8333333}"
                                + "}");

        JSONObject restored = BleJsonCompact.decode(compact);

        assertEquals("photo_status", restored.getString("type"));
        assertEquals("p1", restored.getString("requestId"));
        assertEquals("captured", restored.getString("status"));
        assertEquals(1_700_000_000_042L, restored.getLong("timestamp"));
        assertEquals("CONVERGED", restored.getJSONObject("captureMetadata").getString("aeStateName"));
        assertEquals(8333333L, restored.getJSONObject("captureMetadata").getLong("exposureTimeNs"));
    }

    @Test
    public void resolvedConfigDiffOmitsRepeatPayload() throws Exception {
        BleJsonCompact.markSessionConnected(1_000L);
        JSONObject config = new JSONObject("{\"source\":\"sdk\",\"transferMethod\":\"auto\"}");
        JSONObject first =
                new JSONObject(
                        "{"
                                + "\"type\":\"stream_status\","
                                + "\"status\":\"streaming\","
                                + "\"timestamp\":1000,"
                                + "\"resolvedConfig\":"
                                + config
                                + "}");
        JSONObject second =
                new JSONObject(
                        "{"
                                + "\"type\":\"stream_status\","
                                + "\"status\":\"streaming\","
                                + "\"timestamp\":1200,"
                                + "\"resolvedConfig\":"
                                + config
                                + "}");

        JSONObject firstWire = BleJsonCompact.encode(first);
        JSONObject secondWire = BleJsonCompact.encode(second);

        assertTrue(firstWire.has("resolvedConfig"));
        assertFalse(secondWire.has("resolvedConfig"));
        assertEquals(
                BleJsonCompact.hashConfig(config),
                secondWire.getString(BleJsonCompact.KEY_RESOLVED_CONFIG_HASH));

        JSONObject restoredSecond = BleJsonCompact.decode(secondWire);
        assertEquals("sdk", restoredSecond.getJSONObject("resolvedConfig").getString("source"));
    }

    @Test
    public void cameraCommandsAreLeftUntouched() throws Exception {
        String camera = "{\"type\":\"take_photo\",\"requestId\":\"1\"}";
        JSONObject encoded = BleJsonCompact.encode(camera);
        assertTrue(encoded.has("type"));
        assertEquals("take_photo", encoded.getString("type"));
    }
}
