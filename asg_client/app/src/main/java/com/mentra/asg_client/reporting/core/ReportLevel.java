package com.mentra.asg_client.reporting.core;

/**
 * Enum defining different levels of reporting
 * Follows standard logging levels for consistency
 */
public enum ReportLevel {
    DEBUG(0, "debug"),
    INFO(1, "info"),
    WARNING(2, "warning"),
    ERROR(3, "error"),
    CRITICAL(4, "critical");

    private final int level;
    private final String name;

    ReportLevel(int level, String name) {
        this.level = level;
        this.name = name;
    }

    public int getLevel() {
        return level;
    }

    public String getName() {
        return name;
    }

    public boolean isAtLeast(ReportLevel other) {
        return this.level >= other.level;
    }
} 