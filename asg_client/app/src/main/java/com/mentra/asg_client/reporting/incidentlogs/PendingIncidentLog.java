package com.mentra.asg_client.reporting.incidentlogs;

import org.json.JSONObject;

/**
 * In-memory representation of a pending incident log file.
 *
 * <p>The {@link #payload} field contains the exact JSON body to POST to the backend
 * ({@code source} + {@code logs} array). No transformation is needed at upload time.</p>
 */
public class PendingIncidentLog {

  public final String incidentId;
  public final String source;
  public final long createdAt;
  public final int attempts;
  public final long lastAttemptAt;
  public final String lastError;
  public final JSONObject payload;

  public PendingIncidentLog(String incidentId, String source, long createdAt,
                            int attempts, long lastAttemptAt, String lastError,
                            JSONObject payload) {
    this.incidentId = incidentId;
    this.source = source;
    this.createdAt = createdAt;
    this.attempts = attempts;
    this.lastAttemptAt = lastAttemptAt;
    this.lastError = lastError;
    this.payload = payload;
  }
}
