package com.mentra.asg_client.io.bluetooth.managers.mentralive.internal;

import static org.assertj.core.api.Assertions.assertThat;

import com.mentra.asg_client.service.core.processors.ChunkReassembler;
import java.util.List;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Regression test for incident rep_01KY6BJ0B7A4RBMQ7VN39KAE5E: v1 ck chunks were sized
 * against MTU_TARGET (509) but a v1 string frame must survive the phone leg as a single
 * BLE notification (~253-byte ATT payload). The OTA completion ota_status packed to
 * 256-263-byte chunk frames, every one was truncated on the wire, and the phone failed a
 * successful update. Every packed v1 ck chunk must stay within
 * {@link MessageChunker#MAX_PACKED_STRING_CHUNK_SIZE}.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class StringChunkBudgetTest {

    @Before
    public void setUp() {
        // v1 string mode — the post-APK-restart steady state until a BLE reconnect.
        BesWireFormat.resetBinaryProtocol();
        MessageChunker.resetStringChunkBudget();
    }

    @After
    public void tearDown() {
        BesWireFormat.resetBinaryProtocol();
        MessageChunker.resetStringChunkBudget();
    }

    /** The 251-byte ota_status completion shape from the incident, quote-dense like the real payload. */
    private static String incidentShapedOtaStatus() {
        return "{\"sid\":\"d017b9b1\",\"ts\":1,\"cs\":1,\"st\":\"apk\",\"sq\":[\"apk\"],"
                + "\"phase\":\"install\",\"sp\":100,\"op\":100,\"status\":\"complete\","
                + "\"type\":\"ota_status\",\"mId\":1828367906865900787,"
                + "\"glasses_time_ms\":1784772000000,\"extra\":\"padding-to-incident-size-xxxx\"}";
    }

    private static String largeQuoteDenseJson(int approxBytes) throws Exception {
        JSONObject json = new JSONObject();
        json.put("type", "ota_status");
        int i = 0;
        while (json.toString().length() < approxBytes) {
            json.put("key_" + i, "value-with-\"quotes\"-" + i);
            i++;
        }
        return json.toString();
    }

    private static void assertAllPackedChunksFitAndRoundTrip(String message) throws Exception {
        List<JSONObject> chunks = MessageChunker.createChunks(message, 42L);
        assertThat(chunks.size()).isGreaterThan(1);

        ChunkReassembler reassembler = new ChunkReassembler();
        String reassembled = null;
        for (JSONObject chunk : chunks) {
            // The wire cost of a chunk includes the C-wrap and its double escaping —
            // measure the packed frame exactly as the send path produces it.
            byte[] packed = BesWireFormat.formatMessageForTransmission(chunk.toString());
            assertThat(packed).isNotNull();
            assertThat(packed.length).isLessThanOrEqualTo(MessageChunker.maxPackedStringChunkSize());

            reassembled =
                    reassembler.addChunk(
                            chunk.getString("id"),
                            chunk.getInt("c"),
                            chunk.getInt("n"),
                            chunk.getString("d"));
        }
        assertThat(reassembled).isEqualTo(message);
    }

    @Test
    public void incidentSizedOtaStatusChunksFitTheNotificationBudget() throws Exception {
        assertAllPackedChunksFitAndRoundTrip(incidentShapedOtaStatus());
    }

    @Test
    public void threeHundredByteMessageChunksFitTheNotificationBudget() throws Exception {
        assertAllPackedChunksFitAndRoundTrip(largeQuoteDenseJson(300));
    }

    @Test
    public void fiveHundredByteMessageChunksFitTheNotificationBudget() throws Exception {
        assertAllPackedChunksFitAndRoundTrip(largeQuoteDenseJson(500));
    }

    // ---- negotiated notify_cap budget (BES firmware >= 17.26.7.23) ----

    @Test
    public void budgetDefaultsToTheConservativeFallback() {
        assertThat(MessageChunker.maxPackedStringChunkSize())
                .isEqualTo(com.mentra.asg_client.AsgConstants.K900_STRING_CHUNK_MAX_FRAME_BYTES)
                .isEqualTo(240);
    }

    @Test
    public void advertisedNotifyCapRaisesTheBudgetByTheSameMargin() {
        MessageChunker.setStringChunkBudgetFromNotifyCap(509);
        assertThat(MessageChunker.maxPackedStringChunkSize()).isEqualTo(509 - 13);

        MessageChunker.setStringChunkBudgetFromNotifyCap(253);
        assertThat(MessageChunker.maxPackedStringChunkSize()).isEqualTo(253 - 13);
    }

    @Test
    public void notifyCapAboveTheContractCeilingIsClampedToTheCeiling() {
        // The BES contract is max(253, min(ATT MTU - 3, 509)); an oversized advertisement must
        // not size chunks beyond what the transport carries.
        MessageChunker.setStringChunkBudgetFromNotifyCap(1000);

        assertThat(MessageChunker.maxPackedStringChunkSize()).isEqualTo(509 - 13);
    }

    @Test
    public void notifyCapContractBoundariesAreAcceptedExactly() {
        MessageChunker.setStringChunkBudgetFromNotifyCap(253);
        assertThat(MessageChunker.maxPackedStringChunkSize()).isEqualTo(253 - 13);

        MessageChunker.setStringChunkBudgetFromNotifyCap(509);
        assertThat(MessageChunker.maxPackedStringChunkSize()).isEqualTo(509 - 13);
    }

    @Test
    public void notifyCapBelowTheContractFloorIsIgnored() {
        MessageChunker.setStringChunkBudgetFromNotifyCap(509);
        MessageChunker.setStringChunkBudgetFromNotifyCap(200);

        // The malformed advertisement must not shrink the budget below the validated fallback.
        assertThat(MessageChunker.maxPackedStringChunkSize()).isEqualTo(509 - 13);
    }

    @Test
    public void resetRestoresTheFallbackBudget() {
        MessageChunker.setStringChunkBudgetFromNotifyCap(509);

        MessageChunker.resetStringChunkBudget();

        assertThat(MessageChunker.maxPackedStringChunkSize()).isEqualTo(240);
    }

    @Test
    public void chunksStillFitAndRoundTripUnderARaisedBudget() throws Exception {
        MessageChunker.setStringChunkBudgetFromNotifyCap(509);
        assertAllPackedChunksFitAndRoundTrip(largeQuoteDenseJson(500));
    }

    @Test
    public void budgetFollowsTheCapsLifecycleThroughTheLinkStateMachine() {
        LinkStateMachine machine = new LinkStateMachine();
        MessageChunker.followLinkState(machine);

        machine.serialReady();
        machine.srSyvrParsed(
                new LinkStateMachine.BesCaps(
                        false, false, false, false, BesWireFormat.PROTOCOL_VERSION_V1, 509));
        assertThat(MessageChunker.maxPackedStringChunkSize()).isEqualTo(509 - 13);

        // A discontinuity (baud reopen) keeps the negotiated caps — and the budget with them.
        machine.streamDiscontinuity();
        assertThat(MessageChunker.maxPackedStringChunkSize()).isEqualTo(509 - 13);

        // EVERY close path (onSerialClose, failed onSerialOpen, reopen failures) funnels
        // through the machine's serialClosed transition: caps cleared MUST mean fallback
        // budget, or a later session against firmware without notify_cap would inherit a
        // stale oversized budget and silently truncate notifications again.
        machine.serialClosed();
        assertThat(MessageChunker.maxPackedStringChunkSize()).isEqualTo(240);

        // Reconnect to old firmware (sr_syvr without wire_caps): the fallback must hold.
        machine.serialReady();
        machine.srSyvrParsed(null);
        assertThat(MessageChunker.maxPackedStringChunkSize()).isEqualTo(240);
    }

    @Test
    public void budgetFollowsThePhoneSessionLifecycle() {
        // notify_cap derives from the phone BLE session's negotiated ATT MTU, so the budget
        // must not outlive that session: a reconnecting phone can negotiate a SMALLER MTU, and
        // the old 496 budget would silently truncate its notifications.
        LinkStateMachine machine = new LinkStateMachine();
        MessageChunker.followLinkState(machine);
        machine.serialReady();
        machine.phonePresenceReported(true);
        machine.srSyvrParsed(
                new LinkStateMachine.BesCaps(
                        false, false, false, false, BesWireFormat.PROTOCOL_VERSION_V1, 509));
        assertThat(MessageChunker.maxPackedStringChunkSize()).isEqualTo(509 - 13);

        // Phone disconnects: back to the fallback.
        machine.phonePresenceReported(false);
        assertThat(MessageChunker.maxPackedStringChunkSize()).isEqualTo(240);

        // Phone reconnects WITHOUT a fresh advertisement: the fallback must hold.
        machine.phonePresenceReported(true);
        assertThat(MessageChunker.maxPackedStringChunkSize()).isEqualTo(240);

        // A fresh advertisement (measured for the new session's MTU) re-arms the budget.
        machine.srSyvrParsed(
                new LinkStateMachine.BesCaps(
                        false, false, false, false, BesWireFormat.PROTOCOL_VERSION_V1, 260));
        assertThat(MessageChunker.maxPackedStringChunkSize()).isEqualTo(260 - 13);
    }

    @Test
    public void budgetFallsBackOnBesOta() {
        // A BES OTA is a firmware-generation boundary AND kills the phone session: the new
        // firmware may advertise a different notify_cap or none at all.
        LinkStateMachine machine = new LinkStateMachine();
        MessageChunker.followLinkState(machine);
        machine.serialReady();
        machine.srSyvrParsed(
                new LinkStateMachine.BesCaps(
                        false, false, false, false, BesWireFormat.PROTOCOL_VERSION_V1, 509));
        assertThat(MessageChunker.maxPackedStringChunkSize()).isEqualTo(509 - 13);

        // onBesOtaApplied drives exactly these two machine transitions.
        machine.streamDiscontinuity();
        machine.phonePresenceInvalidated();

        assertThat(MessageChunker.maxPackedStringChunkSize()).isEqualTo(240);
    }
}
