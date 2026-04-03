package com.mentra.asg_client.io.uvc.sink;

import java.util.Locale;

public enum SinkType {
  NULL,
  FILE,
  V4L2;

  public static SinkType fromValue(String raw) {
    if (raw == null) {
      return NULL;
    }

    try {
      return SinkType.valueOf(raw.trim().toUpperCase(Locale.US));
    } catch (IllegalArgumentException ignored) {
      return NULL;
    }
  }
}
