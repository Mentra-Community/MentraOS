package com.mentra.asg_client.io.bes.events;

/**
 * EventBus event for BES firmware OTA progress tracking
 * Mirrors the pattern used in DownloadProgressEvent and InstallationProgressEvent
 */
public class BesOtaProgressEvent {
    
    public enum OtaStatus {
        STARTED,
        PROGRESS,
        FINISHED,
        FAILED
    }
    
    private OtaStatus status;
    private int progress; // 0-100
    private long bytesSent;
    private long totalBytes;
    private String errorMessage;
    private String currentStep; // e.g., "Verifying", "Sending data", "Applying"
    private String otaSessionId;
    
    public BesOtaProgressEvent(OtaStatus status) {
        this.status = status;
        this.progress = 0;
        this.bytesSent = 0;
        this.totalBytes = 0;
        this.errorMessage = null;
        this.currentStep = "";
        this.otaSessionId = null;
    }
    
    public BesOtaProgressEvent(OtaStatus status, int progress, long bytesSent, long totalBytes) {
        this.status = status;
        this.progress = progress;
        this.bytesSent = bytesSent;
        this.totalBytes = totalBytes;
        this.errorMessage = null;
        this.currentStep = "";
        this.otaSessionId = null;
    }
    
    public BesOtaProgressEvent(OtaStatus status, String errorMessage) {
        this.status = status;
        this.progress = 0;
        this.bytesSent = 0;
        this.totalBytes = 0;
        this.errorMessage = errorMessage;
        this.currentStep = "";
        this.otaSessionId = null;
    }
    
    public BesOtaProgressEvent(OtaStatus status, int progress, long bytesSent, long totalBytes, String currentStep) {
        this.status = status;
        this.progress = progress;
        this.bytesSent = bytesSent;
        this.totalBytes = totalBytes;
        this.errorMessage = null;
        this.currentStep = currentStep;
        this.otaSessionId = null;
    }
    
    // Static factory methods
    public static BesOtaProgressEvent createStarted(long totalBytes) {
        return new BesOtaProgressEvent(OtaStatus.STARTED, 0, 0, totalBytes);
    }
    
    public static BesOtaProgressEvent createProgress(int progress, long bytesSent, long totalBytes, String step) {
        return new BesOtaProgressEvent(OtaStatus.PROGRESS, progress, bytesSent, totalBytes, step);
    }
    
    public static BesOtaProgressEvent createFinished(String otaSessionId) {
        BesOtaProgressEvent event = new BesOtaProgressEvent(OtaStatus.FINISHED);
        event.otaSessionId = otaSessionId;
        return event;
    }
    
    public static BesOtaProgressEvent createFailed(String otaSessionId, String errorMessage) {
        BesOtaProgressEvent event = new BesOtaProgressEvent(OtaStatus.FAILED, errorMessage);
        event.otaSessionId = otaSessionId;
        return event;
    }
    
    // Getters
    public OtaStatus getStatus() {
        return status;
    }
    
    public int getProgress() {
        return progress;
    }
    
    public long getBytesSent() {
        return bytesSent;
    }
    
    public long getTotalBytes() {
        return totalBytes;
    }
    
    public String getErrorMessage() {
        return errorMessage;
    }
    
    public String getCurrentStep() {
        return currentStep;
    }

    /** OTA session that owns this terminal event, or {@code null} for nonterminal progress. */
    public String getOtaSessionId() {
        return otaSessionId;
    }
    
    @Override
    public String toString() {
        return "BesOtaProgressEvent{" +
                "status=" + status +
                ", progress=" + progress +
                ", bytesSent=" + bytesSent +
                ", totalBytes=" + totalBytes +
                ", currentStep='" + currentStep + '\'' +
                ", otaSessionId='" + otaSessionId + '\'' +
                ", errorMessage='" + errorMessage + '\'' +
                '}';
    }
}
