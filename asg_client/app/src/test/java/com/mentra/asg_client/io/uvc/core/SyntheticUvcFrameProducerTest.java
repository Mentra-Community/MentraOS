package com.mentra.asg_client.io.uvc.core;

import com.mentra.asg_client.io.uvc.model.UvcConfig;

import org.junit.Assert;
import org.junit.Test;

import java.nio.charset.StandardCharsets;

public class SyntheticUvcFrameProducerTest {

  @Test
  public void nextFrameIncludesExpectedMarkers() throws Exception {
    SyntheticUvcFrameProducer producer = new SyntheticUvcFrameProducer();
    UvcConfig config = new UvcConfig.Builder()
        .setWidth(640)
        .setHeight(480)
        .build();
    producer.open(config);

    byte[] payload = producer.nextFrame(7L, 12345L);
    String text = new String(payload, StandardCharsets.UTF_8);

    Assert.assertTrue(text.contains("frame_index=7"));
    Assert.assertTrue(text.contains("ts_ns=12345"));
    Assert.assertTrue(text.contains("size=640x480"));
    Assert.assertTrue(text.contains("producer=synthetic"));
  }
}
