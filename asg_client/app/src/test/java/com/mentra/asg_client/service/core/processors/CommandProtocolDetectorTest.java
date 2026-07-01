package com.mentra.asg_client.service.core.processors;

import static org.assertj.core.api.Assertions.assertThat;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;

@RunWith(RobolectricTestRunner.class)
public class CommandProtocolDetectorTest {

    @Test
    public void detect_rejectsCompactLowRoiCommand() throws Exception {
        CommandProtocolDetector detector = new CommandProtocolDetector();
        JSONObject input = new JSONObject("{\"C\":\"{\\\"t\\\":\\\"ping\\\"}\"}");

        CommandProtocolDetector.ProtocolDetectionResult result = detector.detectProtocol(input);

        assertThat(result.isValid()).isFalse();
    }

    @Test
    public void detect_acceptsExpandedLowRoiCommand() throws Exception {
        CommandProtocolDetector detector = new CommandProtocolDetector();
        JSONObject input = new JSONObject("{\"C\":\"{\\\"type\\\":\\\"ping\\\"}\"}");

        CommandProtocolDetector.ProtocolDetectionResult result = detector.detectProtocol(input);

        assertThat(result.isValid()).isTrue();
        assertThat(result.commandType()).isEqualTo("ping");
        assertThat(result.extractedData().getString("type")).isEqualTo("ping");
    }

    @Test
    public void detect_expandsCompactHighRoiCommand() throws Exception {
        CommandProtocolDetector detector = new CommandProtocolDetector();
        JSONObject input =
                new JSONObject("{\"C\":\"{\\\"t\\\":\\\"photo_status\\\",\\\"s\\\":3}\"}");

        CommandProtocolDetector.ProtocolDetectionResult result = detector.detectProtocol(input);

        assertThat(result.isValid()).isTrue();
        assertThat(result.commandType()).isEqualTo("photo_status");
        assertThat(result.extractedData().getString("status")).isEqualTo("capturing");
    }

    @Test
    public void detect_rejectsCompactHotspotCommand() throws Exception {
        CommandProtocolDetector detector = new CommandProtocolDetector();
        JSONObject input =
                new JSONObject(
                        "{\"C\":\"{\\\"t\\\":\\\"set_hotspot_state\\\",\\\"enabled\\\":true,\\\"mId\\\":4928205708632286171}\",\"W\":1}");

        CommandProtocolDetector.ProtocolDetectionResult result = detector.detectProtocol(input);

        assertThat(result.isValid()).isFalse();
    }
}
