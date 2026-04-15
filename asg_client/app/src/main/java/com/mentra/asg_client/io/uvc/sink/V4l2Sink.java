package com.mentra.asg_client.io.uvc.sink;

import android.util.Log;

import com.mentra.asg_client.io.uvc.model.UvcConfig;

import java.io.FileOutputStream;
import java.io.IOException;

/**
 * {@link FrameSink} that writes raw frame payloads to a V4L2 device node (or any writable file
 * path) using a simple {@link FileOutputStream}.
 *
 * <p>This is the "Option A" implementation — a plain write to the device path. This approach works
 * when the kernel UVC gadget driver accepts raw writes to the output video node without requiring
 * explicit V4L2 buffer-queue IOCTL sequencing. If the target device returns {@code EINVAL} on
 * write, the JNI / IOCTL path (Option B) will need to be introduced as a replacement.
 *
 * <p>Error contract: any {@link IOException} in {@link #writeFrame} is rethrown after
 * marking the sink as closed so that {@code UvcBridgeManager} can transition to {@code ERROR}.
 */
public class V4l2Sink implements FrameSink {

  private static final String TAG = "V4l2Sink";

  private final String devicePath;
  private FileOutputStream outputStream;
  private boolean opened = false;

  public V4l2Sink(String devicePath) {
    this.devicePath = devicePath;
  }

  @Override
  public void open(UvcConfig config) throws IOException {
    if (opened) {
      logInfo("Already opened, re-opening: " + devicePath);
      closeStream();
    }
    outputStream = new FileOutputStream(devicePath, false);
    opened = true;
    logInfo("Opened V4L2 device: " + devicePath
        + " config=" + config.getWidth() + "x" + config.getHeight()
        + "@" + config.getFps() + "fps");
  }

  @Override
  public void writeFrame(long frameIndex, long timestampNs, byte[] payload) throws IOException {
    if (!opened || outputStream == null) {
      throw new IllegalStateException("V4l2Sink not opened — call open() first");
    }
    try {
      outputStream.write(payload);
      outputStream.flush();
      logDebug("Frame " + frameIndex + " written (" + payload.length + " bytes) to " + devicePath);
    } catch (IOException e) {
      opened = false;
      closeStream();
      logError("Write failed on frame " + frameIndex + " to " + devicePath, e);
      throw e;
    }
  }

  @Override
  public void close() {
    opened = false;
    closeStream();
    logInfo("Closed V4L2 device: " + devicePath);
  }

  @Override
  public String getName() {
    return "V4l2Sink";
  }

  private void closeStream() {
    if (outputStream != null) {
      try {
        outputStream.close();
      } catch (IOException ignored) {
      } finally {
        outputStream = null;
      }
    }
  }

  private void logInfo(String message) {
    try {
      Log.i(TAG, message);
    } catch (Throwable ignored) {
      // android.util.Log is not available in JVM unit tests.
    }
  }

  private void logDebug(String message) {
    try {
      Log.d(TAG, message);
    } catch (Throwable ignored) {
      // android.util.Log is not available in JVM unit tests.
    }
  }

  private void logError(String message, Throwable e) {
    try {
      Log.e(TAG, message, e);
    } catch (Throwable ignored) {
      // android.util.Log is not available in JVM unit tests.
    }
  }
}
