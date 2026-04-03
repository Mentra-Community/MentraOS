package com.mentra.asg_client.io.uvc.model;

import android.content.Intent;

import com.mentra.asg_client.io.uvc.sink.SinkType;

public class UvcConfig {
  public static final String EXTRA_FPS = "uvc_fps";
  public static final String EXTRA_WIDTH = "uvc_width";
  public static final String EXTRA_HEIGHT = "uvc_height";
  public static final String EXTRA_SINK_TYPE = "uvc_sink_type";
  public static final String EXTRA_ALLOW_TEST_SINKS = "uvc_allow_test_sinks";
  public static final String EXTRA_OUTPUT_DIR = "uvc_output_dir";
  public static final String EXTRA_DEVICE_PATH = "uvc_device_path";

  private final int fps;
  private final int width;
  private final int height;
  private final SinkType sinkType;
  private final boolean allowTestSinks;
  private final String outputDirectory;
  private final String devicePath;

  private UvcConfig(Builder builder) {
    this.fps = builder.fps;
    this.width = builder.width;
    this.height = builder.height;
    this.sinkType = builder.sinkType;
    this.allowTestSinks = builder.allowTestSinks;
    this.outputDirectory = builder.outputDirectory;
    this.devicePath = builder.devicePath;
  }

  public static UvcConfig defaults() {
    return new Builder().build();
  }

  public static UvcConfig fromIntent(Intent intent) {
    if (intent == null) {
      return defaults();
    }

    Builder builder = new Builder()
        .setFps(intent.getIntExtra(EXTRA_FPS, 15))
        .setWidth(intent.getIntExtra(EXTRA_WIDTH, 640))
        .setHeight(intent.getIntExtra(EXTRA_HEIGHT, 480))
        .setAllowTestSinks(intent.getBooleanExtra(EXTRA_ALLOW_TEST_SINKS, false))
        .setOutputDirectory(intent.getStringExtra(EXTRA_OUTPUT_DIR))
        .setDevicePath(intent.getStringExtra(EXTRA_DEVICE_PATH));

    String sinkTypeRaw = intent.getStringExtra(EXTRA_SINK_TYPE);
    if (sinkTypeRaw != null && !sinkTypeRaw.isEmpty()) {
      builder.setSinkType(SinkType.fromValue(sinkTypeRaw));
    }

    return builder.build();
  }

  public int getFps() {
    return fps;
  }

  public int getWidth() {
    return width;
  }

  public int getHeight() {
    return height;
  }

  public SinkType getSinkType() {
    return sinkType;
  }

  public boolean isAllowTestSinks() {
    return allowTestSinks;
  }

  public String getOutputDirectory() {
    return outputDirectory;
  }

  public String getDevicePath() {
    return devicePath;
  }

  public static class Builder {
    private int fps = 15;
    private int width = 640;
    private int height = 480;
    private SinkType sinkType = SinkType.NULL;
    private boolean allowTestSinks = false;
    private String outputDirectory = null;
    private String devicePath = null;

    public Builder setFps(int fps) {
      this.fps = Math.max(1, fps);
      return this;
    }

    public Builder setWidth(int width) {
      this.width = Math.max(1, width);
      return this;
    }

    public Builder setHeight(int height) {
      this.height = Math.max(1, height);
      return this;
    }

    public Builder setSinkType(SinkType sinkType) {
      this.sinkType = sinkType == null ? SinkType.NULL : sinkType;
      return this;
    }

    public Builder setAllowTestSinks(boolean allowTestSinks) {
      this.allowTestSinks = allowTestSinks;
      return this;
    }

    public Builder setOutputDirectory(String outputDirectory) {
      this.outputDirectory = outputDirectory;
      return this;
    }

    public Builder setDevicePath(String devicePath) {
      this.devicePath = devicePath;
      return this;
    }

    public UvcConfig build() {
      return new UvcConfig(this);
    }
  }
}
