package com.mentra.asg_client.io.bluetooth.managers.mentralive.internal;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class CsFltsAckPayloadTest {

    @Test
    public void parse_nullOrShortPayload_isNotCsFlts() {
        assertThat(CsFltsAckPayload.parse(null).kind).isEqualTo(CsFltsAckPayload.Kind.NOT_CS_FLTS);
        assertThat(CsFltsAckPayload.parse(new byte[10]).kind)
                .isEqualTo(CsFltsAckPayload.Kind.NOT_CS_FLTS);
    }

    @Test
    public void parse_unrelatedJson_isNotCsFlts() throws Exception {
        byte[] payload =
                new JSONObject()
                        .put("C", "sr_syvr")
                        .put("B", new JSONObject().put("ver", "1"))
                        .toString()
                        .getBytes(StandardCharsets.UTF_8);

        assertThat(CsFltsAckPayload.parse(payload).kind)
                .isEqualTo(CsFltsAckPayload.Kind.NOT_CS_FLTS);
    }

    @Test
    public void parse_validObjectBody_returnsAck() throws Exception {
        byte[] payload =
                new JSONObject()
                        .put("C", "cs_flts")
                        .put("B", new JSONObject().put("state", 1).put("index", 7))
                        .toString()
                        .getBytes(StandardCharsets.UTF_8);

        CsFltsAckPayload parsed = CsFltsAckPayload.parse(payload);
        assertThat(parsed.kind).isEqualTo(CsFltsAckPayload.Kind.ACK);
        assertThat(parsed.state).isEqualTo(1);
        assertThat(parsed.index).isEqualTo(7);
    }

    @Test
    public void parse_stringEncodedBody_returnsAck() throws Exception {
        String body = new JSONObject().put("state", 0).put("index", 3).toString();
        byte[] payload =
                new JSONObject()
                        .put("C", "cs_flts")
                        .put("B", body)
                        .toString()
                        .getBytes(StandardCharsets.UTF_8);

        CsFltsAckPayload parsed = CsFltsAckPayload.parse(payload);
        assertThat(parsed.kind).isEqualTo(CsFltsAckPayload.Kind.ACK);
        assertThat(parsed.state).isEqualTo(0);
        assertThat(parsed.index).isEqualTo(3);
    }

    @Test
    public void parse_missingBody_isMalformed() throws Exception {
        byte[] payload =
                new JSONObject()
                        .put("C", "cs_flts")
                        .toString()
                        .getBytes(StandardCharsets.UTF_8);
        // Pad so length clears the cheap size gate while remaining valid JSON.
        while (payload.length < 20) {
            payload =
                    new JSONObject()
                            .put("C", "cs_flts")
                            .put("pad", "xxxxxxxx")
                            .toString()
                            .getBytes(StandardCharsets.UTF_8);
        }

        assertThat(CsFltsAckPayload.parse(payload).kind)
                .isEqualTo(CsFltsAckPayload.Kind.MALFORMED);
    }

    @Test
    public void parse_incompleteStateIndex_isMalformed() throws Exception {
        byte[] payload =
                new JSONObject()
                        .put("C", "cs_flts")
                        .put("B", new JSONObject().put("state", 1))
                        .toString()
                        .getBytes(StandardCharsets.UTF_8);

        assertThat(CsFltsAckPayload.parse(payload).kind)
                .isEqualTo(CsFltsAckPayload.Kind.MALFORMED);
    }

    @Test
    public void parse_probeHitButWrongCommand_isNotCsFlts() {
        // Contains the substring but C is not cs_flts — must not consume as ACK.
        String json = "{\"C\":\"other\",\"note\":\"mentions cs_flts in text\"}";
        byte[] payload = json.getBytes(StandardCharsets.UTF_8);

        assertThat(CsFltsAckPayload.parse(payload).kind)
                .isEqualTo(CsFltsAckPayload.Kind.NOT_CS_FLTS);
    }

    @Test
    public void parse_csFltsWithInvalidJsonBody_isMalformed() {
        // Valid outer JSON with C=cs_flts, but B is a non-JSON string that throws on re-parse.
        // Once C is confirmed, the fast path must consume as MALFORMED (not NOT_CS_FLTS).
        String json = "{\"C\":\"cs_flts\",\"B\":\"not-valid-json{\"}";
        byte[] payload = json.getBytes(StandardCharsets.UTF_8);

        assertThat(CsFltsAckPayload.parse(payload).kind)
                .isEqualTo(CsFltsAckPayload.Kind.MALFORMED);
    }

    @Test
    public void parse_invalidOuterJsonWithCsFltsProbe_isNotCsFlts() {
        // Probe hits the substring but the outer payload is not valid JSON — cannot confirm C.
        byte[] payload = "{\"C\":\"cs_flts\", broken".getBytes(StandardCharsets.UTF_8);

        assertThat(CsFltsAckPayload.parse(payload).kind)
                .isEqualTo(CsFltsAckPayload.Kind.NOT_CS_FLTS);
    }
}
