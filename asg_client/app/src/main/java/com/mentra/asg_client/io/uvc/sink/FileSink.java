package com.mentra.asg_client.io.uvc.sink;

import com.mentra.asg_client.io.uvc.model.UvcConfig;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;

public class FileSink implements FrameSink {
  private final String configuredOutputDirectory;
  private File outputDirectory;

  public FileSink(String configuredOutputDirectory) {
    this.configuredOutputDirectory = configuredOutputDirectory;
  }

  @Override
  public void open(UvcConfig config) throws IOException {
    String requestedDir = configuredOutputDirectory != null
        ? configuredOutputDirectory
        : config.getOutputDirectory();

    if (requestedDir == null || requestedDir.trim().isEmpty()) {
      throw new IOException("FileSink requires an output directory");
    }

    outputDirectory = new File(requestedDir);
    if (!outputDirectory.exists() && !outputDirectory.mkdirs()) {
      throw new IOException("Unable to create output directory: " + requestedDir);
    }
  }

  @Override
  public void writeFrame(long frameIndex, long timestampNs, byte[] payload) throws IOException {
    if (outputDirectory == null) {
      throw new IOException("FileSink not opened");
    }

    String fileName = String.format("frame_%06d_%d.bin", frameIndex, timestampNs);
    File target = new File(outputDirectory, fileName);
    try (FileOutputStream fos = new FileOutputStream(target)) {
      fos.write(payload);
      fos.flush();
    }
  }

  @Override
  public void close() {
    // No-op.
  }

  @Override
  public String getName() {
    return "FileSink";
  }
}
