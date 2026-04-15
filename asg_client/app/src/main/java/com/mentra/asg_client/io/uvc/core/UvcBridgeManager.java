package com.mentra.asg_client.io.uvc.core;

import android.content.Context;
import android.hardware.usb.UsbManager;
import android.util.Log;

import com.mentra.asg_client.camera.CameraNeo;
import com.mentra.asg_client.io.uvc.model.UvcConfig;
import com.mentra.asg_client.io.uvc.model.UvcProducerMode;
import com.mentra.asg_client.io.uvc.model.UvcState;
import com.mentra.asg_client.io.uvc.sink.FrameSink;
import com.mentra.asg_client.io.uvc.sink.SinkType;
import com.mentra.asg_client.io.uvc.sink.UvcSinkFactory;

import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

public class UvcBridgeManager {
  private static final String TAG = "UvcBridgeManager";

  private final Context context;
  private final Object stateLock = new Object();
  private final UvcSinkFactory sinkFactory;
  private final UvcDeviceLocator deviceLocator;

  private volatile UvcState state = UvcState.IDLE;
  private volatile UvcConfig activeConfig = UvcConfig.defaults();
  private volatile FrameSink activeSink;
  private volatile UvcFrameProducer activeProducer;
  private volatile ScheduledExecutorService frameClock;

  private final AtomicLong producedFrames = new AtomicLong(0);
  private final AtomicLong writtenFrames = new AtomicLong(0);
  private final AtomicLong droppedFrames = new AtomicLong(0);
  private final AtomicLong lastFrameTimestampNs = new AtomicLong(0);
  private final AtomicReference<PreviewFrameSnapshot> latestPreview = new AtomicReference<>(null);

  private volatile String lastErrorCode = "none";
  private volatile String lastErrorMessage = "";

  public UvcBridgeManager() {
    this(null, new UvcSinkFactory(), new UvcDeviceLocator());
  }

  public UvcBridgeManager(UvcSinkFactory sinkFactory, UvcDeviceLocator deviceLocator) {
    this(null, sinkFactory, deviceLocator);
  }

  public UvcBridgeManager(Context context, UvcSinkFactory sinkFactory, UvcDeviceLocator deviceLocator) {
    this.context = context;
    this.sinkFactory = sinkFactory;
    this.deviceLocator = deviceLocator;
  }

  public boolean start(UvcConfig config) {
    synchronized (stateLock) {
      if (state != UvcState.IDLE && state != UvcState.ERROR) {
        logWarn("Ignoring start while in state: " + state);
        return false;
      }

      transition(UvcState.STARTING);
      producedFrames.set(0);
      writtenFrames.set(0);
      droppedFrames.set(0);
      lastFrameTimestampNs.set(0);
      latestPreview.set(null);
      lastErrorCode = "none";
      lastErrorMessage = "";
      activeConfig = config == null ? UvcConfig.defaults() : config;

      try {
        if (activeConfig.getProducerMode() == UvcProducerMode.CAMERA2) {
          if (isCameraBusy()) {
            lastErrorCode = "camera_busy";
            lastErrorMessage = "Camera is already in use by another flow";
            state = UvcState.IDLE;
            logWarn("Rejecting UVC start: " + lastErrorMessage);
            return false;
          }
          releaseKeptAliveCamera();
        }

        String discoveredPath = activeConfig.getSinkType() == SinkType.V4L2
            ? deviceLocator.findOutputDevicePath()
            : null;
        activeSink = sinkFactory.create(activeConfig, discoveredPath);
        activeSink.open(activeConfig);
        activeProducer = createProducer(activeConfig);
        activeProducer.open(activeConfig);

        frameClock = Executors.newSingleThreadScheduledExecutor();
        long periodMs = Math.max(1L, 1000L / Math.max(1, activeConfig.getFps()));
        frameClock.scheduleAtFixedRate(this::onFrameClockTick, 0, periodMs, TimeUnit.MILLISECONDS);

        transition(UvcState.STREAMING);
        logInfo("UVC bridge started with sink " + activeSink.getName() + " and producer " + activeProducer.getName());
        return true;
      } catch (Exception e) {
        logError("Failed to start UVC bridge", e);
        lastErrorCode = "start_failed";
        lastErrorMessage = e.getMessage() == null ? "start_failed" : e.getMessage();
        transition(UvcState.ERROR);
        stopInternal();
        return false;
      }
    }
  }

  public void stop() {
    synchronized (stateLock) {
      if (state == UvcState.IDLE) {
        return;
      }
      transition(UvcState.STOPPING);
      stopInternal();
      transition(UvcState.IDLE);
      logInfo("UVC bridge stopped");
    }
  }

  public void stopSafely() {
    try {
      stop();
    } catch (Exception e) {
      logError("stopSafely encountered an error", e);
    }
  }

  public UvcState getState() {
    return state;
  }

  public MetricsSnapshot getMetricsSnapshot() {
    return new MetricsSnapshot(
        producedFrames.get(),
        writtenFrames.get(),
        droppedFrames.get(),
        lastFrameTimestampNs.get(),
        state,
        activeSink != null ? activeSink.getName() : "none",
        activeProducer != null ? activeProducer.getName() : "none",
        lastErrorCode,
        lastErrorMessage,
        isUsbHostConnected());
  }

  protected boolean isUsbHostConnected() {
    if (context == null) {
      return false;
    }
    try {
      UsbManager usbManager = (UsbManager) context.getSystemService(Context.USB_SERVICE);
      if (usbManager == null) {
        return false;
      }
      return !usbManager.getDeviceList().isEmpty();
    } catch (Exception e) {
      logWarn("Could not read USB host connection state: " + e.getMessage());
      return false;
    }
  }

  public PreviewFrameSnapshot getPreviewFrameSnapshot() {
    return latestPreview.get();
  }

  public boolean isStreaming() {
    return state == UvcState.STREAMING;
  }

  public boolean isPreviewEnabled() {
    return activeConfig != null && activeConfig.isPreviewEnabled();
  }

  private void stopInternal() {
    if (frameClock != null) {
      frameClock.shutdownNow();
      frameClock = null;
    }

    if (activeSink != null) {
      activeSink.close();
      activeSink = null;
    }

    if (activeProducer != null) {
      activeProducer.close();
      activeProducer = null;
    }
  }

  private void onFrameClockTick() {
    if (state != UvcState.STREAMING) {
      return;
    }

    long frameIndex = producedFrames.incrementAndGet();
    long timestampNs = System.nanoTime();

    try {
      if (activeProducer == null) {
        throw new IllegalStateException("No active producer");
      }
      byte[] payload = activeProducer.nextFrame(frameIndex, timestampNs);
      if (payload == null || payload.length == 0) {
        droppedFrames.incrementAndGet();
        return;
      }
      if (activeSink == null) {
        throw new IllegalStateException("No active sink");
      }
      activeSink.writeFrame(frameIndex, timestampNs, payload);
      writtenFrames.incrementAndGet();
      lastFrameTimestampNs.set(timestampNs);
      if (shouldPublishPreview()) {
        latestPreview.set(new PreviewFrameSnapshot(payload, frameIndex, timestampNs));
      }
    } catch (Exception e) {
      droppedFrames.incrementAndGet();
      logError("Failed to write frame " + frameIndex, e);
      lastErrorCode = "frame_write_failed";
      lastErrorMessage = e.getMessage() == null ? "frame_write_failed" : e.getMessage();
      transition(UvcState.ERROR);
    }
  }

  private void transition(UvcState next) {
    if (!state.canTransitionTo(next)) {
      logWarn("Invalid transition " + state + " -> " + next);
      return;
    }
    state = next;
  }

  private void logInfo(String message) {
    try {
      Log.i(TAG, message);
    } catch (Throwable ignored) {
      // Local JVM unit tests do not mock android.util.Log.
    }
  }

  private void logWarn(String message) {
    try {
      Log.w(TAG, message);
    } catch (Throwable ignored) {
      // Local JVM unit tests do not mock android.util.Log.
    }
  }

  private void logError(String message, Throwable throwable) {
    try {
      Log.e(TAG, message, throwable);
    } catch (Throwable ignored) {
      // Local JVM unit tests do not mock android.util.Log.
    }
  }

  private UvcFrameProducer createProducer(UvcConfig config) {
    if (config != null && config.getProducerMode() == UvcProducerMode.CAMERA2) {
      if (context == null) {
        throw new IllegalStateException("Camera2 producer requires Android context");
      }
      return new Camera2UvcFrameProducer(context.getApplicationContext());
    }
    return new SyntheticUvcFrameProducer();
  }

  private boolean shouldPublishPreview() {
    return activeConfig != null && activeConfig.isPreviewEnabled();
  }

  protected boolean isCameraBusy() {
    return CameraNeo.isCameraInUse();
  }

  protected void releaseKeptAliveCamera() {
    CameraNeo.closeKeptAliveCamera();
  }

  public static class MetricsSnapshot {
    public final long producedFrames;
    public final long writtenFrames;
    public final long droppedFrames;
    public final long lastFrameTimestampNs;
    public final UvcState state;
    public final String sinkName;
    public final String producerName;
    public final String lastErrorCode;
    public final String lastErrorMessage;
    public final boolean usbHostConnected;

    public MetricsSnapshot(
        long producedFrames,
        long writtenFrames,
        long droppedFrames,
        long lastFrameTimestampNs,
        UvcState state,
        String sinkName,
        String producerName,
        String lastErrorCode,
        String lastErrorMessage,
        boolean usbHostConnected) {
      this.producedFrames = producedFrames;
      this.writtenFrames = writtenFrames;
      this.droppedFrames = droppedFrames;
      this.lastFrameTimestampNs = lastFrameTimestampNs;
      this.state = state;
      this.sinkName = sinkName;
      this.producerName = producerName;
      this.lastErrorCode = lastErrorCode;
      this.lastErrorMessage = lastErrorMessage;
      this.usbHostConnected = usbHostConnected;
    }
  }

  public static class PreviewFrameSnapshot {
    public final byte[] jpegBytes;
    public final long frameIndex;
    public final long timestampNs;

    public PreviewFrameSnapshot(byte[] jpegBytes, long frameIndex, long timestampNs) {
      this.jpegBytes = jpegBytes;
      this.frameIndex = frameIndex;
      this.timestampNs = timestampNs;
    }
  }
}
