package com.mentra.asg_client.io.bluetooth.utils;

import static org.assertj.core.api.Assertions.assertThat;

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
                                + "\"aeStateName\":\"CONVERGED\","
                                + "\"manual\":false"
                                + "}"
                                + "}");

        JSONObject compact = BleJsonCompact.encode(input);

        assertThat(compact.has("t")).isTrue();
        assertThat(compact.getString("t")).isEqualTo("photo_status");
        assertThat(compact.getString("r")).isEqualTo("p1");
        assertThat(compact.getInt("s")).isEqualTo(3);
        assertThat(compact.getLong("timestamp")).isEqualTo(1_700_000_000_100L);
        assertThat(compact.has("ts")).isFalse();
        assertThat(compact.has("rc")).isTrue();
        assertThat(compact.getBoolean("rc")).isFalse();
        assertThat(compact.getJSONObject("cm").getInt("aes")).isEqualTo(0);
        assertThat(compact.getJSONObject("cm").has("m")).isTrue();
        assertThat(compact.getJSONObject("cm").getBoolean("m")).isFalse();
        assertThat(compact.toString().length()).isLessThan(input.toString().length());
    }

    @Test
    public void decodeRestoresVerboseJson() throws Exception {
        BleJsonCompact.markSessionConnected(1_700_000_000_000L);
        JSONObject compact =
                new JSONObject(
                        "{"
                                + "\"t\":\"stream_status\","
                                + "\"k\":0,"
                                + "\"s\":\"streaming\","
                                + "\"ts\":250"
                                + "}");

        JSONObject restored = BleJsonCompact.decode(compact);

        assertThat(restored.getString("type")).isEqualTo("stream_status");
        assertThat(restored.getString("kind")).isEqualTo("lifecycle");
        assertThat(restored.getString("status")).isEqualTo("streaming");
        assertThat(restored.getLong("timestamp")).isEqualTo(1_700_000_000_250L);
    }

    @Test
    public void resolvedConfigIsAlwaysSent() throws Exception {
        BleJsonCompact.markSessionConnected(1_000L);
        JSONObject config = new JSONObject("{\"source\":\"sdk\",\"manual\":false}");
        JSONObject first =
                new JSONObject(
                        "{"
                                + "\"type\":\"photo_status\","
                                + "\"status\":\"configuring\","
                                + "\"timestamp\":1000,"
                                + "\"resolvedConfig\":"
                                + config
                                + "}");
        JSONObject second =
                new JSONObject(
                        "{"
                                + "\"type\":\"photo_status\","
                                + "\"status\":\"configuring\","
                                + "\"timestamp\":1100,"
                                + "\"resolvedConfig\":"
                                + config
                                + "}");

        JSONObject firstWire = BleJsonCompact.encode(first);
        JSONObject secondWire = BleJsonCompact.encode(second);

        assertThat(firstWire.has("resolvedConfig")).isTrue();
        assertThat(secondWire.has("resolvedConfig")).isTrue();
        assertThat(secondWire.has(BleJsonCompact.KEY_RESOLVED_CONFIG_HASH)).isFalse();

        BleJsonCompact.markSessionConnected(9_000L);
        JSONObject restoredSecond = BleJsonCompact.decode(secondWire);
        assertThat(restoredSecond.getJSONObject("resolvedConfig").getString("source"))
                .isEqualTo("sdk");
        assertThat(restoredSecond.getLong("timestamp")).isEqualTo(1_100L);
    }

    @Test
    public void legacyResolvedConfigHashStillDecodesWhenCached() throws Exception {
        JSONObject config = new JSONObject("{\"source\":\"sdk\",\"manual\":false}");
        JSONObject full =
                new JSONObject(
                        "{\"t\":\"photo_status\",\"s\":2,\"resolvedConfig\":"
                                + config
                                + "}");
        BleJsonCompact.decode(full);
        JSONObject hashOnly =
                new JSONObject(
                        "{\"t\":\"photo_status\",\"s\":2,\"rch\":\""
                                + BleJsonCompact.hashConfig(config)
                                + "\"}");

        JSONObject restored = BleJsonCompact.decode(hashOnly);

        assertThat(restored.getJSONObject("resolvedConfig").getString("source"))
                .isEqualTo("sdk");
        assertThat(restored.has(BleJsonCompact.KEY_RESOLVED_CONFIG_HASH)).isFalse();
    }

    @Test
    public void legacyResolvedConfigCacheMissKeepsHashForDiagnostics() throws Exception {
        JSONObject hashOnly =
                new JSONObject(
                        "{\"t\":\"stream_status\",\"s\":\"streaming\",\"rch\":\"deadbeef\"}");

        JSONObject restored = BleJsonCompact.decode(hashOnly);

        assertThat(restored.getString(BleJsonCompact.KEY_RESOLVED_CONFIG_HASH))
                .isEqualTo("deadbeef");
        assertThat(restored.has("resolvedConfig")).isFalse();
    }

    @Test
    public void ambiguousNestedWireKeysFallBackToVerboseJson() throws Exception {
        JSONObject input =
                new JSONObject(
                        "{\"type\":\"stream_status\",\"payload\":{"
                                + "\"s\":\"literal\",\"kind\":0,\"source\":1}}");

        JSONObject wire = BleJsonCompact.encode(input);

        assertThat(wire.has("type")).isTrue();
        assertThat(wire.has("t")).isFalse();
        assertThat(wire.getJSONObject("payload").getString("s")).isEqualTo("literal");
        assertThat(wire.getJSONObject("payload").getInt("kind")).isZero();
        assertThat(wire.getJSONObject("payload").getInt("source")).isEqualTo(1);
        JSONObject restored = BleJsonCompact.decodeIfSupported(wire);
        assertThat(restored.getJSONObject("payload").getString("s")).isEqualTo("literal");
        assertThat(restored.getJSONObject("payload").getInt("kind")).isZero();
        assertThat(restored.getJSONObject("payload").getInt("source")).isEqualTo(1);
    }

    @Test
    public void numericEnumFieldsFallBackToVerboseJson() throws Exception {
        JSONObject input =
                new JSONObject(
                        "{\"type\":\"stream_status\",\"payload\":{\"kind\":0,\"source\":1}}");

        JSONObject wire = BleJsonCompact.encode(input);

        assertThat(wire.has("type")).isTrue();
        assertThat(wire.has("t")).isFalse();
        assertThat(wire.getJSONObject("payload").getInt("kind")).isZero();
        assertThat(wire.getJSONObject("payload").getInt("source")).isEqualTo(1);
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

        assertThat(wire.getLong("timestamp")).isEqualTo(1_700_000_000_123L);
        assertThat(wire.has("ts")).isFalse();
        assertThat(restored.getLong("timestamp")).isEqualTo(1_700_000_000_123L);
    }

    @Test
    public void cameraCommandsAreLeftUntouched() throws Exception {
        String camera = "{\"C\":\"cs_pho\",\"V\":1,\"B\":{}}";
        JSONObject encoded = BleJsonCompact.encode(camera);
        assertThat(encoded.toString()).contains("cs_pho");
    }

    @Test
    public void lowRoiCommandsStayExpandedOutbound() throws Exception {
        JSONObject ping = new JSONObject("{\"type\":\"ping\"}");
        JSONObject ack = new JSONObject("{\"type\":\"msg_ack\",\"requestId\":\"1\"}");
        JSONObject gallery = new JSONObject("{\"type\":\"gallery_status\",\"status\":\"ready\"}");

        assertThat(BleJsonCompact.encode(ping).has("type")).isTrue();
        assertThat(BleJsonCompact.encode(ping).has("t")).isFalse();
        assertThat(BleJsonCompact.encode(ack).has("type")).isTrue();
        assertThat(BleJsonCompact.encode(gallery).has("type")).isTrue();
    }

    @Test
    public void highRoiCommandsCompactOutbound() throws Exception {
        JSONObject photoStatus = new JSONObject("{\"type\":\"photo_status\",\"status\":\"capturing\"}");
        JSONObject streamStatus = new JSONObject("{\"type\":\"stream_status\",\"status\":\"streaming\"}");

        assertThat(BleJsonCompact.encode(photoStatus).getString("t")).isEqualTo("photo_status");
        assertThat(BleJsonCompact.encode(streamStatus).getString("t")).isEqualTo("stream_status");
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

        assertThat(wire.has("streaming")).isTrue();
        assertThat(wire.getBoolean("streaming")).isFalse();
        assertThat(wire.has("rc")).isTrue();
        assertThat(wire.getBoolean("rc")).isFalse();
        JSONObject wireAudio = wire.getJSONObject("resolvedConfig").getJSONObject("audio");
        assertThat(wireAudio.has("echoCancellation")).isTrue();
        assertThat(wireAudio.getBoolean("echoCancellation")).isFalse();
        assertThat(wireAudio.has("noiseSuppression")).isTrue();
        assertThat(wireAudio.getBoolean("noiseSuppression")).isFalse();
        assertThat(wire.has("nullValue")).isTrue();
        assertThat(wire.isNull("nullValue")).isTrue();
        assertThat(wire.getJSONObject("emptyObject").length()).isZero();
        assertThat(wire.getJSONArray("emptyArray").length()).isZero();

        JSONObject restored = BleJsonCompact.decode(wire);
        assertThat(restored.getBoolean("streaming")).isFalse();
        assertThat(restored.getBoolean("reconnecting")).isFalse();
        JSONObject restoredAudio =
                restored.getJSONObject("resolvedConfig").getJSONObject("audio");
        assertThat(restoredAudio.getBoolean("echoCancellation")).isFalse();
        assertThat(restoredAudio.getBoolean("noiseSuppression")).isFalse();
        assertThat(restored.has("nullValue")).isTrue();
        assertThat(restored.isNull("nullValue")).isTrue();
        assertThat(restored.getJSONObject("emptyObject").length()).isZero();
        assertThat(restored.getJSONArray("emptyArray").length()).isZero();
    }

    @Test
    public void wifiScanPreservesIncompleteMarker() throws Exception {
        JSONObject result =
                new JSONObject(
                        "{\"type\":\"wifi_scan_result\",\"networks\":[\"one\"],"
                                + "\"scan_complete\":false}");

        JSONObject wire = BleJsonCompact.encode(result);

        assertThat(wire.has("scan_complete")).isTrue();
        assertThat(wire.getBoolean("scan_complete")).isFalse();
        assertThat(BleJsonCompact.decode(wire).getBoolean("scan_complete")).isFalse();
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
        assertThat(wire.getJSONObject("st").getLong("br")).isEqualTo(912345L);
        assertThat(wire.getJSONObject("st").getDouble("tc")).isEqualTo(54.6d);

        JSONObject restored = BleJsonCompact.decode(wire);
        JSONObject stats = restored.getJSONObject("stats");
        assertThat(stats.getDouble("fps")).isEqualTo(19.8d);
        assertThat(stats.getLong("droppedFrames")).isEqualTo(2L);
        assertThat(stats.getLong("duration")).isEqualTo(31L);
    }

    @Test
    public void decodeIfSupported_rejectsCompactLowRoi() throws Exception {
        JSONObject compactPing = new JSONObject("{\"t\":\"ping\"}");

        assertThat(BleJsonCompact.decodeIfSupported(compactPing)).isNull();
    }

    @Test
    public void decodeIfSupported_acceptsExpandedLowRoi() throws Exception {
        JSONObject expandedPing = new JSONObject("{\"type\":\"ping\"}");

        assertThat(BleJsonCompact.decodeIfSupported(expandedPing).getString("type"))
                .isEqualTo("ping");
    }

    @Test
    public void decodeIfSupported_acceptsCompactChunkEnvelope() throws Exception {
        JSONObject chunk = new JSONObject("{\"t\":\"ck\",\"id\":\"1\",\"c\":0,\"n\":2,\"d\":\"x\"}");

        assertThat(BleJsonCompact.decodeIfSupported(chunk).getString("type")).isEqualTo("ck");
    }

    @Test
    public void takePhotoStaysExpandedOutbound() throws Exception {
        JSONObject takePhoto =
                new JSONObject("{\"type\":\"take_photo\",\"requestId\":\"1\",\"webhookUrl\":\"https://x\"}");

        JSONObject encoded = BleJsonCompact.encode(takePhoto);

        assertThat(encoded.has("type")).isTrue();
        assertThat(encoded.getString("type")).isEqualTo("take_photo");
        assertThat(encoded.has("t")).isFalse();
    }
}
