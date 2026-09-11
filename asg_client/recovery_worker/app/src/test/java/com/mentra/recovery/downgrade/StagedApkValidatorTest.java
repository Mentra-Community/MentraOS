package com.mentra.recovery.downgrade;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

/** JVM tests for the byte-level validation stage (the mis-publish failure modes). */
public class StagedApkValidatorTest {
  // sha256 of "mentra"
  private static final String MENTRA_SHA =
      "78ba8258f4e0836897f9f97e871past".length() > 0
          ? sha("mentra")
          : "";

  private static String sha(String s) {
    try {
      java.security.MessageDigest d = java.security.MessageDigest.getInstance("SHA-256");
      byte[] h = d.digest(s.getBytes(StandardCharsets.UTF_8));
      StringBuilder sb = new StringBuilder();
      for (byte b : h) sb.append(String.format("%02x", b));
      return sb.toString();
    } catch (Exception e) {
      throw new RuntimeException(e);
    }
  }

  private static File tempWith(String content) throws Exception {
    File f = File.createTempFile("staged", ".apk");
    f.deleteOnExit();
    try (FileOutputStream out = new FileOutputStream(f)) {
      out.write(content.getBytes(StandardCharsets.UTF_8));
    }
    return f;
  }

  @Test
  public void missingFileIsInvalid() {
    assertEquals(
        "missing_or_unreadable",
        StagedApkValidator.validateBytes(new File("/nonexistent/path.apk"), MENTRA_SHA));
    assertEquals("missing_or_unreadable", StagedApkValidator.validateBytes(null, MENTRA_SHA));
  }

  @Test
  public void emptyFileIsInvalid() throws Exception {
    assertEquals(
        "missing_or_unreadable", StagedApkValidator.validateBytes(tempWith(""), MENTRA_SHA));
  }

  @Test
  public void shaMismatchIsInvalid() throws Exception {
    assertEquals(
        "sha256_mismatch",
        StagedApkValidator.validateBytes(tempWith("corrupted bytes"), MENTRA_SHA));
  }

  @Test
  public void matchingShaPassesBytesStage() throws Exception {
    assertNull(StagedApkValidator.validateBytes(tempWith("mentra"), MENTRA_SHA));
    // Case-insensitive match.
    assertNull(
        StagedApkValidator.validateBytes(tempWith("mentra"), MENTRA_SHA.toUpperCase()));
  }

  @Test
  public void noExpectedShaSkipsHashCheck() throws Exception {
    assertNull(StagedApkValidator.validateBytes(tempWith("anything"), ""));
    assertNull(StagedApkValidator.validateBytes(tempWith("anything"), null));
  }
}
