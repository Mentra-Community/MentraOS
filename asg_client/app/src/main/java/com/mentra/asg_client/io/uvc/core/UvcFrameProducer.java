package com.mentra.asg_client.io.uvc.core;

import com.mentra.asg_client.io.uvc.model.UvcConfig;

public interface UvcFrameProducer {
  void open(UvcConfig config) throws Exception;

  byte[] nextFrame(long frameIndex, long timestampNs) throws Exception;

  void close();

  String getName();
}
