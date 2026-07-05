package com.mentra.asg_client.service.core.processors;

import static org.assertj.core.api.Assertions.assertThat;

import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.K900ProtocolStrategy;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Verifies the {@link CommandProtocolDetector} ships with only the base (vendor-free) strategies,
 * and that runtime registration of {@link K900ProtocolStrategy} restores MCU wire-format detection
 * without disturbing JSON or chunked routing — the seam introduced for the A6 module split.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class CommandProtocolDetectorTest {

    private static JSONObject standardJson() throws Exception {
        return new JSONObject().put("type", "ping").put("mId", 42);
    }

    private static JSONObject cFieldWithValidJson() throws Exception {
        return new JSONObject().put("C", new JSONObject().put("type", "ping").toString());
    }

    /** Mentra Live MCU frame: the C payload is a bare command string, not JSON. */
    private static JSONObject mcuFrame() throws Exception {
        return new JSONObject().put("C", "cs_flts").put("B", new JSONObject().put("state", 1));
    }

    private static JSONObject chunkFrame() throws Exception {
        JSONObject chunk =
                new JSONObject()
                        .put("type", "chunked_msg")
                        .put("chunkId", "abc")
                        .put("chunk", 0)
                        .put("total", 2)
                        .put("data", "payload-part");
        return new JSONObject().put("C", chunk.toString());
    }

    @Test
    public void baseDetector_standardJson_isJsonCommand() throws Exception {
        CommandProtocolDetector detector = new CommandProtocolDetector();

        CommandProtocolDetector.ProtocolDetectionResult result =
                detector.detectProtocol(standardJson());

        assertThat(result.protocolType())
                .isEqualTo(CommandProtocolDetector.ProtocolType.JSON_COMMAND);
        assertThat(result.commandType()).isEqualTo("ping");
        assertThat(result.messageId()).isEqualTo(42);
    }

    @Test
    public void baseDetector_cFieldWithValidJson_isJsonCommand() throws Exception {
        CommandProtocolDetector detector = new CommandProtocolDetector();

        CommandProtocolDetector.ProtocolDetectionResult result =
                detector.detectProtocol(cFieldWithValidJson());

        assertThat(result.protocolType())
                .isEqualTo(CommandProtocolDetector.ProtocolType.JSON_COMMAND);
    }

    @Test
    public void baseDetector_mcuFrame_isUnknown_coreNoLongerKnowsK900() throws Exception {
        CommandProtocolDetector detector = new CommandProtocolDetector();

        CommandProtocolDetector.ProtocolDetectionResult result =
                detector.detectProtocol(mcuFrame());

        assertThat(result.protocolType()).isEqualTo(CommandProtocolDetector.ProtocolType.UNKNOWN);
    }

    @Test
    public void registeredK900Strategy_mcuFrame_isK900Protocol() throws Exception {
        CommandProtocolDetector detector = new CommandProtocolDetector();
        detector.addDetectionStrategy(new K900ProtocolStrategy());

        CommandProtocolDetector.ProtocolDetectionResult result =
                detector.detectProtocol(mcuFrame());

        assertThat(result.protocolType())
                .isEqualTo(CommandProtocolDetector.ProtocolType.K900_PROTOCOL);
        assertThat(result.isValid()).isTrue();
    }

    @Test
    public void registeredK900Strategy_doesNotStealJsonCommands() throws Exception {
        CommandProtocolDetector detector = new CommandProtocolDetector();
        detector.addDetectionStrategy(new K900ProtocolStrategy());

        assertThat(detector.detectProtocol(standardJson()).protocolType())
                .isEqualTo(CommandProtocolDetector.ProtocolType.JSON_COMMAND);
        assertThat(detector.detectProtocol(cFieldWithValidJson()).protocolType())
                .isEqualTo(CommandProtocolDetector.ProtocolType.JSON_COMMAND);
    }

    @Test
    public void chunkedSupport_withK900Registered_chunksStillRouteToChunkedStrategy()
            throws Exception {
        // Mirrors CommandProcessor wiring order: vendor strategies first, then chunked support.
        CommandProtocolDetector detector = new CommandProtocolDetector();
        detector.addDetectionStrategy(new K900ProtocolStrategy());
        detector.addChunkedMessageSupport(new ChunkReassembler());

        CommandProtocolDetector.ProtocolDetectionResult result =
                detector.detectProtocol(chunkFrame());

        // A first chunk is consumed by the chunked strategy and reported as in-progress —
        // proving neither the K900 nor the JSON strategy intercepted it.
        assertThat(result.commandType()).isEqualTo("chunk_in_progress");

        // And the MCU frame still routes to K900 with chunked support active.
        assertThat(detector.detectProtocol(mcuFrame()).protocolType())
                .isEqualTo(CommandProtocolDetector.ProtocolType.K900_PROTOCOL);
    }
}
