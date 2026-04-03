package com.mentra.asg_client.io.uvc.sink;

import com.mentra.asg_client.io.uvc.model.UvcConfig;

import org.junit.Assert;
import org.junit.Test;

import java.io.File;
import java.nio.file.Files;

public class FileSinkTest {

  @Test
  public void writesFramesInOrderWithNonEmptyPayloads() throws Exception {
    File tempDir = Files.createTempDirectory("uvc-file-sink-test").toFile();
    try {
      FileSink sink = new FileSink(tempDir.getAbsolutePath());
      UvcConfig config = new UvcConfig.Builder()
          .setSinkType(SinkType.FILE)
          .setOutputDirectory(tempDir.getAbsolutePath())
          .setAllowTestSinks(true)
          .build();

      sink.open(config);
      sink.writeFrame(1, 1000L, "frame-1".getBytes());
      sink.writeFrame(2, 2000L, "frame-2".getBytes());
      sink.close();

      File[] files = tempDir.listFiles();
      Assert.assertNotNull(files);
      Assert.assertEquals("Expected exactly two files", 2, files.length);

      boolean foundFrameOne = false;
      boolean foundFrameTwo = false;
      for (File file : files) {
        Assert.assertTrue("File payload should not be empty", file.length() > 0);
        if (file.getName().contains("frame_000001")) {
          foundFrameOne = true;
        }
        if (file.getName().contains("frame_000002")) {
          foundFrameTwo = true;
        }
      }

      Assert.assertTrue("Frame one should be present", foundFrameOne);
      Assert.assertTrue("Frame two should be present", foundFrameTwo);
    } finally {
      deleteRecursively(tempDir);
    }
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
