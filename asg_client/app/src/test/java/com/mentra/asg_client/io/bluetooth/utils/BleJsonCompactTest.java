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
}
