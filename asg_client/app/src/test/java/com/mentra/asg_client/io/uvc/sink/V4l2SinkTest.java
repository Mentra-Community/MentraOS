package com.mentra.asg_client.io.uvc.sink;

import com.mentra.asg_client.io.uvc.model.UvcConfig;

import org.junit.Assert;
import org.junit.Test;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;

public class V4l2SinkTest {

  @Test
  public void opensAndWritesToDevicePath() throws Exception {
    File tmp = Files.createTempFile("v4l2sink-test", ".raw").toFile();
    try {
      V4l2Sink sink = new V4l2Sink(tmp.getAbsolutePath());
      sink.open(defaultConfig());
      byte[] payload = "hello-uvc".getBytes();
      sink.writeFrame(1, 1000L, payload);
      sink.close();

      Assert.assertEquals("File length should equal payload size", payload.length, tmp.length());
    } finally {
      tmp.delete();
    }
  }

  @Test
  public void writeFramePayloadMatchesInput() throws Exception {
    File tmp = Files.createTempFile("v4l2sink-payload", ".raw").toFile();
    try {
      V4l2Sink sink = new V4l2Sink(tmp.getAbsolutePath());
      sink.open(defaultConfig());
      byte[] payload = new byte[]{0x42, 0x00, (byte) 0xFF, 0x01, 0x1A};
      sink.writeFrame(1, 0L, payload);
      sink.close();

      byte[] written = Files.readAllBytes(tmp.toPath());
      Assert.assertArrayEquals("Written bytes must match input payload exactly", payload, written);
    } finally {
      tmp.delete();
    }
  }

  @Test
  public void writeBeforeOpenThrowsIllegalState() throws Exception {
    V4l2Sink sink = new V4l2Sink("/dev/nonexistent-device");
    try {
      sink.writeFrame(1, 0L, new byte[]{0x01});
      Assert.fail("Expected IllegalStateException when writing before open");
    } catch (IllegalStateException e) {
      Assert.assertTrue(e.getMessage().contains("not opened"));
    }
  }

  @Test
  public void closeOnUnopenedSinkIsHarmless() {
    V4l2Sink sink = new V4l2Sink("/dev/nonexistent-device");
    sink.close();
  }

  @Test
  public void secondOpenAfterCloseReopensCleanly() throws Exception {
    File tmp = Files.createTempFile("v4l2sink-reopen", ".raw").toFile();
    try {
      V4l2Sink sink = new V4l2Sink(tmp.getAbsolutePath());

      sink.open(defaultConfig());
      sink.writeFrame(1, 0L, "first-write".getBytes());
      sink.close();

      sink.open(defaultConfig());
      byte[] secondPayload = "second-write".getBytes();
      sink.writeFrame(2, 0L, secondPayload);
      sink.close();

      byte[] written = Files.readAllBytes(tmp.toPath());
      Assert.assertArrayEquals(
          "After re-open, file should only contain the second write",
          secondPayload,
          written);
    } finally {
      tmp.delete();
    }
  }

  @Test
  public void writeToNonWritablePathThrowsIoExceptionAndMarksClosed() throws Exception {
    V4l2Sink sink = new V4l2Sink("/dev/nonexistent-path-xyz");
    try {
      sink.open(defaultConfig());
      Assert.fail("Expected IOException opening non-existent path");
    } catch (IOException e) {
      // expected — sink should not have set opened=true
      // verify by calling writeFrame and expecting IllegalState (not a different IOException)
      try {
        sink.writeFrame(1, 0L, new byte[]{0x00});
        Assert.fail("Expected IllegalStateException after failed open");
      } catch (IllegalStateException ise) {
        Assert.assertTrue(ise.getMessage().contains("not opened"));
      }
    }
  }

  private static UvcConfig defaultConfig() {
    return new UvcConfig.Builder()
        .setWidth(1280)
        .setHeight(720)
        .setFps(30)
        .build();
  }
}
