package com.mentra.asg_client.reporting.domains;

import android.content.Context;

import com.mentra.asg_client.reporting.core.ReportData;
import com.mentra.asg_client.reporting.core.ReportLevel;
import com.mentra.asg_client.reporting.core.ReportManager;

/**
 * Bluetooth-specific reporting methods
 * Follows Single Responsibility Principle - only handles Bluetooth reporting
 */
public class BluetoothReporting {
    
    private static final String TAG = "BluetoothReporting";
    
    /**
     * Report Bluetooth connection failure
     */
    public static void reportConnectionFailure(Context context, String deviceType, String deviceAddress, String reason, Throwable exception) {
        ReportManager.getInstance(context).report(
            new ReportData.Builder()
                .message("Bluetooth connection failed: " + reason)
                .level(ReportLevel.ERROR)
                .category("bluetooth.connection")
                .operation("connect")
                .tag("device_type", deviceType)
                .tag("device_address", deviceAddress)
                .tag("reason", reason)
                .exception(exception)
        );
    }
    
    /**
     * Report GATT server failure
     */
    public static void reportGattServerFailure(Context context, String operation, String deviceAddress, int errorCode, Throwable exception) {
        ReportManager.getInstance(context).report(
            new ReportData.Builder()
                .message("GATT server failure: " + operation)
                .level(ReportLevel.ERROR)
                .category("bluetooth.gatt")
                .operation(operation)
                .tag("device_address", deviceAddress)
                .tag("error_code", errorCode)
                .exception(exception)
        );
    }
    
    /**
     * Report advertising failure
     */
    public static void reportAdvertisingFailure(Context context, int errorCode, String deviceName) {
        ReportManager.getInstance(context).report(
            new ReportData.Builder()
                .message("Bluetooth advertising failed")
                .level(ReportLevel.ERROR)
                .category("bluetooth.advertising")
                .operation("start_advertising")
                .tag("error_code", errorCode)
                .tag("device_name", deviceName)
        );
    }
    
    /**
     * Report data transmission failure
     */
    public static void reportDataTransmissionFailure(Context context, String deviceType, String deviceAddress, int dataSize, String reason, Throwable exception) {
        ReportManager.getInstance(context).report(
            new ReportData.Builder()
                .message("Data transmission failed: " + reason)
                .level(ReportLevel.ERROR)
                .category("bluetooth.data")
                .operation("transmit_data")
                .tag("device_type", deviceType)
                .tag("device_address", deviceAddress)
                .tag("data_size", dataSize)
                .tag("reason", reason)
                .exception(exception)
        );
    }
    
    /**
     * Report serial communication failure
     */
    public static void reportSerialCommunicationFailure(Context context, String operation, String serialPath, int errorCode, Throwable exception) {
        ReportManager.getInstance(context).report(
            new ReportData.Builder()
                .message("Serial communication failed: " + operation)
                .level(ReportLevel.ERROR)
                .category("bluetooth.serial")
                .operation(operation)
                .tag("serial_path", serialPath)
                .tag("error_code", errorCode)
                .exception(exception)
        );
    }
    
    /**
     * Report file transfer failure
     */
    public static void reportFileTransferFailure(Context context, String filePath, String operation, String reason, Throwable exception) {
        ReportManager.getInstance(context).report(
            new ReportData.Builder()
                .message("File transfer failed: " + reason)
                .level(ReportLevel.ERROR)
                .category("bluetooth.file_transfer")
                .operation(operation)
                .tag("file_path", filePath)
                .tag("reason", reason)
                .exception(exception)
        );
    }
    
    /**
     * Report file transfer retry exhaustion
     */
    public static void reportFileTransferRetryExhaustion(Context context, String filePath, int packetIndex, int maxRetries) {
        ReportManager.getInstance(context).report(
            new ReportData.Builder()
                .message("File transfer retry exhaustion")
                .level(ReportLevel.ERROR)
                .category("bluetooth.file_transfer")
                .operation("retry_exhaustion")
                .tag("file_path", filePath)
                .tag("packet_index", packetIndex)
                .tag("max_retries", maxRetries)
        );
    }
    
    /**
     * Report MTU negotiation failure
     */
    public static void reportMtuNegotiationFailure(Context context, String deviceAddress, int requestedMtu, int actualMtu, String reason) {
        ReportManager.getInstance(context).report(
            new ReportData.Builder()
                .message("MTU negotiation failed: " + reason)
                .level(ReportLevel.WARNING)
                .category("bluetooth.mtu")
                .operation("negotiate_mtu")
                .tag("device_address", deviceAddress)
                .tag("requested_mtu", requestedMtu)
                .tag("actual_mtu", actualMtu)
                .tag("reason", reason)
        );
    }
    
    /**
     * Report pairing failure
     */
    public static void reportPairingFailure(Context context, String deviceAddress, int retryCount, String reason) {
        ReportManager.getInstance(context).report(
            new ReportData.Builder()
                .message("Bluetooth pairing failed: " + reason)
                .level(ReportLevel.ERROR)
                .category("bluetooth.pairing")
                .operation("pair_device")
                .tag("device_address", deviceAddress)
                .tag("retry_count", retryCount)
                .tag("reason", reason)
        );
    }
    
    /**
     * Report Bluetooth permission error
     */
    public static void reportPermissionError(Context context, String operation, String permission) {
        ReportManager.getInstance(context).report(
            new ReportData.Builder()
                .message("Bluetooth permission denied: " + permission)
                .level(ReportLevel.ERROR)
                .category("bluetooth.permission")
                .operation(operation)
                .tag("permission", permission)
        );
    }
    
    /**
     * Report connection state inconsistency
     */
    public static void reportConnectionStateInconsistency(Context context, String deviceAddress, String expectedState, String actualState, String operation) {
        ReportManager.getInstance(context).report(
            new ReportData.Builder()
                .message("Connection state inconsistency")
                .level(ReportLevel.WARNING)
                .category("bluetooth.state")
                .operation(operation)
                .tag("device_address", deviceAddress)
                .tag("expected_state", expectedState)
                .tag("actual_state", actualState)
        );
    }
    
    /**
     * Report message parsing error
     */
    public static void reportMessageParsingError(Context context, String deviceType, String messageType, String reason, Throwable exception) {
        ReportManager.getInstance(context).report(
            new ReportData.Builder()
                .message("Message parsing error: " + reason)
                .level(ReportLevel.ERROR)
                .category("bluetooth.parsing")
                .operation("parse_message")
                .tag("device_type", deviceType)
                .tag("message_type", messageType)
                .tag("reason", reason)
                .exception(exception)
        );
    }
    
    /**
     * Report ACK timeout error
     */
    public static void reportAckTimeoutError(Context context, String operation, int packetIndex, long timeoutMs) {
        ReportManager.getInstance(context).report(
            new ReportData.Builder()
                .message("ACK timeout error")
                .level(ReportLevel.ERROR)
                .category("bluetooth.timeout")
                .operation(operation)
                .tag("packet_index", packetIndex)
                .tag("timeout_ms", timeoutMs)
        );
    }
    
    /**
     * Report Bluetooth adapter issue
     */
    public static void reportAdapterIssue(Context context, String issue, String details) {
        ReportManager.getInstance(context).report(
            new ReportData.Builder()
                .message("Bluetooth adapter issue: " + issue)
                .level(ReportLevel.ERROR)
                .category("bluetooth.adapter")
                .operation("adapter_check")
                .tag("issue", issue)
                .tag("details", details)
        );
    }
    
    /**
     * Report device type detection error
     */
    public static void reportDeviceTypeDetectionError(Context context, String detectedType, String expectedType, String reason) {
        ReportManager.getInstance(context).report(
            new ReportData.Builder()
                .message("Device type detection error: " + reason)
                .level(ReportLevel.WARNING)
                .category("bluetooth.device_detection")
                .operation("detect_device_type")
                .tag("detected_type", detectedType)
                .tag("expected_type", expectedType)
                .tag("reason", reason)
        );
    }
    
    /**
     * Report Bluetooth initialization failure
     */
    public static void reportInitializationFailure(Context context, String deviceType, String reason, Throwable exception) {
        ReportManager.getInstance(context).report(
            new ReportData.Builder()
                .message("Bluetooth initialization failed: " + reason)
                .level(ReportLevel.ERROR)
                .category("bluetooth.initialization")
                .operation("initialize")
                .tag("device_type", deviceType)
                .tag("reason", reason)
                .exception(exception)
        );
    }
    
    // -------------------------------------------------------------------------
    // File transfer performance telemetry
    // -------------------------------------------------------------------------

    /**
     * Report completed file transfer performance.
     *
     * <p>Emitted once per transfer (success or failure) with all metrics needed
     * to compare Phase 1 optimized vs legacy mode side-by-side.
     *
     * @param context       Android context
     * @param filePath      Source file path (used as key)
     * @param mode          "OPTIMIZED" or "LEGACY"
     * @param success       Whether the transfer ultimately completed
     * @param fileBytes     Real file size in bytes
     * @param totalPackets  Total packet count
     * @param packSizeBytes Data bytes per packet (MTU-derived)
     * @param durationMs    Wall-clock transfer duration in ms
     * @param bytesPerSec   Effective throughput (fileBytes * 1000 / durationMs)
     * @param retryCount    Full-transfer retry count (0 = first-time success)
     * @param packetRetries Total single-packet resend count across whole transfer
     * @param state0Count   Number of state=0 (buffer full / flow-control) ACKs received
     * @param timeoutCount  Number of ACK watchdog timeouts fired
     * @param uartFailures  Number of UART write failures
     * @param preDelayMs    Pre-transfer JSON guard sleep actually used
     */
    public static void reportFileTransferComplete(
            Context context,
            String filePath,
            String mode,
            boolean success,
            int fileBytes,
            int totalPackets,
            int packSizeBytes,
            long durationMs,
            long bytesPerSec,
            int retryCount,
            int packetRetries,
            int state0Count,
            int timeoutCount,
            int uartFailures,
            int preDelayMs) {
        ReportLevel level = success ? ReportLevel.INFO : ReportLevel.WARNING;
        ReportManager.getInstance(context).report(
            new ReportData.Builder()
                .message("BLE file transfer " + (success ? "complete" : "failed")
                        + " [" + mode + "] " + durationMs + "ms "
                        + bytesPerSec + " B/s")
                .level(level)
                .category("bluetooth.file_transfer.perf")
                .operation("transfer_complete")
                .tag("mode", mode)
                .tag("success", success)
                .tag("file_bytes", fileBytes)
                .tag("total_packets", totalPackets)
                .tag("pack_size_bytes", packSizeBytes)
                .tag("duration_ms", durationMs)
                .tag("bytes_per_sec", bytesPerSec)
                .tag("retry_count", retryCount)
                .tag("packet_retries", packetRetries)
                .tag("state0_count", state0Count)
                .tag("timeout_count", timeoutCount)
                .tag("uart_failures", uartFailures)
                .tag("pre_delay_ms", preDelayMs)
                .tag("file_path", filePath)
        );
    }

    /**
     * Report Bluetooth shutdown issue
     */
    public static void reportShutdownIssue(Context context, String deviceType, String issue, Throwable exception) {
        ReportManager.getInstance(context).report(
            new ReportData.Builder()
                .message("Bluetooth shutdown issue: " + issue)
                .level(ReportLevel.WARNING)
                .category("bluetooth.shutdown")
                .operation("shutdown")
                .tag("device_type", deviceType)
                .tag("issue", issue)
                .exception(exception)
        );
    }
    
    /**
     * Report successful Bluetooth operation
     */
    public static void reportOperation(Context context, String operation, String deviceAddress, boolean success) {
        ReportLevel level = success ? ReportLevel.INFO : ReportLevel.ERROR;
        
        ReportManager.getInstance(context).report(
            new ReportData.Builder()
                .message(operation + " - " + (success ? "SUCCESS" : "FAILED"))
                .level(level)
                .category("bluetooth")
                .operation(operation)
                .tag("operation", operation)
                .tag("device_address", deviceAddress)
                .tag("success", success)
        );
    }
} 