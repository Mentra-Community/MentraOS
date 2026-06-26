package com.mentra.asg_client.service.communication.reliability;

import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.security.SecureRandom;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Manages reliable message delivery from glasses to phone.
 * Provides retry logic for critical messages that need guaranteed delivery.
 */
public class ReliableMessageManager {
    private static final String TAG = "ReliableMessageManager";

    // Configuration - Keep it simple like the phone side
    private static final long ACK_TIMEOUT_MS = 1000;      // 1 second timeout
    private static final int MAX_RETRIES = 2;             // 2 retries (3 total attempts)
    private static final long MAX_PENDING_MESSAGES = 10;  // Resource constraint
    private static final long CLEANUP_INTERVAL_MS = 30000; // 30 seconds
    private static final long QUEUED_SEND_CLEANUP_MS = CLEANUP_INTERVAL_MS * 10; // 5 minutes

    // State
    private final ConcurrentHashMap<Long, PendingMessage> pendingMessages;
    private final AtomicLong messageIdCounter;
    private final SecureRandom secureRandom;
    private final Handler retryHandler;
    private final IMessageSender messageSender;
    private boolean enabled = false;
    private int phoneVersionNumber = 0;

    // Statistics
    private long totalMessagesSent = 0;
    private long totalAcksReceived = 0;
    private long totalRetries = 0;
    private long totalFailures = 0;

    /**
     * Interface for sending messages.
     * Implemented by the class that has access to Bluetooth.
     */
    public interface IMessageSender {
        boolean sendData(byte[] data, SendCompletionCallback callback, SendGate gate);
    }

    public interface SendCompletionCallback {
        void onComplete(boolean success);
    }

    public interface SendGate {
        boolean shouldSend();

        Object lock();
    }

    /**
     * Internal class to track pending messages awaiting ACK.
     */
    private static class PendingMessage {
        final JSONObject message;
        final long timestamp;
        final int retryCount;
        volatile Runnable timeoutRunnable;

        PendingMessage(JSONObject message, int retryCount) {
            this.message = message;
            this.timestamp = System.currentTimeMillis();
            this.retryCount = retryCount;
        }
    }

    /**
     * Create a new ReliableMessageManager.
     * @param sender The implementation that sends data over Bluetooth
     */
    public ReliableMessageManager(IMessageSender sender) {
        this.messageSender = sender;
        this.pendingMessages = new ConcurrentHashMap<>();
        this.messageIdCounter = new AtomicLong(1);
        this.secureRandom = new SecureRandom();
        this.retryHandler = new Handler(Looper.getMainLooper());

        // Schedule periodic cleanup
        scheduleCleanup();
    }

    /**
     * Send a message with optional retry based on message type.
     * @param message The message to send
     * @return true if the message was queued for sending, false otherwise
     */
    public boolean sendMessage(JSONObject message) {
        String type = message.optString("type", "");

        // Simple decision - needs reliability or not
        if (!enabled || !MessageReliability.needsReliability(type)) {
            return sendDirectly(message);
        }

        // Check resource limits
        if (pendingMessages.size() >= MAX_PENDING_MESSAGES) {
            Log.w(TAG, "Pending message buffer full, sending without retry");
            return sendDirectly(message);
        }

//        return sendDirectly(message);
        try {
            long messageId = generateMessageId();
            message.put("mId", messageId);

            PendingMessage pending = new PendingMessage(message, 0);
            pendingMessages.put(messageId, pending);

            // Accept ACKs immediately, but start the timeout only after the queued transport send
            // actually completes so outbound queue delay does not consume the ACK window.
            boolean accepted =
                    sendDirectly(
                            message,
                            success -> {
                                if (success) {
                                    startAckTimeoutIfPending(messageId, pending, ACK_TIMEOUT_MS);
                                    totalMessagesSent++;
                                } else if (pendingMessages.remove(messageId, pending)) {
                                    totalFailures++;
                                }
                            },
                            pendingGate(messageId, pending));
            if (!accepted && pendingMessages.remove(messageId, pending)) {
                totalFailures++;
            }
            return accepted;

        } catch (JSONException e) {
            Log.e(TAG, "Error adding message ID", e);
            return sendDirectly(message);
        }
    }

    /**
     * Handle incoming ACK from phone.
     * @param messageId The message ID being acknowledged
     */
    public void handleAck(long messageId) {
        PendingMessage pending = pendingMessages.get(messageId);
        if (pending != null) {
            synchronized (pending) {
                if (!pendingMessages.remove(messageId, pending)) {
                    return;
                }

                // Cancel timeout
                if (pending.timeoutRunnable != null) {
                    retryHandler.removeCallbacks(pending.timeoutRunnable);
                }
                totalAcksReceived++;

                Log.d(TAG, String.format("ACK received for message %d (attempts: %d, time: %dms)",
                    messageId, pending.retryCount + 1,
                    System.currentTimeMillis() - pending.timestamp));
            }
        }
    }

    /**
     * Enable/disable reliability based on phone version.
     * @param enabled Whether reliability should be enabled
     * @param phoneVersion The phone app version number
     */
    public void setEnabled(boolean enabled, int phoneVersion) {
        this.enabled = enabled;
        this.phoneVersionNumber = phoneVersion;
        Log.i(TAG, "Reliability " + (enabled ? "enabled" : "disabled") +
                   " for phone version " + phoneVersion);
    }

    /**
     * Generate a unique message ID using the same approach as the phone.
     * @return A unique message ID
     */
    private long generateMessageId() {
        // Same approach as phone - simple and effective
        long timestamp = System.currentTimeMillis();
        long randomComponent = secureRandom.nextLong();
        long counter = messageIdCounter.getAndIncrement();

        // Ensure positive (same as phone)
        return Math.abs(timestamp ^ randomComponent ^ counter);
    }

    /**
     * Arm the ACK timeout if the message is still pending.
     * @param messageId The message ID to track
     * @param pending The pending message to arm
     */
    private void startAckTimeoutIfPending(long messageId, PendingMessage pending, long timeoutMs) {
        Runnable timeoutRunnable = () -> handleTimeout(messageId);
        pending.timeoutRunnable = timeoutRunnable;

        retryHandler.postDelayed(timeoutRunnable, timeoutMs);
        if (pendingMessages.get(messageId) != pending) {
            retryHandler.removeCallbacks(timeoutRunnable);
        }
    }

    /**
     * Handle timeout for a message (no ACK received).
     * @param messageId The message ID that timed out
     */
    private void handleTimeout(long messageId) {
        PendingMessage pending = pendingMessages.get(messageId);
        if (pending == null) return;

        if (pending.retryCount < MAX_RETRIES) {
            // Retry
            Log.w(TAG, String.format("Timeout for message %d, retrying (%d/%d)",
                messageId, pending.retryCount + 1, MAX_RETRIES));

            totalRetries++;
            retryMessage(messageId, pending);
        } else {
            // Max retries reached
            Log.e(TAG, String.format("Message %d failed after %d attempts",
                messageId, MAX_RETRIES + 1));

            pendingMessages.remove(messageId);
            totalFailures++;
        }
    }

    /**
     * Retry sending a message.
     * @param messageId The message ID to retry
     * @param pending The pending message information
     */
    private void retryMessage(long messageId, PendingMessage pending) {
        int nextRetryCount = pending.retryCount + 1;
        long backoffDelay = ACK_TIMEOUT_MS * (1L << pending.retryCount);
        PendingMessage retryPending = new PendingMessage(pending.message, nextRetryCount);

        if (!pendingMessages.replace(messageId, pending, retryPending)) {
            return;
        }

        // Keep accepting ACKs while the retry is queued, but restart the ACK timeout only after
        // the queued retry actually completes.
        boolean accepted =
                sendDirectly(
                        pending.message,
                        success -> {
                            if (success) {
                                startAckTimeoutIfPending(messageId, retryPending, backoffDelay);
                            } else if (pendingMessages.remove(messageId, retryPending)) {
                                totalFailures++;
                            }
                        },
                        pendingGate(messageId, retryPending));
        if (!accepted && pendingMessages.remove(messageId, retryPending)) {
            totalFailures++;
        }
    }

    /**
     * Send a message directly without retry logic.
     * @param message The message to send
     * @return true if sent successfully, false otherwise
     */
    private boolean sendDirectly(JSONObject message) {
        return sendDirectly(message, null, null);
    }

    private boolean sendDirectly(
            JSONObject message, SendCompletionCallback callback, SendGate gate) {
        try {
            String jsonString = message.toString();
            return messageSender.sendData(jsonString.getBytes(), callback, gate);
        } catch (Exception e) {
            Log.e(TAG, "Error sending message", e);
            return false;
        }
    }

    private SendGate pendingGate(long messageId, PendingMessage pending) {
        return new SendGate() {
            @Override
            public boolean shouldSend() {
                return pendingMessages.get(messageId) == pending;
            }

            @Override
            public Object lock() {
                return pending;
            }
        };
    }

    /**
     * Schedule periodic cleanup of old messages.
     */
    private void scheduleCleanup() {
        retryHandler.postDelayed(() -> {
            cleanupOldMessages();
            scheduleCleanup();
        }, CLEANUP_INTERVAL_MS);
    }

    /**
     * Remove stale messages from the pending map.
     */
    private void cleanupOldMessages() {
        long now = System.currentTimeMillis();
        long cutoff = now - (CLEANUP_INTERVAL_MS * 2);
        long queuedCutoff = now - QUEUED_SEND_CLEANUP_MS;

        for (Map.Entry<Long, PendingMessage> entry : pendingMessages.entrySet()) {
            long messageId = entry.getKey();
            PendingMessage pending = entry.getValue();

            synchronized (pending) {
                // The ACK timer is armed only after the queued transport send completes.
                if (pending.timeoutRunnable == null) {
                    if (pending.timestamp < queuedCutoff
                            && pendingMessages.remove(messageId, pending)) {
                        Log.w(TAG, "Removing stale queued message: " + messageId);
                        totalFailures++;
                    }
                    continue;
                }

                if (pending.timestamp < cutoff
                        && pendingMessages.remove(messageId, pending)) {
                    Log.w(TAG, "Removing stale message: " + messageId);
                    retryHandler.removeCallbacks(pending.timeoutRunnable);
                    totalFailures++;
                }
            }
        }
    }

    /**
     * Shutdown the manager and cleanup resources.
     */
    public void shutdown() {
        retryHandler.removeCallbacksAndMessages(null);
        pendingMessages.clear();
    }

    /**
     * Get statistics about message reliability.
     * @return JSON object with statistics
     */
    public JSONObject getStatistics() throws JSONException {
        JSONObject stats = new JSONObject();
        stats.put("total_sent", totalMessagesSent);
        stats.put("total_acks", totalAcksReceived);
        stats.put("total_retries", totalRetries);
        stats.put("total_failures", totalFailures);
        stats.put("pending_count", pendingMessages.size());
        stats.put("enabled", enabled);
        return stats;
    }
}
