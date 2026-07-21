package com.mentra.asg_client.io.bluetooth.managers.mentralive.internal;

import static org.assertj.core.api.Assertions.assertThat;

import com.mentra.asg_client.io.media.core.BlePhotoTimingLog;
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

        BlePhotoTimingLog.PacketClockStats clocks = stats.finishAndLog("bench.bin", 2048, 2);

        assertThat(clocks).isNotNull();
        assertThat(clocks.packetRttP50Ms).isEqualTo(11);
        assertThat(clocks.packetRttP95Ms).isEqualTo(15);
        assertThat(clocks.packetsAcked).isEqualTo(2);
        assertThat(clocks.totalPackets).isEqualTo(2);
        assertThat(clocks.ackToSendP50Ms).isGreaterThanOrEqualTo(0);
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
