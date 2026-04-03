package com.mentra.asg_client.io.uvc.core;

import com.mentra.asg_client.io.uvc.model.UvcConfig;

import java.nio.charset.StandardCharsets;

public class SyntheticUvcFrameProducer implements UvcFrameProducer {
  private UvcConfig activeConfig = UvcConfig.defaults();

  @Override
  public void open(UvcConfig config) {
    activeConfig = config == null ? UvcConfig.defaults() : config;
  }

  @Override
  public byte[] nextFrame(long frameIndex, long timestampNs) {
    String payload = "frame_index=" + frameIndex
        + ";ts_ns=" + timestampNs
        + ";uptime_ms=" + System.currentTimeMillis()
        + ";size=" + activeConfig.getWidth() + "x" + activeConfig.getHeight()
        + ";producer=synthetic";
    return payload.getBytes(StandardCharsets.UTF_8);
  }

  @Override
  public void close() {
    activeConfig = UvcConfig.defaults();
  }

  @Override
  public String getName() {
    return "SyntheticUvcFrameProducer";
  }
}
