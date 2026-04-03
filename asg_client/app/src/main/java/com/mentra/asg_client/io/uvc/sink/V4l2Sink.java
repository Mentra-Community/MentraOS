package com.mentra.asg_client.io.uvc.sink;

import android.util.Log;

import com.mentra.asg_client.io.uvc.model.UvcConfig;

public class V4l2Sink implements FrameSink {
  private static final String TAG = "V4l2Sink";

  private final String devicePath;
  private boolean opened = false;

  public V4l2Sink(String devicePath) {
    this.devicePath = devicePath;
  }

  @Override
  public void open(UvcConfig config) {
    opened = true;
    Log.i(TAG, "Phase 1 stub opened for device path: " + devicePath);
  }

  @Override
  public void writeFrame(long frameIndex, long timestampNs, byte[] payload) {
    if (!opened) {
      throw new IllegalStateException("V4l2Sink not opened");
    }
    // Phase 1 stub: actual native V4L2 writes are introduced in Phase 3.
  }

  @Override
  public void close() {
    opened = false;
  }

  @Override
  public String getName() {
    return "V4l2Sink";
  }
}
