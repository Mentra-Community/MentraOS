package com.mentra.asg_client.io.uvc.sink;

import com.mentra.asg_client.io.uvc.model.UvcConfig;

public interface FrameSink {
  void open(UvcConfig config) throws Exception;

  void writeFrame(long frameIndex, long timestampNs, byte[] payload) throws Exception;

  void close();

  String getName();
}
