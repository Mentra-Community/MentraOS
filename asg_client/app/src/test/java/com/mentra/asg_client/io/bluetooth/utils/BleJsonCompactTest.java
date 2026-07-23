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
        assertThat(compact.getLong("ts")).isEqualTo(100L);
        assertThat(compact.has("rc")).isFalse();
        assertThat(compact.getJSONObject("cm").getInt("aes")).isEqualTo(0);
        assertThat(compact.getJSONObject("cm").has("m")).isFalse();
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
    public void resolvedConfigDiffOmitsRepeatPayload() throws Exception {
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
        assertThat(secondWire.has("resolvedConfig")).isFalse();
        assertThat(secondWire.getString(BleJsonCompact.KEY_RESOLVED_CONFIG_HASH))
                .isEqualTo(BleJsonCompact.hashConfig(config));

        JSONObject restoredSecond = BleJsonCompact.decode(secondWire);
        assertThat(restoredSecond.getJSONObject("resolvedConfig").getString("source"))
                .isEqualTo("sdk");
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
