package com.mentra.asg_client.io.uvc.sink;

import com.mentra.asg_client.io.uvc.model.UvcConfig;

import java.util.concurrent.atomic.AtomicLong;

public class NullSink implements FrameSink {
  private final AtomicLong acceptedFrames = new AtomicLong(0);

  @Override
  public void open(UvcConfig config) {
    acceptedFrames.set(0);
  }

  @Override
  public void writeFrame(long frameIndex, long timestampNs, byte[] payload) {
    acceptedFrames.incrementAndGet();
  }

  @Override
  public void close() {
    // No-op.
  }

  @Override
  public String getName() {
    return "NullSink";
  }

  public long getAcceptedFrames() {
    return acceptedFrames.get();
  }
}
