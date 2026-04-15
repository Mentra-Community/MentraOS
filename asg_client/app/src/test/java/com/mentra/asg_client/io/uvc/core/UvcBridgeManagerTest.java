package com.mentra.asg_client.io.uvc.core;

import com.mentra.asg_client.io.uvc.model.UvcConfig;
import com.mentra.asg_client.io.uvc.model.UvcState;
import com.mentra.asg_client.io.uvc.sink.FrameSink;
import com.mentra.asg_client.io.uvc.sink.SinkType;
import com.mentra.asg_client.io.uvc.sink.UvcSinkFactory;
import com.mentra.asg_client.io.uvc.sink.V4l2Sink;

import org.junit.Assert;
import org.junit.Test;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;

public class UvcBridgeManagerTest {

  @Test
  public void startWithNullSinkProducesFrames() throws Exception {
    UvcBridgeManager manager = new UvcBridgeManager(new UvcSinkFactory(true), new UvcDeviceLocator());
    UvcConfig config = new UvcConfig.Builder()
        .setSinkType(SinkType.NULL)
        .setFps(30)
        .build();

    boolean started = manager.start(config);
    Assert.assertTrue("Manager should start", started);

    Thread.sleep(250);

    UvcBridgeManager.MetricsSnapshot snapshot = manager.getMetricsSnapshot();
    Assert.assertTrue("Produced frames should be greater than zero", snapshot.producedFrames > 0);
    Assert.assertTrue("Written frames should be greater than zero", snapshot.writtenFrames > 0);
    Assert.assertEquals("Dropped frames should be zero in NullSink path", 0, snapshot.droppedFrames);

    manager.stop();
    Assert.assertEquals(UvcState.IDLE, manager.getState());
  }

  @Test
  public void startStopCyclesDoNotLeaveManagerStuck() throws Exception {
    UvcBridgeManager manager = new UvcBridgeManager(new UvcSinkFactory(true), new UvcDeviceLocator());
    UvcConfig config = new UvcConfig.Builder()
        .setSinkType(SinkType.NULL)
        .setFps(15)
        .build();

    for (int i = 0; i < 20; i++) {
      Assert.assertTrue("Cycle " + i + " should start", manager.start(config));
      Thread.sleep(80);
      manager.stop();
      Assert.assertEquals("Cycle " + i + " should return to IDLE", UvcState.IDLE, manager.getState());
    }
  }

  @Test
  public void managerWithFileSinkWritesArtifacts() throws Exception {
    File tempDir = Files.createTempDirectory("uvc-manager-file-sink").toFile();
    try {
      UvcBridgeManager manager = new UvcBridgeManager(new UvcSinkFactory(true), new UvcDeviceLocator());
      UvcConfig config = new UvcConfig.Builder()
          .setSinkType(SinkType.FILE)
          .setOutputDirectory(tempDir.getAbsolutePath())
          .setFps(20)
          .build();

      Assert.assertTrue("Manager should start with file sink", manager.start(config));
      Thread.sleep(300);
      manager.stop();

      File[] files = tempDir.listFiles();
      Assert.assertNotNull("File sink output directory should be readable", files);
      Assert.assertTrue("Expected file sink to emit at least one frame artifact", files.length > 0);
    } finally {
      deleteRecursively(tempDir);
    }
  }

  @Test
  public void soakStyleRunShowsMonotonicProgress() throws Exception {
    UvcBridgeManager manager = new UvcBridgeManager(new UvcSinkFactory(true), new UvcDeviceLocator());
    UvcConfig config = new UvcConfig.Builder()
        .setSinkType(SinkType.NULL)
        .setFps(25)
        .build();

    Assert.assertTrue("Manager should start", manager.start(config));

    Thread.sleep(500);
    UvcBridgeManager.MetricsSnapshot first = manager.getMetricsSnapshot();
    Thread.sleep(500);
    UvcBridgeManager.MetricsSnapshot second = manager.getMetricsSnapshot();

    Assert.assertEquals(UvcState.STREAMING, first.state);
    Assert.assertEquals(UvcState.STREAMING, second.state);
    Assert.assertTrue("Produced frames should increase over soak interval", second.producedFrames > first.producedFrames);
    Assert.assertTrue("Written frames should increase over soak interval", second.writtenFrames > first.writtenFrames);

    manager.stop();
    Assert.assertEquals(UvcState.IDLE, manager.getState());
  }

  @Test
  public void cameraModeRejectsStartWhenBusy() {
    UvcBridgeManager manager = new BusyCameraTestManager(new UvcSinkFactory(true), new UvcDeviceLocator());
    UvcConfig config = new UvcConfig.Builder()
        .setProducerMode(com.mentra.asg_client.io.uvc.model.UvcProducerMode.CAMERA2)
        .setSinkType(SinkType.NULL)
        .build();

    boolean started = manager.start(config);
    Assert.assertFalse("Manager should reject Camera2 start while busy", started);

    UvcBridgeManager.MetricsSnapshot snapshot = manager.getMetricsSnapshot();
    Assert.assertEquals("camera_busy", snapshot.lastErrorCode);
    Assert.assertEquals(UvcState.IDLE, snapshot.state);
  }

  @Test
  public void previewSnapshotPublishesWhenEnabled() throws Exception {
    UvcBridgeManager manager = new UvcBridgeManager(new UvcSinkFactory(true), new UvcDeviceLocator());
    UvcConfig config = new UvcConfig.Builder()
        .setSinkType(SinkType.NULL)
        .setProducerMode(com.mentra.asg_client.io.uvc.model.UvcProducerMode.SYNTHETIC)
        .setPreviewEnabled(true)
        .setAllowTestSinks(true)
        .build();

    Assert.assertTrue("Manager should start", manager.start(config));
    Thread.sleep(150);
    UvcBridgeManager.PreviewFrameSnapshot preview = manager.getPreviewFrameSnapshot();
    Assert.assertNotNull("Preview snapshot should be available", preview);
    Assert.assertNotNull("Preview bytes should be available", preview.jpegBytes);
    Assert.assertTrue("Preview bytes should not be empty", preview.jpegBytes.length > 0);
    manager.stop();
  }

  @Test
  public void startWithV4l2SinkWritesToTempFile() throws Exception {
    File tmp = Files.createTempFile("uvc-v4l2-manager", ".raw").toFile();
    try {
      UvcSinkFactory factory = new UvcSinkFactory(false) {
        @Override
        public FrameSink create(UvcConfig config, String resolvedDevicePath) {
          return new V4l2Sink(tmp.getAbsolutePath());
        }
      };

      UvcBridgeManager manager = new UvcBridgeManager(factory, new UvcDeviceLocator());
      UvcConfig config = new UvcConfig.Builder()
          .setSinkType(SinkType.V4L2)
          .setDevicePath(tmp.getAbsolutePath())
          .setFps(25)
          .build();

      Assert.assertTrue("Manager should start with V4L2 sink", manager.start(config));
      Thread.sleep(200);
      manager.stop();

      UvcBridgeManager.MetricsSnapshot snapshot = manager.getMetricsSnapshot();
      Assert.assertTrue("writtenFrames should be > 0 with V4L2 sink", snapshot.writtenFrames > 0);
      Assert.assertTrue("Temp file should have content", tmp.length() > 0);
      Assert.assertEquals(UvcState.IDLE, manager.getState());
    } finally {
      tmp.delete();
    }
  }

  @Test
  public void v4l2SinkWriteFailureTransitionsToError() throws Exception {
    UvcSinkFactory factory = new UvcSinkFactory(false) {
      @Override
      public FrameSink create(UvcConfig config, String resolvedDevicePath) {
        return new FailingV4l2Sink();
      }
    };

    UvcBridgeManager manager = new UvcBridgeManager(factory, new UvcDeviceLocator());
    UvcConfig config = new UvcConfig.Builder()
        .setSinkType(SinkType.V4L2)
        .setDevicePath("/dev/video0")
        .setFps(30)
        .build();

    Assert.assertTrue("Manager should start (sink opens fine)", manager.start(config));
    Thread.sleep(150);

    UvcBridgeManager.MetricsSnapshot snapshot = manager.getMetricsSnapshot();
    Assert.assertEquals("State should be ERROR after write failure", UvcState.ERROR, snapshot.state);
    Assert.assertEquals("frame_write_failed", snapshot.lastErrorCode);

    manager.stop();
  }

  @Test
  public void previewGateIsCallerControlledNotDebugFlag() throws Exception {
    UvcSinkFactory productionFactory = new UvcSinkFactory(false) {
      @Override
      public FrameSink create(UvcConfig config, String resolvedDevicePath) {
        try {
          File tmp = Files.createTempFile("uvc-preview-gate", ".raw").toFile();
          tmp.deleteOnExit();
          return new V4l2Sink(tmp.getAbsolutePath());
        } catch (IOException e) {
          throw new RuntimeException(e);
        }
      }
    };

    UvcBridgeManager manager = new UvcBridgeManager(productionFactory, new UvcDeviceLocator());
    UvcConfig config = new UvcConfig.Builder()
        .setSinkType(SinkType.V4L2)
        .setProducerMode(com.mentra.asg_client.io.uvc.model.UvcProducerMode.SYNTHETIC)
        .setPreviewEnabled(true)
        .build();

    Assert.assertTrue("Manager should start", manager.start(config));
    Thread.sleep(150);

    UvcBridgeManager.PreviewFrameSnapshot preview = manager.getPreviewFrameSnapshot();
    Assert.assertNotNull(
        "Preview snapshot should be non-null when previewEnabled=true (DEBUG gate removed)",
        preview);
    Assert.assertTrue("Preview bytes should not be empty", preview.jpegBytes.length > 0);

    manager.stop();
  }

  private void deleteRecursively(File file) {
    if (file == null || !file.exists()) {
      return;
    }
    if (file.isDirectory()) {
      File[] children = file.listFiles();
      if (children != null) {
        for (File child : children) {
          deleteRecursively(child);
        }
      }
    }
    file.delete();
  }

  private static class BusyCameraTestManager extends UvcBridgeManager {
    BusyCameraTestManager(UvcSinkFactory sinkFactory, UvcDeviceLocator deviceLocator) {
      super(sinkFactory, deviceLocator);
    }

    @Override
    protected boolean isCameraBusy() {
      return true;
    }
  }

  private static class FailingV4l2Sink implements FrameSink {
    @Override
    public void open(UvcConfig config) {
      // opens fine
    }

    @Override
    public void writeFrame(long frameIndex, long timestampNs, byte[] payload) throws IOException {
      throw new IOException("Simulated V4L2 write failure (EINVAL)");
    }

    @Override
    public void close() {
    }

    @Override
    public String getName() {
      return "FailingV4l2Sink";
    }
  }
}
