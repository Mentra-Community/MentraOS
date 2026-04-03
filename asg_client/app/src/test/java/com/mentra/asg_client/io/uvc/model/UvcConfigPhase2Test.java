package com.mentra.asg_client.io.uvc.model;

import org.junit.Assert;
import org.junit.Test;

public class UvcConfigPhase2Test {

  @Test
  public void builderRetainsPhase2Fields() {
    UvcConfig config = new UvcConfig.Builder()
        .setProducerMode(UvcProducerMode.CAMERA2)
        .setCameraId("0")
        .setImageFormat("jpeg")
        .setPreviewEnabled(true)
        .build();

    Assert.assertEquals(UvcProducerMode.CAMERA2, config.getProducerMode());
    Assert.assertEquals("0", config.getCameraId());
    Assert.assertEquals("jpeg", config.getImageFormat());
    Assert.assertTrue(config.isPreviewEnabled());
  }
}
