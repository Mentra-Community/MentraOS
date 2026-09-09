package com.mentra.bluetoothsdk.utils;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
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
        assertEquals(1_700_000_000_100L, compact.getLong("timestamp"));
        assertFalse(compact.has("ts"));
        assertTrue(compact.has("rc"));
        assertFalse(compact.getBoolean("rc"));
        assertEquals(1, compact.getJSONObject("cm").getInt("aes"));
        assertEquals(1, compact.getJSONObject("cm").getInt("src"));
        assertTrue(compact.toString().length() < input.toString().length());
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
    public void resolvedConfigIsAlwaysSent() throws Exception {
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
        assertTrue(secondWire.has("resolvedConfig"));
        assertFalse(secondWire.has(BleJsonCompact.KEY_RESOLVED_CONFIG_HASH));

        BleJsonCompact.markSessionConnected(9_000L);
        JSONObject restoredSecond = BleJsonCompact.decode(secondWire);
        assertEquals("sdk", restoredSecond.getJSONObject("resolvedConfig").getString("source"));
        assertEquals(1_200L, restoredSecond.getLong("timestamp"));
    }

    @Test
    public void legacyResolvedConfigHashStillDecodesWhenCached() throws Exception {
        JSONObject config = new JSONObject("{\"source\":\"sdk\",\"transferMethod\":\"auto\"}");
        JSONObject full =
                new JSONObject(
                        "{\"t\":\"stream_status\",\"s\":\"streaming\",\"resolvedConfig\":"
                                + config
                                + "}");
        BleJsonCompact.decode(full);
        JSONObject hashOnly =
                new JSONObject(
                        "{\"t\":\"stream_status\",\"s\":\"streaming\",\"rch\":\""
                                + BleJsonCompact.hashConfig(config)
                                + "\"}");

        JSONObject restored = BleJsonCompact.decode(hashOnly);

        assertEquals("sdk", restored.getJSONObject("resolvedConfig").getString("source"));
        assertFalse(restored.has(BleJsonCompact.KEY_RESOLVED_CONFIG_HASH));
    }

    @Test
    public void legacyResolvedConfigCacheMissKeepsHashForDiagnostics() throws Exception {
        JSONObject hashOnly =
                new JSONObject(
                        "{\"t\":\"stream_status\",\"s\":\"streaming\",\"rch\":\"deadbeef\"}");

        JSONObject restored = BleJsonCompact.decode(hashOnly);

        assertEquals("deadbeef", restored.getString(BleJsonCompact.KEY_RESOLVED_CONFIG_HASH));
        assertFalse(restored.has("resolvedConfig"));
    }

    @Test
    public void ambiguousNestedWireKeysFallBackToVerboseJson() throws Exception {
        JSONObject input =
                new JSONObject(
                        "{\"type\":\"stream_status\",\"payload\":{"
                                + "\"s\":\"literal\",\"kind\":0,\"source\":1}}");

        JSONObject wire = BleJsonCompact.encode(input);

        assertTrue(wire.has("type"));
        assertFalse(wire.has("t"));
        assertEquals("literal", wire.getJSONObject("payload").getString("s"));
        assertEquals(0, wire.getJSONObject("payload").getInt("kind"));
        assertEquals(1, wire.getJSONObject("payload").getInt("source"));
        JSONObject restored = BleJsonCompact.decodeIfSupported(wire);
        assertEquals("literal", restored.getJSONObject("payload").getString("s"));
        assertEquals(0, restored.getJSONObject("payload").getInt("kind"));
        assertEquals(1, restored.getJSONObject("payload").getInt("source"));
    }

    @Test
    public void numericEnumFieldsFallBackToVerboseJson() throws Exception {
        JSONObject input =
                new JSONObject(
                        "{\"type\":\"stream_status\",\"payload\":{\"kind\":0,\"source\":1}}");

        JSONObject wire = BleJsonCompact.encode(input);

        assertTrue(wire.has("type"));
        assertFalse(wire.has("t"));
        assertEquals(0, wire.getJSONObject("payload").getInt("kind"));
        assertEquals(1, wire.getJSONObject("payload").getInt("source"));
    }

    @Test
    public void absoluteTimestampSurvivesDifferentSessionEpochs() throws Exception {
        BleJsonCompact.markSessionConnected(1_000L);
        JSONObject input =
                new JSONObject(
                        "{\"type\":\"stream_status\",\"status\":\"streaming\","
                                + "\"timestamp\":1700000000123}");

        JSONObject wire = BleJsonCompact.encode(input);
        BleJsonCompact.markSessionConnected(9_000L);
        JSONObject restored = BleJsonCompact.decode(wire);

        assertEquals(1_700_000_000_123L, wire.getLong("timestamp"));
        assertFalse(wire.has("ts"));
        assertEquals(1_700_000_000_123L, restored.getLong("timestamp"));
    }

    @Test
    public void cameraCommandsAreLeftUntouched() throws Exception {
        String camera = "{\"type\":\"take_photo\",\"requestId\":\"1\"}";
        JSONObject encoded = BleJsonCompact.encode(camera);
        assertTrue(encoded.has("type"));
        assertEquals("take_photo", encoded.getString("type"));
    }

    @Test
    public void lowRoiCommandsStayExpandedOutbound() throws Exception {
        JSONObject ping = new JSONObject("{\"type\":\"ping\"}");
        JSONObject transfer = new JSONObject("{\"type\":\"transfer_complete\",\"requestId\":\"1\"}");

        assertTrue(BleJsonCompact.encode(ping).has("type"));
        assertFalse(BleJsonCompact.encode(ping).has("t"));
        assertTrue(BleJsonCompact.encode(transfer).has("type"));
    }

    @Test
    public void highRoiCommandsCompactOutbound() throws Exception {
        JSONObject photoResponse = new JSONObject("{\"type\":\"photo_response\",\"status\":\"ok\"}");
        JSONObject wifiScan = new JSONObject("{\"type\":\"wifi_scan_result\",\"networks\":[]}");

        assertEquals("photo_response", BleJsonCompact.encode(photoResponse).getString("t"));
        assertEquals("wifi_scan_result", BleJsonCompact.encode(wifiScan).getString("t"));
    }

    @Test
    public void startStreamPreservesDisabledSound() throws Exception {
        JSONObject start =
                new JSONObject(
                        "{\"type\":\"start_stream\",\"streamUrl\":\"https://example.test/whip\","
                                + "\"sound\":false}");

        JSONObject wire = BleJsonCompact.encode(start);

        assertEquals("start_stream", wire.getString("t"));
        assertTrue(wire.has("sound"));
        assertFalse(wire.getBoolean("sound"));
        assertFalse(BleJsonCompact.decode(wire).getBoolean("sound"));
    }

    @Test
    public void jsonValuesRoundTripAtEveryDepth() throws Exception {
        JSONObject status =
                new JSONObject(
                        "{\"type\":\"stream_status\",\"status\":\"stopped\","
                                + "\"streaming\":false,\"reconnecting\":false,"
                                + "\"resolvedConfig\":{\"audio\":{\"echoCancellation\":false,"
                                + "\"noiseSuppression\":false}},"
                                + "\"nullValue\":null,\"emptyObject\":{},\"emptyArray\":[]}");

        JSONObject wire = BleJsonCompact.encode(status);

        assertTrue(wire.has("streaming"));
        assertFalse(wire.getBoolean("streaming"));
        assertTrue(wire.has("rc"));
        assertFalse(wire.getBoolean("rc"));
        JSONObject wireAudio = wire.getJSONObject("resolvedConfig").getJSONObject("audio");
        assertTrue(wireAudio.has("echoCancellation"));
        assertFalse(wireAudio.getBoolean("echoCancellation"));
        assertTrue(wireAudio.has("noiseSuppression"));
        assertFalse(wireAudio.getBoolean("noiseSuppression"));
        assertTrue(wire.has("nullValue"));
        assertTrue(wire.isNull("nullValue"));
        assertEquals(0, wire.getJSONObject("emptyObject").length());
        assertEquals(0, wire.getJSONArray("emptyArray").length());

        JSONObject restored = BleJsonCompact.decode(wire);
        assertFalse(restored.getBoolean("streaming"));
        assertFalse(restored.getBoolean("reconnecting"));
        JSONObject restoredAudio =
                restored.getJSONObject("resolvedConfig").getJSONObject("audio");
        assertFalse(restoredAudio.getBoolean("echoCancellation"));
        assertFalse(restoredAudio.getBoolean("noiseSuppression"));
        assertTrue(restored.has("nullValue"));
        assertTrue(restored.isNull("nullValue"));
        assertEquals(0, restored.getJSONObject("emptyObject").length());
        assertEquals(0, restored.getJSONArray("emptyArray").length());
    }

    @Test
    public void streamTelemetryRoundTripsWithCompactKeys() throws Exception {
        JSONObject status =
                new JSONObject(
                        "{\"type\":\"stream_status\",\"status\":\"streaming\","
                                + "\"stats\":{\"bitrate\":912345,\"fps\":19.8,"
                                + "\"droppedFrames\":2,\"duration\":31,"
                                + "\"temperatureC\":54.6}}\n");

        JSONObject wire = BleJsonCompact.encode(status);
        assertEquals(912345L, wire.getJSONObject("st").getLong("br"));
        assertEquals(54.6d, wire.getJSONObject("st").getDouble("tc"), 0.001d);

        JSONObject restored = BleJsonCompact.decode(wire);
        JSONObject stats = restored.getJSONObject("stats");
        assertEquals(19.8d, stats.getDouble("fps"), 0.001d);
        assertEquals(2L, stats.getLong("droppedFrames"));
        assertEquals(31L, stats.getLong("duration"));
    }

    @Test
    public void decodeIfSupported_rejectsCompactLowRoi() throws Exception {
        JSONObject compactPing = new JSONObject("{\"t\":\"ping\"}");

        assertEquals(null, BleJsonCompact.decodeIfSupported(compactPing));
    }

    @Test
    public void decodeIfSupported_acceptsExpandedLowRoi() throws Exception {
        JSONObject expandedPing = new JSONObject("{\"type\":\"ping\"}");

        assertEquals("ping", BleJsonCompact.decodeIfSupported(expandedPing).getString("type"));
    }

    @Test
    public void decodeIfSupported_acceptsCompactChunkEnvelope() throws Exception {
        JSONObject chunk = new JSONObject("{\"t\":\"ck\",\"id\":\"1\",\"c\":0,\"n\":2,\"d\":\"x\"}");

        assertEquals("ck", BleJsonCompact.decodeIfSupported(chunk).getString("type"));
    }

    @Test
    public void captureAudioCompactsToCa() throws Exception {
        BleJsonCompact.markSessionConnected(1_700_000_000_000L);
        JSONObject input = new JSONObject("{\"type\":\"start_stream\",\"captureAudio\":false}");
        JSONObject compact = BleJsonCompact.encode(input);
        assertEquals(false, compact.getBoolean("ca"));
        assertFalse(compact.has("captureAudio"));
        JSONObject restored = BleJsonCompact.decode(compact);
        assertEquals(false, restored.getBoolean("captureAudio"));
    }
}
