package com.mentra.asg_client.io.uvc.sink;

import com.mentra.asg_client.BuildConfig;
import com.mentra.asg_client.io.uvc.model.UvcConfig;

public class UvcSinkFactory {
  private final boolean debugBuild;

  public UvcSinkFactory() {
    this(BuildConfig.DEBUG);
  }

  public UvcSinkFactory(boolean debugBuild) {
    this.debugBuild = debugBuild;
  }

  public FrameSink create(UvcConfig config, String resolvedDevicePath) {
    SinkType sinkType = config.getSinkType();
    if (sinkType == SinkType.NULL || sinkType == SinkType.FILE) {
      if (!isTestSinkAllowed(config)) {
        throw new IllegalArgumentException(
            "Test sink " + sinkType + " is not allowed in this runtime");
      }
    }

    switch (sinkType) {
      case FILE:
        return new FileSink(config.getOutputDirectory());
      case V4L2:
        return new V4l2Sink(resolveDevicePath(config, resolvedDevicePath));
      case NULL:
      default:
        return new NullSink();
    }
  }

  private boolean isTestSinkAllowed(UvcConfig config) {
    return debugBuild || config.isAllowTestSinks();
  }

  private String resolveDevicePath(UvcConfig config, String resolvedDevicePath) {
    if (resolvedDevicePath != null && !resolvedDevicePath.trim().isEmpty()) {
      return resolvedDevicePath;
    }
    if (config.getDevicePath() != null && !config.getDevicePath().trim().isEmpty()) {
      return config.getDevicePath();
    }
    return "/dev/video0";
  }
}
