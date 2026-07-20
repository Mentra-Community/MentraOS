package com.mentra.asg_client.io.bluetooth.managers.mentralive.internal;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class FileTransferLatencyStatsTest {

    @Test
    public void recordsAckToSendAndRtt_andEmitsSummary() throws Exception {
        FileTransferLatencyStats stats = new FileTransferLatencyStats();

        stats.onAckSeen();
        Thread.sleep(2);
        long ackToSend = stats.onPacketSendStarted();
        assertThat(ackToSend).isGreaterThanOrEqualTo(0L);

        stats.onPacketRtt(11);
        stats.onPacketRtt(15);

        String summary = stats.finishAndLog("bench.bin", 2048, 2);

        assertThat(summary).contains("SUMMARY");
        assertThat(summary).contains("file=bench.bin");
        assertThat(summary).contains("ack_to_send_p50_ms=");
        assertThat(summary).contains("packet_rtt_p50_ms=11");
        assertThat(summary).contains("packet_rtt_p95_ms=15");
        assertThat(stats.getPacketsAcked()).isEqualTo(2);
    }

    @Test
    public void onPacketSendStarted_withoutAck_returnsNegative() {
        FileTransferLatencyStats stats = new FileTransferLatencyStats();
        assertThat(stats.onPacketSendStarted()).isEqualTo(-1L);
    }

    @Test
    public void percentileOrNa_handlesEmpty() {
        assertThat(FileTransferLatencyStats.percentileOrNa(new long[0], 0, 0.5)).isEqualTo("na");
        assertThat(FileTransferLatencyStats.percentileOrNa(new long[] {1, 2, 3, 4}, 4, 0.5))
                .isEqualTo("2");
    }
}
