package com.mentra.asg_client.service.core.handlers;

import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

import com.mentra.asg_client.io.uvc.core.UvcBridgeManager;
import com.mentra.asg_client.io.uvc.core.UvcBridgeService;
import com.mentra.asg_client.io.uvc.core.UvcRuntimeRegistry;
import com.mentra.asg_client.io.uvc.model.UvcConfig;
import com.mentra.asg_client.service.communication.interfaces.ICommunicationManager;
import com.mentra.asg_client.service.legacy.interfaces.ICommandHandler;

import org.json.JSONObject;

import java.util.Set;

public class UvcCommandHandler implements ICommandHandler {
  private static final String TAG = "UvcCommandHandler";

  private final Context context;
  private final ICommunicationManager communicationManager;
  private final String packageName;

  public UvcCommandHandler(Context context, ICommunicationManager communicationManager) {
    this.context = context;
    this.communicationManager = communicationManager;
    this.packageName = context.getPackageName();
  }

  @Override
  public Set<String> getSupportedCommandTypes() {
    return Set.of("start_uvc", "stop_uvc", "get_uvc_status");
  }

  @Override
  public boolean handleCommand(String commandType, JSONObject data) {
    try {
      switch (commandType) {
        case "start_uvc":
          return handleStart(data);
        case "stop_uvc":
          return handleStop();
        case "get_uvc_status":
          return handleStatus();
        default:
          Log.w(TAG, "Unsupported command: " + commandType);
          return false;
      }
    } catch (Exception e) {
      Log.e(TAG, "Failed to handle command: " + commandType, e);
      return sendStatus(false, "error", e.getMessage(), null);
    }
  }

  private boolean handleStart(JSONObject data) {
    String sink = data != null ? data.optString("sink", "NULL") : "NULL";
    int fps = data != null ? data.optInt("fps", 30) : 30;
    int width = data != null ? data.optInt("width", 1280) : 1280;
    int height = data != null ? data.optInt("height", 720) : 720;
    String producerMode = data != null ? data.optString("producer_mode", "CAMERA2") : "CAMERA2";
    boolean previewEnabled = data != null && data.optBoolean("preview_enabled", true);
    boolean allowTestSinks = data != null && data.optBoolean("allow_test_sinks", true);
    String outputDir = data != null ? data.optString("output_dir", null) : null;
    String cameraId = data != null ? data.optString("camera_id", null) : null;

    Intent startIntent = new Intent();
    startIntent.setClassName(packageName, UvcBridgeService.class.getName());
    startIntent.setAction(UvcBridgeService.ACTION_START_UVC);
    startIntent.putExtra(UvcConfig.EXTRA_SINK_TYPE, sink);
    startIntent.putExtra(UvcConfig.EXTRA_FPS, fps);
    startIntent.putExtra(UvcConfig.EXTRA_WIDTH, width);
    startIntent.putExtra(UvcConfig.EXTRA_HEIGHT, height);
    startIntent.putExtra(UvcConfig.EXTRA_ALLOW_TEST_SINKS, allowTestSinks);
    startIntent.putExtra(UvcConfig.EXTRA_ENABLE_PREVIEW, previewEnabled);
    startIntent.putExtra(UvcConfig.EXTRA_PRODUCER_MODE, producerMode);
    if (outputDir != null && !outputDir.isEmpty()) {
      startIntent.putExtra(UvcConfig.EXTRA_OUTPUT_DIR, outputDir);
    }
    if (cameraId != null && !cameraId.isEmpty()) {
      startIntent.putExtra(UvcConfig.EXTRA_CAMERA_ID, cameraId);
    }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      context.startForegroundService(startIntent);
    } else {
      context.startService(startIntent);
    }

    UvcBridgeManager manager = UvcRuntimeRegistry.get();
    UvcBridgeManager.MetricsSnapshot snapshot = manager != null ? manager.getMetricsSnapshot() : null;
    return sendStatus(true, "start_requested", null, snapshot);
  }

  private boolean handleStop() {
    Intent stopIntent = new Intent();
    stopIntent.setClassName(packageName, UvcBridgeService.class.getName());
    stopIntent.setAction(UvcBridgeService.ACTION_STOP_UVC);
    context.startService(stopIntent);

    UvcBridgeManager manager = UvcRuntimeRegistry.get();
    UvcBridgeManager.MetricsSnapshot snapshot = manager != null ? manager.getMetricsSnapshot() : null;
    return sendStatus(true, "stop_requested", null, snapshot);
  }

  private boolean handleStatus() {
    UvcBridgeManager manager = UvcRuntimeRegistry.get();
    if (manager == null) {
      return sendStatus(false, "unavailable", "UVC manager not initialized", null);
    }
    return sendStatus(true, "ok", null, manager.getMetricsSnapshot());
  }

  private boolean sendStatus(boolean success, String status, String details, UvcBridgeManager.MetricsSnapshot snapshot) {
    try {
      JSONObject response = new JSONObject();
      response.put("type", "uvc_status");
      response.put("success", success);
      response.put("status", status);
      if (details != null) {
        response.put("details", details);
      }
      if (snapshot != null) {
        JSONObject data = new JSONObject();
        data.put("state", snapshot.state.name());
        data.put("sink", snapshot.sinkName);
        data.put("producer", snapshot.producerName);
        data.put("produced_frames", snapshot.producedFrames);
        data.put("written_frames", snapshot.writtenFrames);
        data.put("dropped_frames", snapshot.droppedFrames);
        data.put("last_frame_ts_ns", snapshot.lastFrameTimestampNs);
        data.put("last_error_code", snapshot.lastErrorCode);
        data.put("last_error_message", snapshot.lastErrorMessage);
        data.put("usb_host_connected", snapshot.usbHostConnected);
        response.put("data", data);
      }
      return communicationManager.sendBluetoothResponse(response);
    } catch (Exception e) {
      Log.e(TAG, "Failed to send UVC status response", e);
      return false;
    }
  }
}
