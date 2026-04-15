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

  @Test
  public void defaultsAre30fpsAnd720p() {
    UvcConfig config = UvcConfig.defaults();

    Assert.assertEquals("Default fps should be 30", 30, config.getFps());
    Assert.assertEquals("Default width should be 1280", 1280, config.getWidth());
    Assert.assertEquals("Default height should be 720", 720, config.getHeight());
  }
}
