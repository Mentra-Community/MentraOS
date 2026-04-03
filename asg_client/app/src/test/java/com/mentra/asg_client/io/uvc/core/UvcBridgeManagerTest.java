package com.mentra.asg_client.io.uvc.core;

import com.mentra.asg_client.io.uvc.model.UvcConfig;
import com.mentra.asg_client.io.uvc.model.UvcState;
import com.mentra.asg_client.io.uvc.sink.SinkType;
import com.mentra.asg_client.io.uvc.sink.UvcSinkFactory;

import org.junit.Assert;
import org.junit.Test;

import java.io.File;
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
}
