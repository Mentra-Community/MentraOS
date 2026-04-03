package com.mentra.asg_client.io.uvc.model;

public enum UvcProducerMode {
  SYNTHETIC,
  CAMERA2;

  public static UvcProducerMode fromValue(String raw) {
    if (raw == null) {
      return SYNTHETIC;
    }

    for (UvcProducerMode mode : values()) {
      if (mode.name().equalsIgnoreCase(raw)) {
        return mode;
      }
    }
    return SYNTHETIC;
  }
}
