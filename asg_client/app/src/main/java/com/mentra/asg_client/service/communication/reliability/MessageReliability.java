package com.mentra.asg_client.service.communication.reliability;

import java.util.Set;

/**
 * Simple reliability checker - mirrors phone's boolean approach.
 * Determines which messages need ACK/retry based on type.
 */
public class MessageReliability {

    // Messages that need ACK/retry - keep it simple
    private static final Set<String> RELIABLE_TYPES = Set.of(
        // Critical operations
        "photo_captured",
        "photo_failed",
        "video_started",
        "video_stopped",
        "video_failed",
        "auth_token_status",

        // Important status changes
        "error",
        "wifi_connected",
        "wifi_disconnected",
        "settings_updated",
        "ota_download_progress",
        "ota_installation_progress"
    );

    // Messages that NEVER get retry (prevent loops)
    private static final Set<String> NEVER_RETRY = Set.of(
        "msg_ack",
        "keep_alive_ack"
    );

    /**
     * Simple boolean check - does this message need reliability?
     * @param messageType The message type to check
     * @return true if the message needs ACK/retry, false otherwise
     */
    public static boolean needsReliability(String messageType) {
        if (messageType == null || NEVER_RETRY.contains(messageType)) {
            return false;
        }
        return RELIABLE_TYPES.contains(messageType);
    }
}