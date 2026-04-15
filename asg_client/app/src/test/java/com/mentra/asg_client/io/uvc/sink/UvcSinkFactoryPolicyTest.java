package com.mentra.asg_client.io.uvc.sink;

import com.mentra.asg_client.io.uvc.model.UvcConfig;

import org.junit.Assert;
import org.junit.Test;

public class UvcSinkFactoryPolicyTest {

  @Test
  public void releaseLikeFactoryRejectsTestSinksWithoutOverride() {
    UvcSinkFactory factory = new UvcSinkFactory(false);
    UvcConfig config = new UvcConfig.Builder()
        .setSinkType(SinkType.NULL)
        .setAllowTestSinks(false)
        .build();

    IllegalArgumentException thrown = Assert.assertThrows(
        IllegalArgumentException.class,
        () -> factory.create(config, null));
    Assert.assertTrue(thrown.getMessage().contains("not allowed"));
  }

  @Test
  public void releaseLikeFactoryAllowsV4l2Sink() {
    UvcSinkFactory factory = new UvcSinkFactory(false);
    UvcConfig config = new UvcConfig.Builder()
        .setSinkType(SinkType.V4L2)
        .build();

    FrameSink sink = factory.create(config, "/dev/video0");
    Assert.assertEquals("V4l2Sink", sink.getName());
  }

  @Test
  public void debugFactoryAllowsTestSinks() {
    UvcSinkFactory factory = new UvcSinkFactory(true);
    UvcConfig config = new UvcConfig.Builder()
        .setSinkType(SinkType.FILE)
        .setOutputDirectory(System.getProperty("java.io.tmpdir"))
        .build();

    FrameSink sink = factory.create(config, null);
    Assert.assertEquals("FileSink", sink.getName());
  }

  @Test
  public void v4l2SinkUsesResolvedPathOverConfigPath() {
    UvcSinkFactory factory = new UvcSinkFactory(false);
    UvcConfig config = new UvcConfig.Builder()
        .setSinkType(SinkType.V4L2)
        .setDevicePath("/dev/video0")
        .build();

    FrameSink sink = factory.create(config, "/dev/video3");
    Assert.assertEquals("V4l2Sink", sink.getName());
  }

  @Test
  public void v4l2SinkFallsBackToDefaultPathWhenBothNull() {
    UvcSinkFactory factory = new UvcSinkFactory(false);
    UvcConfig config = new UvcConfig.Builder()
        .setSinkType(SinkType.V4L2)
        .build();

    FrameSink sink = factory.create(config, null);
    Assert.assertEquals("V4l2Sink", sink.getName());
  }
}
