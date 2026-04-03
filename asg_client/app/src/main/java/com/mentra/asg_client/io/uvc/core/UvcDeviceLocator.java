package com.mentra.asg_client.io.uvc.core;

import java.io.File;

public class UvcDeviceLocator {
  public String findOutputDevicePath() {
    for (int i = 0; i < 10; i++) {
      String candidate = "/dev/video" + i;
      if (new File(candidate).exists()) {
        return candidate;
      }
    }
    return null;
  }
}
