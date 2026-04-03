package com.mentra.asg_client.io.uvc.core;

import android.util.Log;

import com.mentra.asg_client.io.uvc.model.UvcConfig;
import com.mentra.asg_client.io.uvc.model.UvcState;
import com.mentra.asg_client.io.uvc.sink.FrameSink;
import com.mentra.asg_client.io.uvc.sink.SinkType;
import com.mentra.asg_client.io.uvc.sink.UvcSinkFactory;

import java.nio.charset.StandardCharsets;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

public class UvcBridgeManager {
  private static final String TAG = "UvcBridgeManager";

  private final Object stateLock = new Object();
  private final UvcSinkFactory sinkFactory;
  private final UvcDeviceLocator deviceLocator;

  private volatile UvcState state = UvcState.IDLE;
  private volatile UvcConfig activeConfig = UvcConfig.defaults();
  private volatile FrameSink activeSink;
  private volatile ScheduledExecutorService frameClock;

  private final AtomicLong producedFrames = new AtomicLong(0);
  private final AtomicLong writtenFrames = new AtomicLong(0);
  private final AtomicLong droppedFrames = new AtomicLong(0);

  public UvcBridgeManager() {
    this(new UvcSinkFactory(), new UvcDeviceLocator());
  }

  public UvcBridgeManager(UvcSinkFactory sinkFactory, UvcDeviceLocator deviceLocator) {
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
      activeConfig = config == null ? UvcConfig.defaults() : config;

      try {
        String discoveredPath = activeConfig.getSinkType() == SinkType.V4L2
            ? deviceLocator.findOutputDevicePath()
            : null;
        activeSink = sinkFactory.create(activeConfig, discoveredPath);
        activeSink.open(activeConfig);

        frameClock = Executors.newSingleThreadScheduledExecutor();
        long periodMs = Math.max(1L, 1000L / Math.max(1, activeConfig.getFps()));
        frameClock.scheduleAtFixedRate(this::onFrameClockTick, 0, periodMs, TimeUnit.MILLISECONDS);

        transition(UvcState.STREAMING);
        logInfo("UVC bridge started with sink " + activeSink.getName());
        return true;
      } catch (Exception e) {
        logError("Failed to start UVC bridge", e);
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
        state,
        activeSink != null ? activeSink.getName() : "none");
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
  }

  private void onFrameClockTick() {
    if (state != UvcState.STREAMING) {
      return;
    }

    long frameIndex = producedFrames.incrementAndGet();
    long timestampNs = System.nanoTime();
    byte[] payload = generateSyntheticFrame(frameIndex, timestampNs);

    try {
      if (activeSink == null) {
        throw new IllegalStateException("No active sink");
      }
      activeSink.writeFrame(frameIndex, timestampNs, payload);
      writtenFrames.incrementAndGet();
    } catch (Exception e) {
      droppedFrames.incrementAndGet();
      logError("Failed to write frame " + frameIndex, e);
      transition(UvcState.ERROR);
    }
  }

  private byte[] generateSyntheticFrame(long frameIndex, long timestampNs) {
    String payload = "frame_index=" + frameIndex
        + ";ts_ns=" + timestampNs
        + ";uptime_ms=" + System.currentTimeMillis()
        + ";size=" + activeConfig.getWidth() + "x" + activeConfig.getHeight();
    return payload.getBytes(StandardCharsets.UTF_8);
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

  public static class MetricsSnapshot {
    public final long producedFrames;
    public final long writtenFrames;
    public final long droppedFrames;
    public final UvcState state;
    public final String sinkName;

    public MetricsSnapshot(
        long producedFrames,
        long writtenFrames,
        long droppedFrames,
        UvcState state,
        String sinkName) {
      this.producedFrames = producedFrames;
      this.writtenFrames = writtenFrames;
      this.droppedFrames = droppedFrames;
      this.state = state;
      this.sinkName = sinkName;
    }
  }
}
