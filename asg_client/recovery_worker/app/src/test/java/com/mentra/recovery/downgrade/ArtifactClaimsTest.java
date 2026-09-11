package com.mentra.recovery.downgrade;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import com.mentra.recovery.util.RecoveryConstants;

import org.junit.Test;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/**
 * JVM tests for artifact claim/rollback semantics — the enqueue-failure rollback path depends
 * on unclaim restoring the exact pre-claim state.
 */
public class ArtifactClaimsTest {
  private static File temp(String name, String content) throws Exception {
    File dir = Files.createTempDirectory("claims").toFile();
    dir.deleteOnExit();
    File f = new File(dir, name);
    try (FileOutputStream out = new FileOutputStream(f)) {
      out.write(content.getBytes(StandardCharsets.UTF_8));
    }
    f.deleteOnExit();
    return f;
  }

  @Test
  public void claimRenamesToTxnAndRemovesOriginal() throws Exception {
    File staged = temp("update.apk", "bytes");
    File claimed = ArtifactClaims.claim(staged);
    assertEquals(
        staged.getAbsolutePath() + RecoveryConstants.DOWNGRADE_CLAIMED_APK_SUFFIX,
        claimed.getAbsolutePath());
    assertTrue(claimed.isFile());
    assertFalse(staged.exists());
  }

  @Test
  public void claimOfMissingFileFails() {
    assertNull(ArtifactClaims.claim(new File("/nonexistent/update.apk")));
    assertNull(ArtifactClaims.claim(null));
  }

  @Test
  public void claimReplacesStaleClaimedFile() throws Exception {
    File staged = temp("update.apk", "fresh");
    File stale = new File(staged.getAbsolutePath() + RecoveryConstants.DOWNGRADE_CLAIMED_APK_SUFFIX);
    try (FileOutputStream out = new FileOutputStream(stale)) {
      out.write("stale".getBytes(StandardCharsets.UTF_8));
    }
    File claimed = ArtifactClaims.claim(staged);
    assertTrue(claimed.isFile());
    assertEquals("fresh", new String(Files.readAllBytes(claimed.toPath()), StandardCharsets.UTF_8));
  }

  @Test
  public void unclaimRestoresOriginalName() throws Exception {
    File staged = temp("update.apk", "bytes");
    String originalPath = staged.getAbsolutePath();
    File claimed = ArtifactClaims.claim(staged);
    assertTrue(ArtifactClaims.unclaim(claimed));
    File restored = new File(originalPath);
    assertTrue(restored.isFile());
    assertFalse(claimed.exists());
    assertEquals("bytes", new String(Files.readAllBytes(restored.toPath()), StandardCharsets.UTF_8));
  }

  @Test
  public void unclaimRefusesNonClaimedNamesAndMissingFiles() throws Exception {
    assertFalse(ArtifactClaims.unclaim(new File("/nonexistent/update.apk.txn")));
    assertFalse(ArtifactClaims.unclaim(null));
    File notClaimed = temp("update.apk", "bytes");
    assertFalse(ArtifactClaims.unclaim(notClaimed));
  }
}
