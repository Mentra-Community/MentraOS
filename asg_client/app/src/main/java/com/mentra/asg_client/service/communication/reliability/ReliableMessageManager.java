package com.mentra.asg_client.service.communication.reliability;

import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.security.SecureRandom;
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
        boolean sendData(byte[] data);
    }

    /**
     * Internal class to track pending messages awaiting ACK.
     */
    private static class PendingMessage {
        final JSONObject message;
        final long timestamp;
        final int retryCount;
        final Runnable timeoutRunnable;

        PendingMessage(JSONObject message, int retryCount, Runnable timeoutRunnable) {
            this.message = message;
            this.timestamp = System.currentTimeMillis();
            this.retryCount = retryCount;
            this.timeoutRunnable = timeoutRunnable;
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

            // Track the message
            trackMessage(messageId, message);

            // Send immediately
            boolean sent = sendDirectly(message);
            if (sent) {
                totalMessagesSent++;
            }
            return sent;

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
        PendingMessage pending = pendingMessages.remove(messageId);
        if (pending != null) {
            // Cancel timeout
            retryHandler.removeCallbacks(pending.timeoutRunnable);
            totalAcksReceived++;

            Log.d(TAG, String.format("ACK received for message %d (attempts: %d, time: %dms)",
                messageId, pending.retryCount + 1,
                System.currentTimeMillis() - pending.timestamp));
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
     * Track a message for retry if ACK not received.
     * @param messageId The message ID to track
     * @param message The message content
     */
    private void trackMessage(long messageId, JSONObject message) {
        Runnable timeoutRunnable = () -> handleTimeout(messageId);

        PendingMessage pending = new PendingMessage(message, 0, timeoutRunnable);

        pendingMessages.put(messageId, pending);

        // Schedule timeout check
        retryHandler.postDelayed(timeoutRunnable, ACK_TIMEOUT_MS);
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
        // Create updated pending message with incremented retry count
        PendingMessage updated = new PendingMessage(
            pending.message,
            pending.retryCount + 1,
            pending.timeoutRunnable
        );

        pendingMessages.put(messageId, updated);

        // Send again
        sendDirectly(pending.message);

        // Reschedule timeout with exponential backoff
        long backoffDelay = ACK_TIMEOUT_MS * (1L << pending.retryCount);
        retryHandler.postDelayed(pending.timeoutRunnable, backoffDelay);
    }

    /**
     * Send a message directly without retry logic.
     * @param message The message to send
     * @return true if sent successfully, false otherwise
     */
    private boolean sendDirectly(JSONObject message) {
        try {
            String jsonString = message.toString();
            return messageSender.sendData(jsonString.getBytes());
        } catch (Exception e) {
            Log.e(TAG, "Error sending message", e);
            return false;
        }
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

        pendingMessages.entrySet().removeIf(entry -> {
            PendingMessage pending = entry.getValue();
            if (pending.timestamp < cutoff) {
                Log.w(TAG, "Removing stale message: " + entry.getKey());
                retryHandler.removeCallbacks(pending.timeoutRunnable);
                return true;
            }
            return false;
        });
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