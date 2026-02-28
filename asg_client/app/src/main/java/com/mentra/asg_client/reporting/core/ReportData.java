package com.mentra.asg_client.reporting.core;

import java.util.HashMap;
import java.util.Map;

/**
 * Data class containing all information needed for reporting
 * Immutable to ensure thread safety and data integrity
 */
public class ReportData {
    private final String message;
    private final ReportLevel level;
    private final String category;
    private final String operation;
    private final Map<String, Object> tags;
    private final Map<String, Object> context;
    private final Throwable exception;
    private final long timestamp;
    private final String userId;
    private final String sessionId;

    private ReportData(Builder builder) {
        this.message = builder.message;
        this.level = builder.level;
        this.category = builder.category;
        this.operation = builder.operation;
        this.tags = new HashMap<>(builder.tags);
        this.context = new HashMap<>(builder.context);
        this.exception = builder.exception;
        this.timestamp = builder.timestamp;
        this.userId = builder.userId;
        this.sessionId = builder.sessionId;
    }

    // Getters
    public String getMessage() { return message; }
    public ReportLevel getLevel() { return level; }
    public String getCategory() { return category; }
    public String getOperation() { return operation; }
    public Map<String, Object> getTags() { return new HashMap<>(tags); }
    public Map<String, Object> getContext() { return new HashMap<>(context); }
    public Throwable getException() { return exception; }
    public long getTimestamp() { return timestamp; }
    public String getUserId() { return userId; }
    public String getSessionId() { return sessionId; }

    /**
     * Builder pattern for creating ReportData instances
     */
    public static class Builder {
        private String message;
        private ReportLevel level = ReportLevel.INFO;
        private String category = "general";
        private String operation = "";
        private Map<String, Object> tags = new HashMap<>();
        private Map<String, Object> context = new HashMap<>();
        private Throwable exception;
        private long timestamp = System.currentTimeMillis();
        private String userId;
        private String sessionId;

        public Builder message(String message) {
            this.message = message;
            return this;
        }

        public Builder level(ReportLevel level) {
            this.level = level;
            return this;
        }

        public Builder category(String category) {
            this.category = category;
            return this;
        }

        public Builder operation(String operation) {
            this.operation = operation;
            return this;
        }

        public Builder tag(String key, Object value) {
            this.tags.put(key, value);
            return this;
        }

        public Builder tags(Map<String, Object> tags) {
            this.tags.putAll(tags);
            return this;
        }

        public Builder context(String key, Object value) {
            this.context.put(key, value);
            return this;
        }

        public Builder context(Map<String, Object> context) {
            this.context.putAll(context);
            return this;
        }

        public Builder exception(Throwable exception) {
            this.exception = exception;
            return this;
        }

        public Builder timestamp(long timestamp) {
            this.timestamp = timestamp;
            return this;
        }

        public Builder userId(String userId) {
            this.userId = userId;
            return this;
        }

        public Builder sessionId(String sessionId) {
            this.sessionId = sessionId;
            return this;
        }

        public ReportData build() {
            if (message == null || message.isEmpty()) {
                throw new IllegalArgumentException("Message cannot be null or empty");
            }
            return new ReportData(this);
        }
    }
} 