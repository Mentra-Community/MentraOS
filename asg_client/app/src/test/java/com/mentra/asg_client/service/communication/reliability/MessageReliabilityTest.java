package com.mentra.asg_client.service.communication.reliability;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.LooperMode;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
@LooperMode(LooperMode.Mode.PAUSED)
public class MessageReliabilityTest {
    @Test
    public void wifiTerminalResultsRequireAckRetry() {
        assertThat(MessageReliability.needsReliability("wifi_forget_result")).isTrue();
        assertThat(MessageReliability.needsReliability("saved_wifi_networks")).isTrue();
        assertThat(MessageReliability.needsReliability("msg_ack")).isFalse();
    }

    @Test
    public void missingAckRetriesTerminalWithStableMessageIdAndAckStopsFurtherRetries()
            throws Exception {
        RecordingSender sender = new RecordingSender();
        ReliableMessageManager manager = new ReliableMessageManager(sender);
        manager.setEnabled(true, 1);

        assertThat(manager.sendMessage(new JSONObject().put("type", "wifi_forget_result")))
                .isTrue();
        assertThat(sender.messages).hasSize(1);
        long messageId = sender.messages.get(0).getLong("mId");

        Shadows.shadowOf(android.os.Looper.getMainLooper()).idleFor(Duration.ofMillis(1001));

        assertThat(sender.messages).hasSize(2);
        assertThat(sender.messages.get(1).getLong("mId")).isEqualTo(messageId);

        manager.handleAck(messageId);
        Shadows.shadowOf(android.os.Looper.getMainLooper()).idleFor(Duration.ofSeconds(5));

        assertThat(sender.messages).hasSize(2);
        assertThat(manager.getStatistics().getInt("pending_count")).isZero();
        assertThat(manager.getStatistics().getLong("total_acks")).isEqualTo(1L);
        manager.shutdown();
    }

    private static final class RecordingSender implements ReliableMessageManager.IMessageSender {
        final List<JSONObject> messages = new ArrayList<>();

        @Override
        public boolean sendData(
                byte[] data,
                ReliableMessageManager.SendCompletionCallback callback,
                ReliableMessageManager.SendGate gate) {
            synchronized (gate != null ? gate.lock() : this) {
                if (gate != null && !gate.shouldSend()) {
                    return false;
                }
                try {
                    messages.add(new JSONObject(new String(data, StandardCharsets.UTF_8)));
                } catch (Exception exception) {
                    throw new AssertionError("Reliable payload was not valid JSON", exception);
                }
                if (callback != null) {
                    callback.onComplete(true);
                }
                return true;
            }
        }
    }
}
