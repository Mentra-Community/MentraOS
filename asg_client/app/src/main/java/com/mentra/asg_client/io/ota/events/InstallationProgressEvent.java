package com.mentra.asg_client.io.ota.events;

/**
 * EventBus event for installation progress updates
 * Used to communicate installation status between OtaHelper and MainActivity
 */
public class InstallationProgressEvent {
    public enum InstallationStatus {
        STARTED,
        FINISHED,
        FAILED
    }

    private final InstallationStatus status;
    private final String apkPath;
    private final String errorMessage;
    private final long timestamp;

    // Constructor for STARTED status
    public InstallationProgressEvent(InstallationStatus status, String apkPath) {
        this(status, apkPath, null);
    }

    // Constructor for FAILED status
    public InstallationProgressEvent(InstallationStatus status, String apkPath, String errorMessage) {
        this.status = status;
        this.apkPath = apkPath;
        this.errorMessage = errorMessage;
        this.timestamp = System.currentTimeMillis();
    }

    public InstallationStatus getStatus() {
        return status;
    }

    public String getApkPath() {
        return apkPath;
    }

    public String getErrorMessage() {
        return errorMessage;
    }

    public long getTimestamp() {
        return timestamp;
    }

    @Override
    public String toString() {
        return "InstallationProgressEvent{" +
                "status=" + status +
                ", apkPath='" + apkPath + '\'' +
                ", errorMessage='" + errorMessage + '\'' +
                ", timestamp=" + timestamp +
                '}';
    }
} 