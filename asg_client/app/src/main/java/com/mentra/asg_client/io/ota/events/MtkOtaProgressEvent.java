package com.mentra.asg_client.io.ota.events;

/**
 * EventBus event for MTK firmware OTA progress tracking
 * Receives updates from system broadcasts (com.xy.otaupdateresult)
 */
public class MtkOtaProgressEvent {
    
    public enum OtaStatus {
        STARTED,
        WRITE_PROGRESS,  // Writing firmware to storage
        UPDATE_PROGRESS, // Installing/flashing firmware
        SUCCESS,
        ERROR
    }
    
    private OtaStatus status;
    private String message;
    private String commandType; // Original cmd from broadcast: "write_progress", "update_progress", etc.
    private int progress; // Percentage if available
    
    public MtkOtaProgressEvent(OtaStatus status, String message) {
        this.status = status;
        this.message = message;
        this.commandType = "";
        this.progress = -1; // Unknown progress
    }
    
    public MtkOtaProgressEvent(OtaStatus status, String message, String commandType) {
        this.status = status;
        this.message = message;
        this.commandType = commandType;
        this.progress = -1;
    }
    
    public MtkOtaProgressEvent(OtaStatus status, String message, String commandType, int progress) {
        this.status = status;
        this.message = message;
        this.commandType = commandType;
        this.progress = progress;
    }
    
    // Static factory methods
    public static MtkOtaProgressEvent createStarted() {
        return new MtkOtaProgressEvent(OtaStatus.STARTED, "MTK OTA update started");
    }
    
    public static MtkOtaProgressEvent createWriteProgress(String message) {
        return new MtkOtaProgressEvent(OtaStatus.WRITE_PROGRESS, message, "write_progress");
    }
    
    public static MtkOtaProgressEvent createUpdateProgress(String message) {
        return new MtkOtaProgressEvent(OtaStatus.UPDATE_PROGRESS, message, "update_progress");
    }
    
    public static MtkOtaProgressEvent createSuccess(String message) {
        return new MtkOtaProgressEvent(OtaStatus.SUCCESS, message, "success");
    }
    
    public static MtkOtaProgressEvent createError(String message) {
        return new MtkOtaProgressEvent(OtaStatus.ERROR, message, "error");
    }
    
    public static MtkOtaProgressEvent fromBroadcast(String cmd, String msg) {
        if (cmd == null) {
            return createError("Unknown command");
        }
        
        switch (cmd) {
            case "write_progress":
                return createWriteProgress(msg != null ? msg : "Writing firmware...");
            case "update_progress":
                return createUpdateProgress(msg != null ? msg : "Installing firmware...");
            case "success":
                return createSuccess(msg != null ? msg : "MTK OTA completed successfully");
            case "error":
                return createError(msg != null ? msg : "MTK OTA failed");
            default:
                return new MtkOtaProgressEvent(OtaStatus.UPDATE_PROGRESS, msg, cmd);
        }
    }
    
    // Getters
    public OtaStatus getStatus() {
        return status;
    }
    
    public String getMessage() {
        return message;
    }
    
    public String getCommandType() {
        return commandType;
    }
    
    public int getProgress() {
        return progress;
    }
    
    public boolean isInProgress() {
        return status == OtaStatus.WRITE_PROGRESS || status == OtaStatus.UPDATE_PROGRESS;
    }
    
    public boolean isComplete() {
        return status == OtaStatus.SUCCESS || status == OtaStatus.ERROR;
    }
    
    @Override
    public String toString() {
        return "MtkOtaProgressEvent{" +
                "status=" + status +
                ", message='" + message + '\'' +
                ", commandType='" + commandType + '\'' +
                ", progress=" + progress +
                '}';
    }
}

